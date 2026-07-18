// TooVix DAM Agent — AgentLite (audit-forward) collector for MongoDB.
//
// MongoDB Community has NO audit log (auditing is an Enterprise/Atlas feature), so unlike the
// MySQL/PostgreSQL collectors there is no file on disk to tail. The equivalent source is the
// built-in DATABASE PROFILER: with profiling on, mongod writes one document per operation into
// the capped collection `<db>.system.profile`. This collector polls that collection over the
// wire and ships each operation as a DAM event.
//
// Consequences of that difference, worth knowing before trusting the trail:
//   - The agent needs a DB LOGIN (unlike MySQL/PG audit-forward, which only read a file). It
//     does NOT need to run on the DB host, so this also covers Atlas and any remote mongod.
//   - system.profile is CAPPED (1 MB default ≈ a few thousand ops). Under heavy load it wraps
//     faster than the poll interval and operations are lost — profiler capture is best-effort,
//     not a guaranteed audit trail. Size it up (see docs) on busy instances.
//   - Profiling costs write throughput on the server. That is the price of capture here.
//
// Detective only: after-the-fact, cannot block.
package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/url"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// mongoDatabase is the database whose profiler we read. DB_NAME wins (it is the DB the login
// authorises against); TARGET_DB is the display name used on events and is the sane fallback.
func mongoDatabase(cfg Config) string {
	return orDefault(cfg.DBName, orDefault(cfg.TargetDB, "admin"))
}

// mongoURI builds the connection string. MONGO_URI wins outright so Atlas SRV strings
// (mongodb+srv://…) and any exotic TLS/replica-set options can be passed through verbatim.
func mongoURI(cfg Config) string {
	if u := env("MONGO_URI", ""); u != "" {
		return u
	}
	host := net.JoinHostPort(orDefault(cfg.TargetHost, "127.0.0.1"), orDefault(cfg.TargetPort, "27017"))
	authSource := env("MONGO_AUTH_SOURCE", "admin")
	if cfg.DBUser == "" {
		return fmt.Sprintf("mongodb://%s/?authSource=%s", host, authSource)
	}
	return fmt.Sprintf("mongodb://%s:%s@%s/?authSource=%s",
		url.QueryEscape(cfg.DBUser), url.QueryEscape(cfg.DBPass), host, authSource)
}

// profileDoc is the subset of a system.profile document we use. Field names/shapes vary a
// little across server versions, so everything is optional and defensively handled.
type profileDoc struct {
	Ts        time.Time `bson:"ts"`
	Op        string    `bson:"op"`
	Ns        string    `bson:"ns"`
	Command   bson.D    `bson:"command"`
	Millis    int64     `bson:"millis"`
	NReturned int64     `bson:"nreturned"`
	NInserted int64     `bson:"ninserted"`
	NModified int64     `bson:"nModified"`
	NDeleted  int64     `bson:"ndeleted"`
	NMatched  int64     `bson:"nMatched"`
	Client    string    `bson:"client"`
	Remote    string    `bson:"remote"`
	AppName   string    `bson:"appName"`
	// Authenticated principal. Modern servers use `users: [{user, db}]`; some paths still
	// carry a flat `user` string. Both are read (see principalOf).
	Users []struct {
		User string `bson:"user"`
		DB   string `bson:"db"`
	} `bson:"users"`
	User string `bson:"user"`
}

