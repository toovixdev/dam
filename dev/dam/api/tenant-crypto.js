// ─────────────────────────────────────────────────────────────────────────────
// BYOK / envelope encryption — per-tenant Data Encryption Keys wrapped by a pluggable KEK.
//
// Every tenant's secrets are AES-256-GCM-encrypted with a random 256-bit Data Encryption Key
// (DEK), reusing the audited secrets.js toolkit keyed by that DEK. The DEK is stored WRAPPED
// (never in plaintext) by a Key Encryption Key (KEK) whose *provider* is pluggable:
//
//   • env-key       — KEK = the platform CREDENTIAL_ENCRYPTION_KEY (a file on the host). Dev/
//                     fallback only; not the recommended production default.
//   • vault-transit — KEK = a HashiCorp Vault Transit key. The key never leaves Vault; the DEK is
//                     wrapped/unwrapped via Vault's API. Platform-owned key = the default hardened
//                     setup; a customer-owned Vault key = true BYOK.
//   • aws-kms / azure-keyvault / gcp-kms — cloud KMS adapters (stubs here; same wrap/unwrap shape).
//
// "Default vs BYOK" is therefore a single knob: which vault/KMS holds the KEK, and who controls it
// (managed_by = 'platform' | 'customer'). The stored envelope is self-describing (a `k:"byok"`
// marker on the JSONB), so a tenant with no config transparently falls back to the platform
// secrets layer and platform- and BYOK-encrypted rows coexist with no forced migration.
//
// Built as a factory over injected deps (pgPool, the platform `secrets` module, and a Vault
// client) to avoid a circular import with main.js and to stay unit-testable.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

const KEK_PROVIDERS = ['env-key', 'vault-transit', 'aws-kms', 'azure-keyvault', 'gcp-kms'];
const platformVaultKeyName = () => 'dam-platform';
const tenantVaultKeyName = (tenantId) => 'dam-tenant-' + String(tenantId).replace(/-/g, '');

