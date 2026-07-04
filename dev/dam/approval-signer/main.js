// ─────────────────────────────────────────────────────────────────────────────
//  TooVix DAM — Approval Signer
//  A SEPARATE trust domain. Holds an Ed25519 signing key that the DAM API never
//  has. It attests "an independent approver approved THIS exact grant" by signing
//  a canonical descriptor. DAM refuses to provision a JIT grant without a valid
//  signature, so a compromised DAM cannot self-approve.
//
//  Security properties:
//   • The private key lives only here (its own container/volume). DAM gets only
//     the PUBLIC key via /pubkey.
//   • Approving requires the approver's OWN credential (SIGNER_APPROVER_TOKEN),
//     which DAM does not hold. The browser sends it straight to this service.
//   • Separation of duties (approver ≠ requester) is enforced HERE, from the
//     descriptor, and re-checked independently by DAM.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3100', 10);
const KEY_DIR = process.env.KEY_DIR || '/keys';
const PRIV_PATH = path.join(KEY_DIR, 'signer_ed25519.pem');
// The approver's independent credential — known to the human approver + this
// service ONLY. Never shared with the DAM API. (Dev: a shared token; prod: an
// OIDC/SSO-authenticated approver identity per person.)
const APPROVER_TOKEN = process.env.SIGNER_APPROVER_TOKEN || 'dev-approver-token';

// ── Key: load or generate on first boot (persisted to this service's volume) ──
function loadOrCreateKey() {
  try { fs.mkdirSync(KEY_DIR, { recursive: true }); } catch { /* ignore */ }
  if (fs.existsSync(PRIV_PATH)) {
    return crypto.createPrivateKey(fs.readFileSync(PRIV_PATH, 'utf8'));
  }
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(PRIV_PATH, pem, { mode: 0o600 });
  console.log('[signer] generated a new Ed25519 signing key at', PRIV_PATH);
  return privateKey;
}
const PRIVATE_KEY = loadOrCreateKey();
const PUBLIC_KEY_PEM = crypto.createPublicKey(PRIVATE_KEY).export({ type: 'spki', format: 'pem' });

// Canonical descriptor — MUST byte-match dam-api's canonicalGrant().
function canonical(d) {
  return JSON.stringify({
    grant_id: d.grant_id,
    requester: String(d.requester || '').toLowerCase().trim(),
    broker_id: d.broker_id,
    privilege: d.privilege,
    schema: d.schema,
    object: d.object,
    duration_mins: d.duration_mins,
  });
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, service: 'approval-signer' }));
app.get('/pubkey', (_req, res) => res.json({ pubkey: PUBLIC_KEY_PEM, alg: 'ed25519' }));

app.post('/approve', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== APPROVER_TOKEN) {
    return res.status(401).json({ error: 'Approver credential required (this credential is NOT held by DAM)' });
  }
  const { descriptor, approver } = req.body || {};
  if (!descriptor || !descriptor.grant_id || !descriptor.broker_id || !descriptor.privilege) {
    return res.status(400).json({ error: 'A complete grant descriptor is required' });
  }
  if (!approver || !String(approver).trim()) {
    return res.status(400).json({ error: 'approver identity is required' });
  }
  // Separation of duties — enforced independently of DAM.
  if (String(approver).toLowerCase().trim() === String(descriptor.requester || '').toLowerCase().trim()) {
    return res.status(403).json({ error: 'Separation of duties: the requester cannot approve their own grant' });
  }
  const payload = canonical(descriptor);
  const signature = crypto.sign(null, Buffer.from(payload), PRIVATE_KEY).toString('base64');
  console.log(`[signer] approved grant ${descriptor.grant_id} by ${approver} (requester ${descriptor.requester})`);
  res.json({ ok: true, signature, approved_by: String(approver).trim(), canonical: payload });
});

app.listen(PORT, () => console.log(`[signer] Approval Signer listening on :${PORT}`));
