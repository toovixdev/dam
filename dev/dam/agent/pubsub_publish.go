// TooVix DAM Agent — AgentLite Pub/Sub publisher.
//
// Publishes audit events to a Cloud Pub/Sub topic via the REST API, authenticated
// with an access token from the GCP metadata server (the VM's attached service
// account). Deliberately SDK-free — the agent stays a small static binary, and
// service-account KEYS are disabled by org policy anyway, so metadata/ADC is the
// only auth path. See dev/enterprise-test/terraform/pubsub.tf for the topic + IAM.
//
// Envelope contract (the base64 `data` of each Pub/Sub message) — identical to the
// body the agent POSTs to /api/agents/events, plus routing fields, so the consumer
// can reuse the same server-side ingest logic:
//
//	{
//	  "source":     "agentlite",           // agentlite | cloudsql-sink (consumer normalizes)
//	  "token":      "<enroll token>",       // consumer resolves the tenant from this
//	  "host":       "<db host>",            // find-or-create the db_instance
//	  "engine":     "mysql",
//	  "agent_type": "audit_pull",
//	  "events":     [ { database_name, principal, client_ip, operation, sql_text,
//	                    tags, row_count, source_host, timestamp, ... } ]
//	}
//
// Message attributes duplicate {source, engine} so the consumer (or a Pub/Sub
// filter) can route without decoding the body.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

const metadataBase = "http://metadata.google.internal/computeMetadata/v1/"

// pubsubPublisher publishes messages to one topic using a cached metadata token.
type pubsubPublisher struct {
	project string
	topic   string
	client  *http.Client

	mu       sync.Mutex
	token    string
	tokenExp time.Time
}

// newPubsubPublisher resolves the project (from the metadata server if empty) and
// returns a publisher for the given topic. It does not verify IAM — the first
// publish surfaces any permission error.
func newPubsubPublisher(project, topic string) (*pubsubPublisher, error) {
	if topic == "" {
		return nil, fmt.Errorf("AUDIT_TOPIC is empty")
	}
	client := &http.Client{Timeout: 10 * time.Second}
	if project == "" {
		p, err := metadataGet(client, "project/project-id")
		if err != nil {
			return nil, fmt.Errorf("GCP_PROJECT unset and metadata project lookup failed: %w", err)
		}
		project = p
	}
	return &pubsubPublisher{project: project, topic: topic, client: client}, nil
}

// metadataGet fetches a plain-text value from the GCP metadata server.
func metadataGet(client *http.Client, path string) (string, error) {
	req, _ := http.NewRequest("GET", metadataBase+path, nil)
	req.Header.Set("Metadata-Flavor", "Google")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("metadata %s: %s", path, resp.Status)
	}
	return string(bytes.TrimSpace(b)), nil
}

// accessToken returns a cached OAuth token for the VM's service account, refreshing
// from the metadata server ~60s before it expires.
func (p *pubsubPublisher) accessToken() (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.token != "" && time.Now().Before(p.tokenExp) {
		return p.token, nil
	}
	req, _ := http.NewRequest("GET", metadataBase+"instance/service-accounts/default/token", nil)
	req.Header.Set("Metadata-Flavor", "Google")
	resp, err := p.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("metadata token: %s: %s", resp.Status, bytes.TrimSpace(b))
	}
	var t struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&t); err != nil {
		return "", err
	}
	if t.AccessToken == "" {
		return "", fmt.Errorf("metadata token: empty access_token")
	}
	p.token = t.AccessToken
	p.tokenExp = time.Now().Add(time.Duration(maxInt(t.ExpiresIn-60, 30)) * time.Second)
	return p.token, nil
}

// publish sends one message (the JSON envelope + attributes) to the topic.
func (p *pubsubPublisher) publish(data []byte, attrs map[string]string) error {
	tok, err := p.accessToken()
	if err != nil {
		return fmt.Errorf("token: %w", err)
	}
	msg := map[string]interface{}{"data": base64.StdEncoding.EncodeToString(data)}
	if len(attrs) > 0 {
		msg["attributes"] = attrs
	}
	body, _ := json.Marshal(map[string]interface{}{"messages": []interface{}{msg}})
	url := fmt.Sprintf("https://pubsub.googleapis.com/v1/projects/%s/topics/%s:publish", p.project, p.topic)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("pubsub publish %s: %s", resp.Status, bytes.TrimSpace(b))
	}
	return nil
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
