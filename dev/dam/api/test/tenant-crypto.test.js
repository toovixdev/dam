// Unit tests for the BYOK envelope layer (tenant-crypto.js). Exercises the env-key KEK provider
// end-to-end with a fake Postgres and a keyed secrets instance — no DB, no Vault, no server.
// (Vault-transit / cloud-KMS providers are covered by integration tests once wired.)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../secrets');
const { makeTenantCrypto } = require('../tenant-crypto');

// A keyed platform secrets object (default env instance may be unkeyed under `node --test`).
const platform = S.makeSecrets('a'.repeat(64));
const secrets = {
  makeSecrets: S.makeSecrets,
  encSecret: platform.encSecret, decSecret: platform.decSecret, hasKey: platform.hasKey,
  packCredential: platform.packCredential, unpackCredential: platform.unpackCredential,
};

// Minimal in-memory Postgres just for the queries tenant-crypto issues.
function fakePg() {
  const store = new Map();
  return {
    store,
    async query(sql, params = []) {
      if (/CREATE TABLE/i.test(sql)) return { rows: [] };
      if (/^SELECT \* FROM tenant_encryption/i.test(sql)) {
        const r = store.get(params[0]);
        return { rows: r ? [r] : [] };
      }
      if (/INSERT INTO tenant_encryption/i.test(sql)) {
        const [tenant_id, kek_provider, kek_ref, kek_config, managed_by, wrapped_dek, updated_by] = params;
        store.set(tenant_id, { tenant_id, kek_provider, kek_ref, kek_config: kek_config ? JSON.parse(kek_config) : null, managed_by, wrapped_dek, updated_by });
        return { rows: [] };
      }
      if (/^UPDATE tenant_encryption SET wrapped_dek/i.test(sql)) {
        const row = store.get(params[0]); if (row) row.wrapped_dek = params[1];
        return { rows: [] };
      }
      throw new Error('unexpected SQL in fake pg: ' + sql.slice(0, 40));
    },
  };
}

const mk = () => makeTenantCrypto({ pgPool: fakePg(), secrets, vault: null });

test('no config → falls back to the platform envelope (no byok marker), round-trips', async () => {
  const tc = mk();
  const stored = JSON.parse(await tc.packCredentialFor('t1', { accessKeyId: 'AKIA', secret: 'shh' }));
  assert.equal(stored.k, undefined, 'platform envelope has no byok marker');
  assert.ok(String(stored.enc).startsWith('enc:v1:'));
  assert.deepEqual(await tc.unpackCredentialFor('t1', stored), { accessKeyId: 'AKIA', secret: 'shh' });
});

test('enable(env-key) → per-tenant DEK envelope, round-trips', async () => {
  const tc = mk();
  const res = await tc.enable('t2', { provider: 'env-key', managedBy: 'platform' });
  assert.equal(res.provider, 'env-key');
  const stored = JSON.parse(await tc.packCredentialFor('t2', { tenancy: 'ocid1', privateKey: 'PEM' }));
  assert.equal(stored.k, 'byok', 'enveloped rows carry the byok marker');
  assert.deepEqual(await tc.unpackCredentialFor('t2', stored), { tenancy: 'ocid1', privateKey: 'PEM' });
});

test('DEK is real envelope encryption — ciphertext is not the plaintext', async () => {
  const tc = mk();
  await tc.enable('t2b', { provider: 'env-key' });
  const stored = JSON.parse(await tc.packCredentialFor('t2b', { secret: 'top-secret-value' }));
  assert.ok(!JSON.stringify(stored).includes('top-secret-value'));
});

test('rotateKek re-wraps the same DEK — existing ciphertext still decrypts', async () => {
  const tc = mk();
  await tc.enable('t3', { provider: 'env-key' });
  const stored = JSON.parse(await tc.packCredentialFor('t3', { k: 'v' }));
  await tc.rotateKek('t3');
  assert.deepEqual(await tc.unpackCredentialFor('t3', stored), { k: 'v' }, 'old ciphertext decrypts after KEK rotation');
});

test('test() reports a healthy config', async () => {
  const tc = mk();
  await tc.enable('t4', { provider: 'env-key' });
  const r = await tc.test('t4');
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'env-key');
});

test('unknown provider is rejected', async () => {
  const tc = mk();
  await assert.rejects(() => tc.enable('t5', { provider: 'nope' }), /Unknown KEK provider/);
});

test('vault-transit requires Vault to be configured', async () => {
  const tc = mk(); // vault: null
  await assert.rejects(() => tc.enable('t6', { provider: 'vault-transit' }), /Vault is not configured/);
});
