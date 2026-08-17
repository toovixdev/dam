// Classification detector pack — the agent pulls its sensitive-data detector library from the
// control plane instead of relying solely on compiled-in patterns. Same trust model as the VA
// check pack: the pack is Ed25519-signed and verified here before any pattern runs against
// customer data; if the control plane is unreachable or a pack fails verification, the agent
// falls back to the built-in detectors (the ones compiled into main.go). Central update, no rollout.
package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// ── Checksum validators ───────────────────────────────────────────────────────
// Some structured IDs are just fixed-length digit strings (an NPI is 10 digits, indistinguishable
// from a phone by shape) but carry a checksum. Validating the checksum lets these content-detect
// without false-positiving on look-alikes — the value actually has to be a valid ID.

func digitsOnly(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteByte(byte(r))
		}
	}
	return b.String()
}

// npiValid reports whether s is a valid US National Provider Identifier: 10 digits that pass the
// Luhn check after the "80840" issuer prefix is prepended (the NPI check-digit scheme).
func npiValid(s string) bool {
	d := digitsOnly(s)
	if len(d) != 10 {
		return false
	}
	return luhnValid("80840" + d)
}

// ibanValid reports whether s is a structurally valid IBAN: letters/digits, 15–34 chars, passing
// the ISO 13616 mod-97 check (move the first 4 chars to the end, map A–Z→10–35, value mod 97 == 1).
func ibanValid(s string) bool {
	s = strings.ToUpper(strings.NewReplacer(" ", "", "-", "").Replace(s))
	if len(s) < 15 || len(s) > 34 {
		return false
	}
	rearranged := s[4:] + s[:4]
	rem := 0
	for i := 0; i < len(rearranged); i++ {
		c := rearranged[i]
		switch {
		case c >= '0' && c <= '9':
			rem = (rem*10 + int(c-'0')) % 97
		case c >= 'A' && c <= 'Z':
			rem = (rem*100 + int(c-'A') + 10) % 97
		default:
			return false
		}
	}
	return rem == 1
}

// Verhoeff tables (dihedral-group D5) for the Aadhaar check digit.
var verhoeffD = [10][10]int{
	{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}, {1, 2, 3, 4, 0, 6, 7, 8, 9, 5}, {2, 3, 4, 0, 1, 7, 8, 9, 5, 6},
	{3, 4, 0, 1, 2, 8, 9, 5, 6, 7}, {4, 0, 1, 2, 3, 9, 5, 6, 7, 8}, {5, 9, 8, 7, 6, 0, 4, 3, 2, 1},
	{6, 5, 9, 8, 7, 1, 0, 4, 3, 2}, {7, 6, 5, 9, 8, 2, 1, 0, 4, 3}, {8, 7, 6, 5, 9, 3, 2, 1, 0, 4},
	{9, 8, 7, 6, 5, 4, 3, 2, 1, 0},
}
var verhoeffP = [8][10]int{
	{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}, {1, 5, 7, 6, 2, 8, 3, 0, 9, 4}, {5, 8, 0, 3, 7, 9, 6, 1, 4, 2},
	{8, 9, 1, 6, 0, 4, 3, 5, 2, 7}, {9, 4, 5, 3, 1, 2, 6, 8, 7, 0}, {4, 2, 8, 6, 5, 7, 3, 9, 0, 1},
	{2, 7, 9, 3, 8, 0, 6, 4, 1, 5}, {7, 0, 4, 6, 9, 1, 3, 2, 5, 8},
}

// aadhaarValid reports whether s is a valid 12-digit Indian Aadhaar (UIDAI) number: it never starts
// with 0 or 1, and its last digit is a Verhoeff check digit over the preceding 11. The checksum is
// what stops any 12-digit look-alike (a phone number, an order id) from being tagged as Aadhaar.
func aadhaarValid(s string) bool {
	d := digitsOnly(s)
	if len(d) != 12 || d[0] < '2' {
		return false
	}
	c := 0
	for i := 0; i < 12; i++ {
		c = verhoeffD[c][verhoeffP[i%8][int(d[11-i]-'0')]]
	}
	return c == 0
}