func tailMongoProfiler(cfg Config) {
	dbName := mongoDatabase(cfg)
	pollSec := atoiDefault(env("AUDIT_POLL_SEC", "10"), 10)
	mongoIncludeGetMore = env("MONGO_INCLUDE_GETMORE", "false") == "true"

	ctx := context.Background()
	client, err := mongo.Connect(ctx, options.Client().ApplyURI(mongoURI(cfg)).
		SetAppName(mongoAppName). // lets us drop our own polling traffic — see shouldForwardMongo
		SetServerSelectionTimeout(10*time.Second))
	if err != nil {
		log.Fatalf("audit-forward(mongodb): connect: %v", err)
	}
	defer client.Disconnect(ctx)
	if err := client.Ping(ctx, nil); err != nil {
		log.Fatalf("audit-forward(mongodb): ping %s: %v — check TARGET_HOST/PORT, DB_USER/DB_PASSWORD and MONGO_AUTH_SOURCE", cfg.TargetHost, err)
	}

	db := client.Database(dbName)
	ensureMongoProfiling(ctx, db)

	profile := db.Collection("system.profile")

	// Start from the newest existing record so a (re)start doesn't replay the whole capped
	// collection. Same rule as the SQL Server collectors.
	wm := time.Now().UTC()
	var newest profileDoc
	if err := profile.FindOne(ctx, bson.M{}, options.FindOne().SetSort(bson.M{"$natural": -1})).Decode(&newest); err == nil && !newest.Ts.IsZero() {
		wm = newest.Ts
	}

	// system.profile has no _id and `ts` is only millisecond-resolution, so a strict `ts > wm`
	// would silently drop operations sharing the boundary millisecond. We instead re-read from
	// `ts >= wm` and de-duplicate in Go by fingerprint — the same approach the SQL Server
	// XEvents collector uses, for the same reason.
	seen := map[string]bool{}

	log.Printf("audit-forward(mongodb): polling %s.system.profile every %ds (watermark %s)", dbName, pollSec, wm.Format(time.RFC3339))

	for {
		cur, err := profile.Find(ctx, bson.M{"ts": bson.M{"$gte": wm}}, options.Find().SetSort(bson.M{"ts": 1}))
		if err != nil {
			log.Printf("audit-forward(mongodb): read %s.system.profile: %v — is profiling ON (db.setProfilingLevel(2)) and does DB_USER have read on the db? retrying", dbName, err)
			time.Sleep(time.Duration(pollSec) * time.Second)
			continue
		}
		batchMax := wm
		fresh := map[string]bool{}
		for cur.Next(ctx) {
			var d profileDoc
			if err := cur.Decode(&d); err != nil {
				continue
			}
			fp := mongoFingerprint(d)
			fresh[fp] = true
			if d.Ts.After(batchMax) {
				batchMax = d.Ts
			}
			if seen[fp] {
				continue // already forwarded on an earlier poll
			}
			op, coll, stmt := renderMongoOp(d)
			if !shouldForwardMongo(d, coll, dbName) {
				continue
			}
			forwardEventOp(cfg, principalOfMongo(d), clientIPOfMongo(d), stmt, op, int(rowCountOfMongo(d)), false)
		}
		cur.Close(ctx)
		// Only remember fingerprints from the window we just read; anything older can never
		// come back (ts >= wm), so the set stays bounded by one poll's worth of operations.
		seen = fresh
		wm = batchMax
		time.Sleep(time.Duration(pollSec) * time.Second)
	}
}

// mongoAppName tags our own connection so the profiler entries generated BY THIS COLLECTOR are
// identifiable. Reading system.profile is itself a profiled operation, so without a filter the
// agent would observe its own reads, forward them, and generate more — a feedback loop that
// grows every poll. shouldForwardMongo drops them by appName and by namespace.
const mongoAppName = "toovix-dam-agentlite"

// ensureMongoProfiling turns the profiler on if it isn't already. mongod defaults to level 0
// (off), and profiling does NOT survive a restart unless it's in mongod.conf — so we assert it
// at startup and let the operator opt out with MONGO_AUTO_PROFILE=false.
func ensureMongoProfiling(ctx context.Context, db *mongo.Database) {
	var status struct {
		Was    int32 `bson:"was"`
		SlowMs int32 `bson:"slowms"`
	}
	if err := db.RunCommand(ctx, bson.D{{Key: "profile", Value: -1}}).Decode(&status); err != nil {
		log.Printf("audit-forward(mongodb): could not read profiling status: %v (need clusterMonitor) — continuing", err)
	} else if status.Was == 2 {
		log.Printf("audit-forward(mongodb): profiler already at level 2 (slowms=%d)", status.SlowMs)
		return
	}
	if env("MONGO_AUTO_PROFILE", "true") != "true" {
		log.Printf("audit-forward(mongodb): profiler is at level %d and MONGO_AUTO_PROFILE=false — capture will be EMPTY until it is enabled on the server", status.Was)
		return
	}
	// level 2 = profile every operation; slowms 0 so nothing is filtered out by duration.
	err := db.RunCommand(ctx, bson.D{{Key: "profile", Value: 2}, {Key: "slowms", Value: 0}}).Err()
	if err != nil {
		log.Printf("audit-forward(mongodb): could not enable profiling: %v — grant dbAdmin on the target db, or set it server-side (operationProfiling.mode: all). Capture will be EMPTY until then.", err)
		return
	}
	log.Printf("audit-forward(mongodb): profiler enabled (level 2, slowms 0) on %s", db.Name())
}