function makeTenantCrypto({ pgPool, secrets, vault }) {
  // vault: { fetch(path, opts), token() } | null when Vault isn't configured on this control plane.
  const cfgCache = new Map();  // tenantId → row | null
  const dekCache = new Map();  // tenantId → { dek: Buffer, at: ms }  (limits vault round-trips)
  const DEK_TTL = 5 * 60 * 1000;

  async function ensureTable() {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS tenant_encryption (
      tenant_id      UUID PRIMARY KEY,
      kek_provider   VARCHAR(20) NOT NULL DEFAULT 'env-key',   -- env-key | vault-transit | *-kms
      kek_ref        VARCHAR(300),                             -- transit key name / KMS key id
      kek_config     JSONB,                                    -- provider extras (customer vault addr/mount, kms region)
      managed_by     VARCHAR(12) NOT NULL DEFAULT 'platform',  -- platform | customer
      wrapped_dek    TEXT NOT NULL,                            -- the DEK, wrapped by the KEK
      dek_created_at TIMESTAMPTZ DEFAULT now(),
      rotated_at     TIMESTAMPTZ,
      updated_by     VARCHAR(160),
      updated_at     TIMESTAMPTZ DEFAULT now()
    )`);
  }

  // ── KEK providers: wrap/unwrap a DEK. Each returns/consumes an opaque wrapped string. ─────────
  const providers = {
    'env-key': {
      async wrap(_ref, _cfg, dek) {
        if (!secrets.hasKey) throw new Error('Platform key (CREDENTIAL_ENCRYPTION_KEY) not configured');
        return secrets.encSecret(dek.toString('base64')); // "enc:v1:…"
      },
      async unwrap(_ref, _cfg, wrapped) {
        return Buffer.from(secrets.decSecret(wrapped), 'base64');
      },
    },
    'vault-transit': {
      async wrap(ref, _cfg, dek) {
        if (!vault) throw new Error('Vault is not configured on this control plane');
        const token = await vault.token();
        // Idempotent create of the Transit key (no-op if it already exists).
        await vault.fetch(`transit/keys/${ref}`, { method: 'POST', headers: { 'X-Vault-Token': token }, body: JSON.stringify({ type: 'aes256-gcm96' }) }).catch(() => {});
        const r = await vault.fetch(`transit/encrypt/${ref}`, { method: 'POST', headers: { 'X-Vault-Token': token }, body: JSON.stringify({ plaintext: dek.toString('base64') }) });
        if (!r || !r.data || !r.data.ciphertext) throw new Error('Vault Transit encrypt failed');
        return r.data.ciphertext; // "vault:v1:…"
      },
      async unwrap(ref, _cfg, wrapped) {
        if (!vault) throw new Error('Vault is not configured on this control plane');
        const token = await vault.token();
        const r = await vault.fetch(`transit/decrypt/${ref}`, { method: 'POST', headers: { 'X-Vault-Token': token }, body: JSON.stringify({ ciphertext: wrapped }) });
        if (!r || !r.data || !r.data.plaintext) throw new Error('Vault Transit decrypt failed');
        return Buffer.from(r.data.plaintext, 'base64');
      },
      async rotate(ref) {
        const token = await vault.token();
        await vault.fetch(`transit/keys/${ref}/rotate`, { method: 'POST', headers: { 'X-Vault-Token': token }, body: '{}' });
      },
    },
    // Cloud KMS adapters — same wrap/unwrap contract; implemented in a later step.
    'aws-kms': notImplemented('AWS KMS'),
    'azure-keyvault': notImplemented('Azure Key Vault'),
    'gcp-kms': notImplemented('GCP Cloud KMS'),
  };
  function notImplemented(name) {
    return { async wrap() { throw new Error(`${name} KEK provider not implemented yet`); }, async unwrap() { throw new Error(`${name} KEK provider not implemented yet`); } };
  }
  const providerFor = (p) => providers[p] || (() => { throw new Error(`Unknown KEK provider: ${p}`); })();

  // ── Config + DEK access ──────────────────────────────────────────────────────
  async function getConfig(tenantId) {
    if (cfgCache.has(tenantId)) return cfgCache.get(tenantId);
    const row = (await pgPool.query('SELECT * FROM tenant_encryption WHERE tenant_id = $1', [tenantId])).rows[0] || null;
    cfgCache.set(tenantId, row);
    return row;
  }
  function invalidate(tenantId) { cfgCache.delete(tenantId); dekCache.delete(tenantId); }

  async function getDEK(tenantId, cfg) {
    const c = dekCache.get(tenantId);
    if (c && Date.now() - c.at < DEK_TTL) return c.dek;
    const dek = await providerFor(cfg.kek_provider).unwrap(cfg.kek_ref, cfg.kek_config, cfg.wrapped_dek);
    dekCache.set(tenantId, { dek, at: Date.now() });
    return dek;
  }

  // ── Public: tenant-aware credential envelope for cloud_connectors.credential ──
  // Safe to call unconditionally: a tenant with no encryption config uses the platform secrets
  // layer. Stored shape: {enc, k:'byok'} for enveloped, else the platform {enc} / legacy object.
  async function packCredentialFor(tenantId, obj) {
    const cfg = await getConfig(tenantId);
    if (cfg) {
      const kit = secrets.makeSecrets((await getDEK(tenantId, cfg)).toString('base64'));
      return JSON.stringify({ enc: kit.encSecret(JSON.stringify(obj || {})), k: 'byok' });
    }
    return secrets.packCredential(obj);
  }
  async function unpackCredentialFor(tenantId, stored) {
    if (stored && typeof stored === 'object' && stored.k === 'byok' && typeof stored.enc === 'string') {
      const cfg = await getConfig(tenantId);
      if (!cfg) return {};
      const kit = secrets.makeSecrets((await getDEK(tenantId, cfg)).toString('base64'));
      try { return JSON.parse(kit.decSecret(stored.enc)); } catch { return {}; }
    }
    return secrets.unpackCredential(stored);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  // Enabling generates a fresh DEK and wraps it under the chosen KEK provider. New writes become
  // enveloped; existing platform rows keep decrypting (self-describing) — non-destructive.
  async function enable(tenantId, { provider = 'vault-transit', managedBy = 'platform', kekRef = null, kekConfig = null, updatedBy = null } = {}) {
    if (!KEK_PROVIDERS.includes(provider)) throw new Error(`Unknown KEK provider: ${provider}`);
    const ref = kekRef || (provider === 'vault-transit'
      ? (managedBy === 'customer' ? tenantVaultKeyName(tenantId) : platformVaultKeyName())
      : null);
    // Switching the KEK provider/key must PRESERVE the DEK — otherwise every already-enveloped
    // secret (encrypted under the old DEK) becomes undecryptable. So on a switch we unwrap the
    // existing DEK and re-wrap the SAME key under the new provider; only a first-time enable mints
    // a fresh DEK. (Rotating the DEK itself — new key + re-encrypt all data — is a separate op.)
    const existing = await getConfig(tenantId);
    const dek = existing ? await getDEK(tenantId, existing) : crypto.randomBytes(32);
    const wrapped = await providerFor(provider).wrap(ref, kekConfig, dek);
    const cfgJson = kekConfig ? JSON.stringify(kekConfig) : null;
    if (existing) {
      await pgPool.query(
        `UPDATE tenant_encryption SET kek_provider=$2, kek_ref=$3, kek_config=$4, managed_by=$5, wrapped_dek=$6, updated_by=$7, updated_at=now() WHERE tenant_id=$1`,
        [tenantId, provider, ref, cfgJson, managedBy, wrapped, updatedBy]);
    } else {
      await pgPool.query(
        `INSERT INTO tenant_encryption (tenant_id, kek_provider, kek_ref, kek_config, managed_by, wrapped_dek, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [tenantId, provider, ref, cfgJson, managedBy, wrapped, updatedBy]);
    }
    invalidate(tenantId);
    dekCache.set(tenantId, { dek, at: Date.now() });
    return { provider, managed_by: managedBy, kek_ref: ref, switched: !!existing };
  }

  // Rotate the KEK (new key version) and re-wrap the SAME DEK. Existing ciphertext still decrypts
  // because the DEK is unchanged — a safe, zero-re-encryption rotation.
  async function rotateKek(tenantId, { updatedBy = null } = {}) {
    const cfg = await getConfig(tenantId);
    if (!cfg) throw new Error('Encryption is not configured for this tenant');
    const dek = await getDEK(tenantId, cfg);
    const prov = providerFor(cfg.kek_provider);
    if (prov.rotate) await prov.rotate(cfg.kek_ref, cfg.kek_config);
    const wrapped = await prov.wrap(cfg.kek_ref, cfg.kek_config, dek);
    await pgPool.query('UPDATE tenant_encryption SET wrapped_dek = $2, rotated_at = now(), updated_by = $3, updated_at = now() WHERE tenant_id = $1', [tenantId, wrapped, updatedBy]);
    invalidate(tenantId);
    return { rotated: true };
  }

  // Round-trip a probe through the tenant's KEK+DEK — powers the "Test" button.
  async function test(tenantId) {
    const cfg = await getConfig(tenantId);
    if (!cfg) return { ok: false, error: 'Encryption not configured' };
    try {
      const kit = secrets.makeSecrets((await getDEK(tenantId, cfg)).toString('base64'));
      const probe = 'selftest-' + Date.now();
      return { ok: kit.decSecret(kit.encSecret(probe)) === probe, provider: cfg.kek_provider, managed_by: cfg.managed_by, kek_ref: cfg.kek_ref };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  return {
    ensureTable, getConfig, invalidate,
    packCredentialFor, unpackCredentialFor,
    enable, rotateKek, test,
    KEK_PROVIDERS, platformVaultKeyName, tenantVaultKeyName,
  };
}

module.exports = { makeTenantCrypto, KEK_PROVIDERS, platformVaultKeyName, tenantVaultKeyName };