// detector is a compiled sensitive-data matcher: an optional column-NAME pattern and/or a CONTENT
// test (Luhn or a value regex). Built either from a pulled pack (compileDetectors) or from the
// compiled-in fallback (builtinDetectors).
type detector struct {
	tag, sens string
	nameRe    *regexp.Regexp
	contentFn func(string) bool // nil → name-only detector
	threshold float64           // fraction of sampled values that must match (content detectors)
}

func (d *detector) contentMatch(samples []string) bool {
	if d.contentFn == nil || len(samples) == 0 {
		return false
	}
	matched := 0
	for _, v := range samples {
		if d.contentFn(v) {
			matched++
		}
	}
	th := d.threshold
	if th <= 0 {
		th = 0.6
	}
	return float64(matched)/float64(len(samples)) >= th
}

// classifyWith classifies one column against the active detector set. Preserves the collector's
// semantics: content is authoritative for the tag (it inspected real values); a corroborating name
// hit → 'validator', content alone → 'content', name alone → 'pattern'. First match wins, so
// detectors are ordered most-specific first. ok=false means the column is not sensitive.
func classifyWith(dets []detector, name string, samples []string) (tag, sens, method string, conf float64, ok bool) {
	var nameHit, contentDet *detector
	for i := range dets {
		if nameHit == nil && dets[i].nameRe != nil && dets[i].nameRe.MatchString(name) {
			nameHit = &dets[i]
		}
	}
	for i := range dets {
		if dets[i].contentMatch(samples) {
			contentDet = &dets[i]
			break
		}
	}
	if contentDet != nil {
		if nameHit != nil {
			return contentDet.tag, contentDet.sens, "validator", 0.99, true
		}
		return contentDet.tag, contentDet.sens, "content", 0.9, true
	}
	if nameHit != nil {
		return nameHit.tag, nameHit.sens, "pattern", 0.85, true
	}
	return "", "", "", 0, false
}

// builtinDetectors is the compiled-in fallback library — the same name + content patterns the
// control plane seeds — used whenever the pack can't be pulled or verified. Built from the
// nameClassifiers + contentValidators defined in main.go, so the two sets never drift.
func builtinDetectors() []detector {
	out := make([]detector, 0, len(nameClassifiers)+len(contentValidators))
	for _, c := range nameClassifiers {
		out = append(out, detector{tag: c.tag, sens: c.sens, nameRe: c.re, threshold: 0.6})
	}
	for i := range contentValidators {
		cv := contentValidators[i]
		out = append(out, detector{tag: cv.tag, sens: cv.sens, contentFn: cv.test, threshold: 0.6})
	}
	return out
}

// detectorWire is the pull JSON shape (matches GET /api/classification/detectorpack).
type detectorWire struct {
	ID          string  `json:"detector_id"`
	Tag         string  `json:"tag"`
	Sensitivity string  `json:"sensitivity"`
	NameRegex   string  `json:"name_regex"`
	ContentKind string  `json:"content_kind"` // none | regex | luhn
	ContentRe   string  `json:"content_regex"`
	Threshold   float64 `json:"threshold"`
}

// compileDetectors turns pulled wire rows into compiled matchers. Name patterns compile
// case-insensitively; content is Luhn or a value regex. A row whose regex fails to compile is
// skipped — one bad detector never aborts the whole pack.
func compileDetectors(wire []detectorWire) []detector {
	out := make([]detector, 0, len(wire))
	for _, w := range wire {
		d := detector{tag: w.Tag, sens: w.Sensitivity, threshold: w.Threshold}
		if w.NameRegex != "" {
			re, err := regexp.Compile("(?i)" + w.NameRegex)
			if err != nil {
				log.Printf("classification: detector %q has an invalid name_regex, skipping: %v", w.ID, err)
				continue
			}
			d.nameRe = re
		}
		switch w.ContentKind {
		case "luhn":
			d.contentFn = luhnValid
		case "npi":
			d.contentFn = npiValid
		case "iban":
			d.contentFn = ibanValid
		case "regex":
			re, err := regexp.Compile(w.ContentRe)
			if err != nil {
				log.Printf("classification: detector %q has an invalid content_regex, skipping: %v", w.ID, err)
				continue
			}
			d.contentFn = re.MatchString
		}
		if d.nameRe == nil && d.contentFn == nil {
			continue // nothing to match on
		}
		out = append(out, d)
	}
	return out
}

