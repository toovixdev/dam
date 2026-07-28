// Unit tests for the credential-at-rest encryption (secrets.js).
// Run: node --test  (from dev/dam/api)   — no database or running server needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../secrets');

const HEX = 'a'.repeat(64);                              // 32-byte hex key
const B64 = Buffer.alloc(32, 7).toString('base64');     // 32-byte base64 key

test('encrypt → decrypt round-trip (hex key)', () => {
  const k = S.makeSecrets(HEX);
  const ct = k.encSecret('super-secret-password');
  assert.ok(ct.startsWith(S.SECRET_ENC_PREFIX), 'ciphertext carries the enc:v1: prefix');
  assert.notEqual(ct, 'super-secret-password');
  assert.equal(k.decSecret(ct), 'super-secret-password');
});

test('round-trips with base64 and passphrase keys too', () => {
  for (const key of [B64, 'a-long-human-passphrase-as-the-kek']) {
    const k = S.makeSecrets(key);
    assert.equal(k.decSecret(k.encSecret('hello')), 'hello');
  }
});

test('encryption is non-deterministic (random IV per call)', () => {
  const k = S.makeSecrets(HEX);
  assert.notEqual(k.encSecret('same'), k.encSecret('same'));
});

test('tampering with ciphertext is rejected (GCM auth tag)', () => {
  const k = S.makeSecrets(HEX);
  const ct = k.encSecret('integrity-matters');
  // Flip the last base64 char to corrupt the payload.
  const bad = ct.slice(0, -1) + (ct.endsWith('A') ? 'B' : 'A');
  assert.throws(() => k.decSecret(bad));
});

test('a different key cannot decrypt', () => {
  const a = S.makeSecrets(HEX);
  const b = S.makeSecrets('b'.repeat(64));
  assert.throws(() => b.decSecret(a.encSecret('cross-key')));
});

test('legacy plaintext is read transparently (decSecret passthrough)', () => {
  const k = S.makeSecrets(HEX);
  assert.equal(k.decSecret('plain-legacy-value'), 'plain-legacy-value');
  assert.equal(k.decSecret(null), null);
});

test('no key configured → encryption is a no-op, but ciphertext still errors clearly', () => {
  const k = S.makeSecrets('');
  assert.equal(k.hasKey, false);
  assert.equal(k.encSecret('x'), 'x');                 // stored plaintext in dev
  assert.equal(k.decSecret('x'), 'x');                 // plaintext passthrough
  assert.throws(() => k.decSecret('enc:v1:AAAA'), /not set/); // encrypted value with no key
});

test('packCredential/unpackCredential round-trip an object', () => {
  const k = S.makeSecrets(HEX);
  const cred = { tenancy: 'ocid1.tenancy', user: 'ocid1.user', privateKey: '-----BEGIN...', region: 'us' };
  const stored = JSON.parse(k.packCredential(cred));    // JSONB the DB would hold
  assert.equal(typeof stored.enc, 'string');
  assert.ok(stored.enc.startsWith(S.SECRET_ENC_PREFIX), 'stored as {enc:"enc:v1:…"}');
  assert.deepEqual(k.unpackCredential(stored), cred);
});

test('unpackCredential reads a legacy raw-object credential unchanged', () => {
  const k = S.makeSecrets(HEX);
  const legacy = { accessKeyId: 'AKIA', secretAccessKey: 'shhh' };
  assert.deepEqual(k.unpackCredential(legacy), legacy);
});

test('unpackCredential tolerates junk without throwing', () => {
  const k = S.makeSecrets(HEX);
  assert.deepEqual(k.unpackCredential(null), {});
  assert.deepEqual(k.unpackCredential({ enc: 'enc:v1:not-real' }), {}); // undecryptable → {}
});

test('normalizeKey accepts hex/base64/passphrase and rejects empty', () => {
  assert.equal(S.normalizeKey(''), null);
  assert.equal(S.normalizeKey(HEX).length, 32);
  assert.equal(S.normalizeKey(B64).length, 32);
  assert.equal(S.normalizeKey('some passphrase').length, 32); // scrypt-derived
});
