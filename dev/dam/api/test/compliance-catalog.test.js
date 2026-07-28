// Unit tests for the control-mapped compliance report catalog (compliance-catalog.js).
// Run: node --test  (from dev/dam/api) — no database needed; validates the catalog shape and
// that each report's ClickHouse WHERE builder targets the columns it claims to.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CATALOG, catalogById, SENSITIVE, PERSONAL } = require('../compliance-catalog');

test('catalog is a non-empty array with unique ids', () => {
  assert.ok(Array.isArray(CATALOG) && CATALOG.length >= 8, 'has a meaningful set of reports');
  const ids = CATALOG.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
});

test('every report has the required control-mapping fields', () => {
  for (const c of CATALOG) {
    assert.ok(c.id && c.framework && c.control && c.controlName && c.name && c.description, `${c.id} fully described`);
    assert.ok(['activity', 'exception'].includes(c.kind), `${c.id} kind is activity|exception`);
    assert.equal(typeof c.where, 'function', `${c.id} has a where() builder`);
    const w = c.where();
    assert.equal(typeof w, 'string', `${c.id} where() returns SQL text`);
    assert.ok(w.length > 0, `${c.id} where() is non-empty`);
  }
});

test('catalog spans the core frameworks', () => {
  const fws = new Set(CATALOG.map((c) => c.framework));
  for (const need of ['PCI-DSS', 'SOX', 'GDPR']) assert.ok(fws.has(need), `covers ${need}`);
});

test('report WHERE builders target the columns they claim', () => {
  const by = Object.fromEntries(CATALOG.map((c) => [c.id, c.where()]));
  assert.match(by['ddl-privilege-changes'], /operation IN \('DDL','GRANT'\)/);
  assert.match(by['sensitive-object-access'], /operation = 'SELECT'/);
  assert.match(by['sensitive-object-access'], /hasAny\(tags/);
  assert.match(by['mass-sensitive-read'], /row_count >= 10000/);
  assert.match(by['after-hours-sensitive'], /toHour\(timestamp\)/);
  assert.match(by['sensitive-data-modification'], /INSERT','UPDATE','DELETE/);
  assert.match(by['authentication-activity'], /LOGIN|LOGOUT|auth/);
  assert.match(by['high-risk-activity'], /anomaly_score >= 70/);
  assert.match(by['data-deletion'], /operation = 'DELETE'/);
  assert.match(by['personal-data-access'], /hasAny\(tags/);
});

test('catalogById resolves known ids and rejects unknown', () => {
  assert.equal(catalogById('mass-sensitive-read').id, 'mass-sensitive-read');
  assert.equal(catalogById('does-not-exist'), null);
});

test('sensitivity tag vocabularies include the expected classes', () => {
  for (const t of ['pci', 'pii', 'phi', 'aadhaar']) assert.ok(SENSITIVE.includes(t), `SENSITIVE has ${t}`);
  for (const t of ['pii', 'aadhaar', 'email']) assert.ok(PERSONAL.includes(t), `PERSONAL has ${t}`);
});