// shouldForwardMongo is the MongoDB counterpart of shouldForward. Beyond dropping noise it
// carries a correctness duty: it must exclude the collector's OWN reads of system.profile,
// which are themselves profiled and would otherwise feed back into the trail forever.
func shouldForwardMongo(d profileDoc, coll, targetDB string) bool {
	if d.AppName == mongoAppName {
		return false // our own polling traffic
	}
	nsDB, _, _ := strings.Cut(d.Ns, ".")
	switch {
	case strings.HasPrefix(coll, "system."):
		return false // system.profile / system.indexes / system.users — internal, incl. our reads
	case nsDB == "admin", nsDB == "local", nsDB == "config":
		return false // server-internal databases, never customer data
	case targetDB != "" && nsDB != "" && nsDB != targetDB:
		return false // another database on the same instance — not what this agent monitors
	}
	// Health/handshake commands every driver and monitoring tool emits constantly.
	switch strings.ToLower(mongoCommandName(d)) {
	case "ping", "hello", "ismaster", "buildinfo", "serverstatus", "getprofilinglevel",
		"profile", "endsessions", "listcollections", "listindexes", "listdatabases",
		"getlasterror", "connectionstatus", "whatsmyuri":
		return false
	case "getmore":
		// A cursor batch, not a new query. Excluded by default so one logical read is one
		// event (matching the SQL collectors) — but that UNDER-COUNTS row_count badly: a find
		// reports only its first batch (101 docs), so a 10k-document read looks like 101 rows.
		// Set MONGO_INCLUDE_GETMORE=true to emit every batch and get true read volume, at the
		// cost of ~1 extra event per 100 documents.
		return mongoIncludeGetMore
	}
	return true
}

// mongoIncludeGetMore is read once at startup (see MONGO_INCLUDE_GETMORE above).
var mongoIncludeGetMore bool

// isMongoCommandDoc reports whether `command` is a real command document rather than a CRUD
// write spec. A command doc's first field is {<commandName>: <collectionName>}, so its value is
// a STRING; a write spec's first field is {q: {…}} whose value is a document. That shape
// difference is the reliable discriminator — the profiler doesn't flag which one it stored.
func isMongoCommandDoc(d profileDoc) bool {
	if len(d.Command) == 0 {
		return false
	}
	_, isString := d.Command[0].Value.(string)
	return isString
}

// mongoCommandName returns the command's name — by convention the FIRST field of a MongoDB
// command document (its value is the collection). Decoding into bson.D preserves that order.
func mongoCommandName(d profileDoc) string {
	if len(d.Command) > 0 {
		return d.Command[0].Key
	}
	return d.Op
}

// renderMongoOp turns a profiler document into (operation, collection, statement).
//
// The statement is rendered mongosh-style — `db.users.find({"email":"x@y.z"})` — rather than
// as fake SQL. That keeps the trail honest AND makes the shared tagging work unchanged:
// detectTags/classifyTags match on field and collection names in the text, which appear in the
// rendered filter exactly as they do in a WHERE clause.
func renderMongoOp(d profileDoc) (op, coll, stmt string) {
	coll = mongoCollection(d)
	name := mongoCommandName(d)
	op = mongoOperation(d, name)

	// CRUD profiler entries (op = insert|update|remove|query) put the write SPEC in `command`
	// — {q:…, u:…, multi:…} — not a named command document. Reading Command[0].Key there gives
	// "q", which would render as an anonymous db.runCommand({"q":…}) and LOSE the collection
	// name: the one field the trail most needs, and what classifyTags matches on. Take the
	// collection from `ns` and the verb from `op` instead.
	if !isMongoCommandDoc(d) {
		verb := d.Op
		if verb == "remove" {
			verb = "delete" // profiler's legacy name for it; `delete` is what a user would write
		}
		return op, coll, fmt.Sprintf("db.%s.%s(%s)", coll, verb, mongoJSON(stripMongoPlumbing(d.Command)))
	}

	// Each command carries its interesting payload under a different key; render that rather
	// than the whole command doc (which is mostly lsid/$db/$clusterTime plumbing).
	argKey := map[string]string{
		"find": "filter", "aggregate": "pipeline", "count": "query", "distinct": "query",
		"insert": "documents", "update": "updates", "delete": "deletes",
		"findandmodify": "query", "findAndModify": "query",
	}[name]

	verb := name
	if verb == "" {
		verb = d.Op
	}
	if argKey != "" {
		for _, e := range d.Command {
			if e.Key == argKey {
				return op, coll, fmt.Sprintf("db.%s.%s(%s)", coll, verb, mongoJSON(e.Value))
			}
		}
		return op, coll, fmt.Sprintf("db.%s.%s({})", coll, verb) // e.g. find with no filter
	}
	// Unknown/administrative command — render the whole thing minus the plumbing keys.
	return op, coll, fmt.Sprintf("db.runCommand(%s)", mongoJSON(stripMongoPlumbing(d.Command)))
}