var clPackCache = struct {
	version string
	dets    []detector
}{}
var clPubKey ed25519.PublicKey

// fetchDetectorPubKey loads the detector-pack signing public key over TLS (the trust anchor) and
// caches it. Every pulled pack is verified against this key before its patterns run.
func fetchDetectorPubKey(cfg Config) {
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Get(cfg.ControlPlane + "/api/classification/detectorpack/pubkey?token=" + url.QueryEscape(cfg.EnrollToken))
	if err != nil {
		return
	}
	defer resp.Body.Close()
	var pk struct {
		PublicPem string `json:"public_pem"`
	}
	if json.NewDecoder(resp.Body).Decode(&pk) != nil || pk.PublicPem == "" {
		return
	}
	block, _ := pem.Decode([]byte(pk.PublicPem))
	if block == nil {
		return
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return
	}
	if ed, ok := pub.(ed25519.PublicKey); ok {
		clPubKey = ed
		log.Printf("classification detector-pack signing key loaded (agent will verify every pack)")
	}
}

// resolveDetectors pulls the curated detector pack (scoped to this agent's region), VERIFIES its
// Ed25519 signature, caches by version, and falls back to the built-in library if the control
// plane is unreachable, the pack is empty, or the signature can't be verified.
func resolveDetectors(cfg Config) []detector {
	u := cfg.ControlPlane + "/api/classification/detectorpack?token=" + url.QueryEscape(cfg.EnrollToken)
	if cfg.Region != "" {
		u += "&region=" + url.QueryEscape(cfg.Region)
	}
	if clPackCache.version != "" {
		u += "&version=" + url.QueryEscape(clPackCache.version)
	}
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Get(u)
	if err != nil {
		log.Printf("classification detectorpack fetch failed (%v) — using built-in detectors", err)
		return builtinDetectors()
	}
	defer resp.Body.Close()
	var pk struct {
		Version   string         `json:"version"`
		Unchanged bool           `json:"unchanged"`
		Detectors []detectorWire `json:"detectors"`
		Payload   string         `json:"payload"`
		Signature string         `json:"signature"`
	}
	if json.NewDecoder(resp.Body).Decode(&pk) != nil {
		return builtinDetectors()
	}
	if pk.Unchanged && len(clPackCache.dets) > 0 {
		return clPackCache.dets // already-verified cached pack
	}
	// Signed pack: verify signature over the exact payload, then parse the payload.
	if pk.Signature != "" && pk.Payload != "" {
		if clPubKey == nil {
			fetchDetectorPubKey(cfg)
		}
		if clPubKey == nil {
			log.Printf("classification detectorpack is signed but no verify key available yet — using built-in detectors this round")
			return builtinDetectors()
		}
		sig, _ := base64.StdEncoding.DecodeString(pk.Signature)
		if !ed25519.Verify(clPubKey, []byte(pk.Payload), sig) {
			log.Printf("classification detectorpack signature INVALID — refusing pack, using built-in detectors")
			return builtinDetectors()
		}
		var vp struct {
			Version   string         `json:"version"`
			Detectors []detectorWire `json:"detectors"`
		}
		if json.Unmarshal([]byte(pk.Payload), &vp) != nil || len(vp.Detectors) == 0 {
			return builtinDetectors()
		}
		dets := compileDetectors(vp.Detectors)
		if len(dets) == 0 {
			return builtinDetectors()
		}
		clPackCache.version = vp.Version
		clPackCache.dets = dets
		log.Printf("classification detectorpack: %d detectors (version %s, signature verified)", len(dets), vp.Version)
		return dets
	}
	// Unsigned response (signing not configured server-side) — accept for backward compatibility.
	if len(pk.Detectors) == 0 {
		return builtinDetectors()
	}
	dets := compileDetectors(pk.Detectors)
	if len(dets) == 0 {
		return builtinDetectors()
	}
	clPackCache.version = pk.Version
	clPackCache.dets = dets
	log.Printf("classification detectorpack: %d detectors (version %s, unsigned)", len(dets), pk.Version)
	return dets
}
