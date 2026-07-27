// Secret-at-rest encryption (AES-256-GCM). Cloud-connector credentials and exec-cred passwords
// are encrypted before they hit Postgres, with the key held OUTSIDE the DB (env), so a database
// dump can't reveal them. Legacy plaintext is read transparently. Extracted from main.js so it is
// unit-testable in isolation (see test/secrets.test.js).
//
// `CREDENTIAL_ENCRYPTION_KEY` accepts 64-hex, 32-byte base64, or a passphrase (scrypt-derived).
// A null/empty key → encryption is a no-op (stores plaintext) so dev still boots.
const crypto = require('crypto');

const SECRET_ENC_PREFIX = 'enc:v1:';

function normalizeKey(raw) {
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const b = Buffer.from(String(raw), 'base64');
  if (b.length === 32) return b;
  return crypto.scryptSync(String(raw), 'toovix-cred-kek-v1', 32);
}

// Build an encrypt/decrypt toolkit bound to one key. Exported so tests can exercise multiple
// key scenarios; main.js uses the default instance keyed from the environment.
function makeSecrets(rawKey) {
  const KEY = normalizeKey(rawKey);

  function encSecret(plaintext) {
    if (plaintext == null) return plaintext;
    const s = String(plaintext);
    if (!KEY) return s; // no key configured → store as-is (dev)
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
    return SECRET_ENC_PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  function decSecret(stored) {
    if (typeof stored !== 'string' || !stored.startsWith(SECRET_ENC_PREFIX)) return stored; // legacy plaintext
    if (!KEY) throw new Error('CREDENTIAL_ENCRYPTION_KEY not set but an encrypted secret is present');
    const buf = Buffer.from(stored.slice(SECRET_ENC_PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }

  // cloud_connectors.credential is JSONB. Encrypted rows are stored as {"enc":"enc:v1:…"} (still
  // valid JSON); legacy rows are the raw credential object. packCredential produces the value to
  // store; unpackCredential returns the plaintext credential object either way.
  function packCredential(obj) { return JSON.stringify({ enc: encSecret(JSON.stringify(obj || {})) }); }
  function unpackCredential(stored) {
    if (stored && typeof stored === 'object' && typeof stored.enc === 'string') {
      try { return JSON.parse(decSecret(stored.enc)); } catch { return {}; }
    }
    return stored || {}; // legacy plaintext JSONB object
  }

  return { encSecret, decSecret, packCredential, unpackCredential, hasKey: !!KEY, PREFIX: SECRET_ENC_PREFIX };
}

// Default instance, keyed from the environment — what main.js consumes.
const _default = makeSecrets(process.env.CREDENTIAL_ENCRYPTION_KEY);

module.exports = Object.assign({ makeSecrets, normalizeKey, SECRET_ENC_PREFIX }, _default);