// mongoOperation maps a profiler entry onto the DAM operation taxonomy
// (SELECT/INSERT/UPDATE/DELETE/DDL/GRANT/OTHER) that policies and the UI are written against.
func mongoOperation(d profileDoc, name string) string {
	switch d.Op {
	case "query", "getmore":
		return "SELECT"
	case "insert":
		return "INSERT"
	case "update":
		return "UPDATE"
	case "remove":
		return "DELETE"
	}
	// op == "command" (and anything newer): decide from the command name.
	switch strings.ToLower(name) {
	case "find", "aggregate", "count", "distinct", "getmore", "explain":
		return "SELECT"
	case "insert":
		return "INSERT"
	case "update", "findandmodify":
		return "UPDATE"
	case "delete":
		return "DELETE"
	case "create", "createindexes", "drop", "dropindexes", "dropdatabase", "collmod", "renamecollection":
		return "DDL"
	case "createuser", "updateuser", "dropuser", "grantrolestouser", "revokerolesfromuser",
		"createrole", "updaterole", "droprole", "grantprivilegestorole":
		return "GRANT" // privilege change — drives the privileged-access policies
	}
	return "OTHER"
}

// rowCountOfMongo picks the count that matches the operation: rows returned for reads, rows
// affected for writes. Mirrors what the SQL collectors put in row_count.
func rowCountOfMongo(d profileDoc) int64 {
	switch {
	case d.NReturned > 0:
		return d.NReturned
	case d.NInserted > 0:
		return d.NInserted
	case d.NModified > 0:
		return d.NModified
	case d.NDeleted > 0:
		return d.NDeleted
	case d.NMatched > 0:
		return d.NMatched
	}
	return 0
}

func principalOfMongo(d profileDoc) string {
	if len(d.Users) > 0 && d.Users[0].User != "" {
		return d.Users[0].User
	}
	if d.User != "" {
		// Sometimes carried as "user@db" — keep just the user part.
		if u, _, ok := strings.Cut(d.User, "@"); ok {
			return u
		}
		return d.User
	}
	return "unknown"
}

// clientIPOfMongo strips the port off the profiler's client address ("10.0.0.5:54321").
func clientIPOfMongo(d profileDoc) string {
	addr := orDefault(d.Client, d.Remote)
	if addr == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return host
	}
	return addr
}

func mongoCollection(d profileDoc) string {
	if _, coll, ok := strings.Cut(d.Ns, "."); ok {
		return coll
	}
	return d.Ns
}

// mongoFingerprint identifies one profiled operation across re-reads of the overlapping
// window. system.profile documents have no _id, so we hash the fields that together make a
// collision vanishingly unlikely without being expensive.
func mongoFingerprint(d profileDoc) string {
	return fmt.Sprintf("%d|%s|%s|%d|%d|%s",
		d.Ts.UnixNano(), d.Op, d.Ns, d.Millis, d.NReturned, d.Remote)
}

// stripMongoPlumbing removes session/routing keys that appear on every command and carry no
// audit value, so an unrecognised command still renders readably.
func stripMongoPlumbing(cmd bson.D) bson.D {
	drop := map[string]bool{
		"lsid": true, "$db": true, "$clusterTime": true, "$readPreference": true,
		"txnNumber": true, "apiVersion": true, "apiStrict": true, "signature": true,
	}
	out := bson.D{}
	for _, e := range cmd {
		if !drop[e.Key] {
			out = append(out, e)
		}
	}
	return out
}

// mongoJSON renders a BSON value as relaxed extended JSON (the shape a Mongo user recognises).
// Falls back to Go formatting rather than dropping the statement if marshalling fails.
func mongoJSON(v interface{}) string {
	b, err := bson.MarshalExtJSON(bson.M{"v": v}, false, false)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	s := string(b)
	// Unwrap the {"v": …} envelope MarshalExtJSON needs (it requires a document at the top).
	s = strings.TrimSuffix(strings.TrimPrefix(s, `{"v":`), `}`)
	return strings.TrimSpace(s)
}

// ── Classification (schema inference by sampling) ────────────────────
//
// SQL engines expose information_schema, so classification there reads an exact, complete
// column list. MongoDB has no such catalog: a collection's fields exist only inside its
// documents, and two documents in one collection need not share a shape. So the field set is
// INFERRED — sample N documents per collection and union their keys.
//
// The accuracy trade-off is real and worth stating plainly: a sensitive field that appears in
// only a handful of rare documents can be missed entirely. Mongo classification is therefore
// PROBABILISTIC where SQL classification is exact. Raise MONGO_CLASSIFY_SAMPLE to narrow the
// gap at the cost of a heavier scan.

func isMongoEngine(engine string) bool { return engine == "mongodb" || engine == "mongo" }

// flattenKeys walks a document and collects field paths ("addr.postal_code"). Nested objects
// are followed to maxDepth; an array is represented by the union of the keys of the object
// elements it holds, since that is where field names actually live.
func flattenKeys(d bson.D, prefix string, depth, maxDepth int, out map[string]string) {
	for _, e := range d {
		path := e.Key
		if prefix != "" {
			path = prefix + "." + e.Key
		}
		switch v := e.Value.(type) {
		case bson.D:
			if depth < maxDepth {
				flattenKeys(v, path, depth+1, maxDepth, out)
			}
		case bson.A:
			if depth < maxDepth {
				for _, item := range v {
					if sub, ok := item.(bson.D); ok {
						flattenKeys(sub, path, depth+1, maxDepth, out)
					}
				}
			}
		default:
			// Leaf. Record the BSON type name for display; first writer wins, which is fine
			// because the type is informational and the classifier keys off the NAME.
			if _, seen := out[path]; !seen {
				out[path] = bsonTypeName(e.Value)
			}
		}
	}
}

func bsonTypeName(v interface{}) string {
	switch v.(type) {
	case string:
		return "string"
	case int32, int64, float64:
		return "number"
	case bool:
		return "bool"
	case time.Time:
		return "date"
	case nil:
		return "null"
	}
	return "object"
}

// mongoClassifyObjects samples every user collection in the target database and returns the
// same objAgg set the SQL collector produces, so reporting is shared.
func mongoClassifyObjects(cfg Config) (map[string]*objAgg, []string, error) {
	dbName := mongoDatabase(cfg)
	sampleN := int64(atoiDefault(env("MONGO_CLASSIFY_SAMPLE", "100"), 100))
	maxDepth := atoiDefault(env("MONGO_CLASSIFY_DEPTH", "3"), 3)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	client, err := mongo.Connect(ctx, options.Client().ApplyURI(mongoURI(cfg)).
		SetAppName(mongoAppName).SetServerSelectionTimeout(10*time.Second))
	if err != nil {
		return nil, nil, fmt.Errorf("classification(mongodb): connect: %w", err)
	}
	defer client.Disconnect(ctx)

	db := client.Database(dbName)
	colls, err := db.ListCollectionNames(ctx, bson.D{})
	if err != nil {
		return nil, nil, fmt.Errorf("classification(mongodb): list collections (needs read on %s): %w", dbName, err)
	}

	objs := map[string]*objAgg{}
	var objOrder []string
	for _, coll := range colls {
		// system.profile is the agent's own capture source, and the other system.* collections
		// are server internals — neither is user data.
		if strings.HasPrefix(coll, "system.") {
			continue
		}
		cur, err := db.Collection(coll).Aggregate(ctx, []bson.D{{{Key: "$sample", Value: bson.D{{Key: "size", Value: sampleN}}}}})
		if err != nil {
			log.Printf("classification(mongodb): sample %s.%s failed: %v", dbName, coll, err)
			continue
		}
		fields := map[string]string{}
		docs := 0
		for cur.Next(ctx) {
			var d bson.D
			if err := cur.Decode(&d); err != nil {
				continue
			}
			flattenKeys(d, "", 0, maxDepth, fields)
			docs++
		}
		cur.Close(ctx)

		o := &objAgg{dbName: dbName, schema: dbName, table: coll, total: len(fields)}
		for path, typ := range fields {
			if path == "_id" {
				continue
			}
			if tag, sens, ok := classifyCol(path); ok {
				o.cols = append(o.cols, map[string]interface{}{
					"column_name": path, "data_type": typ, "tags": []string{tag},
					"sensitivity": sens, "detection_method": "pattern",
					// Lower than the SQL path's 0.85: the field set is sampled, not authoritative.
					"confidence": 0.75, "is_masked": false,
				})
			}
		}
		key := dbName + "\x00" + dbName + "\x00" + coll
		objs[key] = o
		objOrder = append(objOrder, key)
		log.Printf("classification(mongodb): %s.%s — %d fields from %d sampled docs, %d sensitive",
			dbName, coll, len(fields), docs, len(o.cols))
	}
	return objs, objOrder, nil
}
