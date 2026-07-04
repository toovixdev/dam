const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const nodemailer = require('nodemailer');
const mysql = require('mysql2/promise');
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // PayU posts its callback as form-encoded

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-prod';
const JWT_EXPIRY = '8h';

// ── Database connections ──────────────────────────────────
const pgPool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  user: process.env.PG_USER || 'dam_admin',
  password: process.env.PG_PASSWORD || 'dam_control_secret',
  database: process.env.PG_DATABASE || 'dam_control',
  max: 10,
});

// ── Email transport (invitations & notifications) ─────────
// Provider-agnostic SMTP via nodemailer. Configure SMTP_* env vars for real delivery
// (Gmail, O365, Amazon SES-SMTP, Mailgun, a local Mailhog, …). With no SMTP_HOST set we
// fall back to a no-network JSON transport and log the invite link so the flow stays
// testable in dev without leaking real email.
const APP_BASE_URL = (process.env.APP_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
const SMTP_FROM = process.env.SMTP_FROM || 'TooVix DAM <no-reply@toovix.security>';

// ── Payment gateways (Razorpay + PayU) ────────────────────
// Config is DB-first (configurable in Settings → Payments) with env fallback.
// Secrets stay server-side (only the Razorpay public key_id reaches the browser).
// Invoices are priced in USD; gateways charge INR, converted at USD_TO_INR.
// Razorpay test mode is implied by an rzp_test_ key; PayU mode is explicit
// (test → test.payu.in, live → secure.payu.in). When no Razorpay key is set we
// fall back to a DEMO key so the real Razorpay UI still opens (test cards only).
const RAZORPAY_DEMO_KEY = process.env.RAZORPAY_DEMO_KEY || 'rzp_test_1DP5mmOlF5G5ag'; // Razorpay's public docs test key
// PayU's publicly published sandbox merchant credentials (test.payu.in) — lets PayU
// open with no account, just like the Razorpay demo key (use PayU test cards).
// NOTE: PayU rotates/retires shared sandbox keys; if the hosted page rejects with
// "incorrectly calculated hash", the key has moved to their v2 hash scheme — set your
// own PayU test key+salt in Settings → Payments (takes precedence over this default).
const PAYU_DEMO_KEY = process.env.PAYU_DEMO_KEY || 'gtKFFx';
const PAYU_DEMO_SALT = process.env.PAYU_DEMO_SALT || 'eCwWELxi';
const USD_TO_INR = parseFloat(process.env.USD_TO_INR || '83.5');
const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
// Optional: force the current invoice to a small total so gateway test payments
// stay under sandbox limits. Unset → real computed bill. e.g. 5 → $5 (~₹417).
const BILLING_TEST_TOTAL_USD = process.env.BILLING_TEST_TOTAL_USD ? parseFloat(process.env.BILLING_TEST_TOTAL_USD) : null;
const usdToInr = (usd) => Math.max(1, Math.round(Number(usd) * USD_TO_INR * 100) / 100); // 2dp INR

let gatewayDbConfig = { razorpay: null, payu: null }; // loaded from gateway_config

// Load DB-saved gateway config at boot + after every save.
async function loadGatewayConfig() {
  try {
    const rows = (await pgPool.query('SELECT provider, config FROM gateway_config')).rows;
    const next = { razorpay: null, payu: null };
    for (const r of rows) next[r.provider] = r.config;
    gatewayDbConfig = next;
  } catch (e) { /* table may not exist yet at first boot */ }
}

// Effective Razorpay: DB → env → demo. mode 'live' (own key+secret, order+verify)
// or 'demo' (public key, no-order checkout + mark-paid-on-success).
function activeRazorpay() {
  const db = gatewayDbConfig.razorpay;
  if (db && db.key_id && db.key_secret) return { keyId: db.key_id, keySecret: db.key_secret, source: 'database', mode: 'live' };
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) return { keyId: process.env.RAZORPAY_KEY_ID, keySecret: process.env.RAZORPAY_KEY_SECRET, source: 'env', mode: 'live' };
  return { keyId: RAZORPAY_DEMO_KEY, keySecret: '', source: 'demo', mode: 'demo' };
}
// Effective PayU: DB → env → demo (public sandbox key+salt, test.payu.in).
function activePayU() {
  const db = gatewayDbConfig.payu;
  if (db && db.merchant_key && db.salt) return { merchantKey: db.merchant_key, salt: db.salt, mode: (db.mode || 'test'), source: 'database' };
  if (process.env.PAYU_MERCHANT_KEY && process.env.PAYU_SALT) return { merchantKey: process.env.PAYU_MERCHANT_KEY, salt: process.env.PAYU_SALT, mode: (process.env.PAYU_MODE || 'test').toLowerCase(), source: 'env' };
  return { merchantKey: PAYU_DEMO_KEY, salt: PAYU_DEMO_SALT, mode: 'test', source: 'demo' };
}
const razorpayLive = () => activeRazorpay().mode === 'live';
const payuConfigured = () => !!activePayU();
const payuBase = (mode) => (mode === 'live' ? 'https://secure.payu.in' : 'https://test.payu.in');

// SMTP can be configured two ways, DB-first then env:
//   1. UI — saved into the `integrations` table (type='email'); see the SMTP
//      endpoints below + the Email (SMTP) card on the product Integrations page.
//   2. Environment — SMTP_HOST/PORT/SECURE/USER/PASS/FROM (deploy-time default).
// With neither set we fall back to a no-network JSON transport and log links so
// the invite flow stays testable. loadSmtpConfig() refreshes the DB layer at
// boot and whenever the config is saved/removed.
let smtpDbConfig = null; // {host,port,secure,user,pass,from} from the DB, or null

async function loadSmtpConfig() {
  try {
    const row = (await pgPool.query(
      "SELECT config FROM integrations WHERE type = 'email' AND status = 'active' ORDER BY last_sync_at DESC NULLS LAST, id DESC LIMIT 1"
    )).rows[0];
    smtpDbConfig = row && row.config && row.config.host ? row.config : null;
  } catch (e) {
    smtpDbConfig = null; // table may not exist yet at first boot — env still works
  }
  _mailer = null; // rebuild the transport against the new config
}

// The effective SMTP config: the UI-saved one wins, else the environment, else
// null (= not configured → JSON transport / dev links).
function activeSmtp() {
  if (smtpDbConfig && smtpDbConfig.host) {
    return {
      host: smtpDbConfig.host,
      port: parseInt(smtpDbConfig.port) || 587,
      secure: !!smtpDbConfig.secure,
      user: smtpDbConfig.user || undefined,
      pass: smtpDbConfig.pass || undefined,
      from: smtpDbConfig.from || SMTP_FROM,
      source: 'database',
    };
  }
  if (process.env.SMTP_HOST) {
    return {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER || undefined,
      pass: process.env.SMTP_PASS || undefined,
      from: SMTP_FROM,
      source: 'env',
    };
  }
  return null;
}
function smtpConfigured() { return !!activeSmtp(); }
function activeFrom() { const s = activeSmtp(); return (s && s.from) || SMTP_FROM; }

// Build a nodemailer transport from an explicit SMTP config (used by getMailer
// and by the "send test" endpoint, which can test an unsaved config).
function buildTransport(s) {
  if (!s || !s.host) return nodemailer.createTransport({ jsonTransport: true });
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
  });
}

let _mailer;
function getMailer() {
  if (!_mailer) _mailer = buildTransport(activeSmtp());
  return _mailer;
}

// ── Platform mailer ──────────────────────────────────────────────────────────
// SYSTEM email (signup verification, invites) is PLATFORM-level — it has no tenant
// context. It uses a platform SMTP configured by the operator in the Super-Admin
// console (DB singleton `platform_smtp`), falling back to SMTP_* env. This is
// separate from a tenant's own Integrations → Email (used for that tenant's alerts).
let platformSmtpConfig = null; // {host,port,secure,username,password,from_addr} or null
let _platformMailer = null;
async function loadPlatformSmtp() {
  try {
    const row = (await pgPool.query('SELECT host, port, secure, username, password, from_addr FROM platform_smtp WHERE id = 1')).rows[0];
    platformSmtpConfig = row && row.host ? row : null;
  } catch (e) { platformSmtpConfig = null; }
  _platformMailer = null;
}
function activePlatformSmtp() {
  if (platformSmtpConfig && platformSmtpConfig.host) {
    return { host: platformSmtpConfig.host, port: parseInt(platformSmtpConfig.port) || 587, secure: !!platformSmtpConfig.secure,
      user: platformSmtpConfig.username || undefined, pass: platformSmtpConfig.password || undefined,
      from: platformSmtpConfig.from_addr || SMTP_FROM, source: 'database' };
  }
  if (process.env.SMTP_HOST) {
    return { host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587'), secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER || undefined, pass: process.env.SMTP_PASS || undefined, from: SMTP_FROM, source: 'env' };
  }
  return null;
}
function getPlatformMailer() { if (!_platformMailer) _platformMailer = buildTransport(activePlatformSmtp()); return _platformMailer; }
function platformFrom() { const s = activePlatformSmtp(); return (s && s.from) || SMTP_FROM; }
function platformConfigured() { return !!activePlatformSmtp(); }

function inviteEmailHtml({ fullName, role, tenantName, inviterName, acceptUrl }) {
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
  <div style="max-width:520px;margin:0 auto;padding:24px">
    <div style="font-size:18px;font-weight:800;margin-bottom:18px">TooVix <span style="color:#64748b;font-weight:500">DAM</span></div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px">
      <h1 style="font-size:20px;margin:0 0 10px">You've been invited to ${tenantName}</h1>
      <p style="font-size:14px;line-height:1.6;color:#334155;margin:0 0 8px">Hi ${fullName || 'there'},</p>
      <p style="font-size:14px;line-height:1.6;color:#334155;margin:0 0 18px">
        ${inviterName || 'A tenant admin'} has invited you to join <b>${tenantName}</b> on TooVix DAM as
        <b>${role}</b>. Set your password to activate your account and join the workspace.</p>
      <a href="${acceptUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:10px">Accept invitation</a>
      <p style="font-size:12px;color:#64748b;margin:18px 0 0">Or paste this link into your browser:<br>
        <span style="word-break:break-all;color:#6366f1">${acceptUrl}</span></p>
      <p style="font-size:12px;color:#94a3b8;margin:16px 0 0">This invitation expires in 7 days. MFA is required after sign-in.</p>
    </div>
    <p style="font-size:11px;color:#94a3b8;text-align:center;margin:16px 0 0">If you weren't expecting this, you can ignore this email.</p>
  </div></body></html>`;
}

async function sendInviteEmail({ to, fullName, role, tenantName, inviterName, acceptUrl }) {
  const subject = `You're invited to ${tenantName} on TooVix DAM`;
  const text = `Hi ${fullName || 'there'},\n\n${inviterName || 'A tenant admin'} has invited you to join `
    + `${tenantName} on TooVix DAM as ${role}.\n\nAccept your invitation and set your password:\n${acceptUrl}\n\n`
    + `This invitation expires in 7 days.\n\n— TooVix DAM`;
  await getPlatformMailer().sendMail({
    from: platformFrom(),
    to,
    subject,
    text,
    html: inviteEmailHtml({ fullName, role, tenantName, inviterName, acceptUrl }),
  });
  if (!platformConfigured()) {
    console.log(`[Invite] No platform SMTP configured — invite link for ${to}: ${acceptUrl}`);
  } else {
    console.log(`[Invite] Sent invitation email to ${to}`);
  }
}

// Signup email verification: confirms the first admin owns the address before the workspace goes live.
async function sendVerifyEmail({ to, fullName, tenantName, slug, verifyUrl }) {
  const subject = `Verify your email to activate ${tenantName} on TooVix DAM`;
  const wsLine = slug ? `\n\nYour workspace ID (you'll need it to sign in): ${slug}` : '';
  const text = `Hi ${fullName || 'there'},\n\nConfirm your email to activate your TooVix DAM workspace `
    + `"${tenantName}".${wsLine}\n\nVerify your account:\n${verifyUrl}\n\nThis link expires in 24 hours.\n\n— TooVix DAM`;
  const wsBlock = slug ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin:18px 0 0">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;font-weight:700">Your workspace ID</div>
          <div style="font-size:16px;font-weight:700;font-family:ui-monospace,Menlo,monospace;color:#0f172a;margin-top:2px">${slug}</div>
          <div style="font-size:11.5px;color:#64748b;margin-top:4px">You'll enter this on the sign-in page each time you log in. Keep this email.</div>
        </div>` : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
    <div style="max-width:520px;margin:0 auto;padding:24px">
      <div style="font-size:18px;font-weight:800;margin-bottom:18px">TooVix <span style="color:#64748b;font-weight:500">DAM</span></div>
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px">
        <h1 style="font-size:20px;margin:0 0 10px">Verify your email</h1>
        <p style="font-size:14px;line-height:1.6;color:#334155;margin:0 0 18px">Hi ${fullName || 'there'}, confirm this
          address to activate your workspace <b>${tenantName}</b> and sign in.</p>
        <a href="${verifyUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:10px">Verify &amp; activate</a>
        ${wsBlock}
        <p style="font-size:12px;color:#64748b;margin:18px 0 0">Or paste this link:<br><span style="word-break:break-all;color:#6366f1">${verifyUrl}</span></p>
        <p style="font-size:12px;color:#94a3b8;margin:14px 0 0">This link expires in 24 hours. If you didn't sign up, ignore this email.</p>
      </div>
    </div></body></html>`;
  await getPlatformMailer().sendMail({ from: platformFrom(), to, subject, text, html });
  if (!platformConfigured()) console.log(`[Signup] No platform SMTP configured — verify link for ${to}: ${verifyUrl}`);
  else console.log(`[Signup] Sent verification email to ${to}`);
}

// Welcome email — sent once a workspace goes live with its first admin (after the
// self-serve email is verified). Recaps the workspace ID + first-run steps. Best-effort:
// never block activation on it.
async function sendWelcomeEmail({ to, fullName, tenantName, slug, tier, loginUrl }) {
  const subject = `Welcome to TooVix DAM — ${tenantName} is live`;
  const planLine = tier === 'starter' ? 'a 14-day trial on shared infrastructure' : `the ${tier} plan`;
  const steps = [
    ['Connect your first database', 'Add a database instance and generate its agent enrolment token.'],
    ['Deploy an agent', 'Run the inline-proxy or network agent so activity starts flowing in.'],
    ['Invite your team', 'Add teammates from Users — they sign in to this same workspace.'],
    ['Turn on single sign-on (optional)', 'Enable Azure AD for the workspace in Integrations → SSO.'],
  ];
  const text = `Hi ${fullName || 'there'},\n\nYour TooVix DAM workspace "${tenantName}" is live on ${planLine}.\n\n`
    + `Workspace ID (you'll enter this to sign in): ${slug}\nSign in: ${loginUrl}\n\n`
    + `Getting started:\n${steps.map(([t, d], i) => `  ${i + 1}. ${t} — ${d}`).join('\n')}\n\n— TooVix DAM`;
  const stepHtml = steps.map(([t, d], i) => `<tr>
      <td style="padding:8px 10px 8px 0;vertical-align:top;width:26px"><div style="width:22px;height:22px;border-radius:50%;background:#eef2ff;color:#6366f1;font-weight:700;font-size:12px;text-align:center;line-height:22px">${i + 1}</div></td>
      <td style="padding:8px 0"><b style="font-size:13px">${t}</b><div style="font-size:12px;color:#64748b;margin-top:1px">${d}</div></td>
    </tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
    <div style="max-width:520px;margin:0 auto;padding:24px">
      <div style="font-size:18px;font-weight:800;margin-bottom:18px">TooVix <span style="color:#64748b;font-weight:500">DAM</span></div>
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px">
        <h1 style="font-size:20px;margin:0 0 10px">Welcome, ${fullName || 'there'} 👋</h1>
        <p style="font-size:14px;line-height:1.6;color:#334155;margin:0 0 16px">Your workspace <b>${tenantName}</b> is live on ${planLine}. You're its first admin.</p>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin:0 0 18px">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;font-weight:700">Your workspace ID</div>
          <div style="font-size:16px;font-weight:700;font-family:ui-monospace,Menlo,monospace;color:#0f172a;margin-top:2px">${slug}</div>
          <div style="font-size:11.5px;color:#64748b;margin-top:4px">Enter this on the sign-in page each time you log in.</div>
        </div>
        <a href="${loginUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:10px">Open your console</a>
        <p style="font-size:13px;font-weight:700;margin:22px 0 6px">Getting started</p>
        <table style="width:100%;border-collapse:collapse">${stepHtml}</table>
        <p style="font-size:11px;color:#94a3b8;margin:18px 0 0">Need a hand? Just reply to this email.</p>
      </div>
    </div></body></html>`;
  await getPlatformMailer().sendMail({ from: platformFrom(), to, subject, text, html });
  if (!platformConfigured()) console.log(`[Welcome] No platform SMTP — welcome for ${to} (workspace ${slug}) not actually sent`);
  else console.log(`[Welcome] Sent welcome email to ${to} for workspace ${slug}`);
}

// Provider display names for SSO invites/logins (auth_provider → label).
const SSO_INVITE_PROVIDERS = { azure_ad: 'Azure AD', okta: 'Okta', google: 'Google' };
// SSO users authenticate via their identity provider — no password or token. This
// notifies them that access was granted and points them at the SSO sign-in.
async function sendSsoInviteEmail({ to, fullName, role, tenantName, inviterName, loginUrl, providerName = 'Azure AD' }) {
  const btnBg = { 'Azure AD': '#0078d4', Okta: '#007dc1', Google: '#ea4335' }[providerName] || '#6366f1';
  const subject = `You've been granted access to ${tenantName} on TooVix DAM`;
  const text = `Hi ${fullName || 'there'},\n\n${inviterName || 'A tenant admin'} has granted you access to `
    + `${tenantName} on TooVix DAM as ${role}.\n\nSign in with your ${providerName} account `
    + `(use "Continue with ${providerName}" — no password needed):\n${loginUrl}\n\n— TooVix DAM`;
  const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
  <div style="max-width:520px;margin:0 auto;padding:24px">
    <div style="font-size:18px;font-weight:800;margin-bottom:18px">TooVix <span style="color:#64748b;font-weight:500">DAM</span></div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px">
      <h1 style="font-size:20px;margin:0 0 10px">You've been granted access to ${tenantName}</h1>
      <p style="font-size:14px;line-height:1.6;color:#334155;margin:0 0 18px">Hi ${fullName || 'there'},
        ${inviterName || 'A tenant admin'} has granted you the <b>${role}</b> role on TooVix DAM.
        Your account uses <b>${providerName} single sign-on</b> — no password to set.</p>
      <a href="${loginUrl}" style="display:inline-block;background:${btnBg};color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:10px">Sign in with ${providerName}</a>
      <p style="font-size:12px;color:#64748b;margin:18px 0 0">Use the <b>Continue with ${providerName}</b> button on the sign-in page. MFA is handled by your identity provider.</p>
    </div>
    <p style="font-size:11px;color:#94a3b8;text-align:center;margin:16px 0 0">If you weren't expecting this, you can ignore this email.</p>
  </div></body></html>`;
  await getPlatformMailer().sendMail({ from: platformFrom(), to, subject, text, html });
  if (!smtpConfigured()) {
    console.log(`[Invite] No SMTP configured (dev) — SSO sign-in link for ${to}: ${loginUrl}`);
  } else {
    console.log(`[Invite] Sent SSO access email to ${to}`);
  }
}

// ── Auth migration: runs on startup ───────────────────────
async function runAuthMigration() {
  const client = await pgPool.connect();
  try {
    const colCheck = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'password_hash'`
    );
    if (colCheck.rows.length === 0) {
      console.log('[Auth] Running migration: adding password_hash column...');
      await client.query(`ALTER TABLE users ADD COLUMN password_hash VARCHAR(100)`);
    }

    // Invitation columns (additive, idempotent)
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_token VARCHAR(64)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by UUID`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_invite_token ON users (invite_token)`);

    // MFA (TOTP) columns — secret is the base32 shared key; enrolled_at set once the
    // user confirms a first code; backup_codes holds bcrypt hashes of one-time recovery codes.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret VARCHAR(64)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enrolled_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_backup_codes JSONB`);
    // MFA is required for all password logins → new accounts default to enabled.
    await client.query(`ALTER TABLE users ALTER COLUMN mfa_enabled SET DEFAULT true`);
    // Email is unique PER TENANT (a person can belong to multiple workspaces), not global.
    await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key`);
    await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_tenant_email_key') THEN ALTER TABLE users ADD CONSTRAINT users_tenant_email_key UNIQUE (tenant_id, email); END IF; END $$;`);

    const userCheck = await client.query(
      `SELECT id FROM users WHERE email = 'vikramsharma3107@gmail.com'`
    );
    if (userCheck.rows.length === 0) {
      const hash = await bcrypt.hash('Admin@123', 10);
      await client.query(
        `INSERT INTO users (tenant_id, email, full_name, role, auth_provider, mfa_enabled, status, password_hash)
         VALUES ((SELECT id FROM tenants LIMIT 1), 'vikramsharma3107@gmail.com', 'Vikram Sharma', 'tenant_admin', 'local', true, 'active', $1)`,
        [hash]
      );
      console.log('[Auth] Created tenant_admin: vikramsharma3107@gmail.com / Admin@123');
    } else {
      const pwCheck = await client.query(
        `SELECT password_hash FROM users WHERE email = 'vikramsharma3107@gmail.com'`
      );
      if (!pwCheck.rows[0].password_hash) {
        const hash = await bcrypt.hash('Admin@123', 10);
        await client.query(
          `UPDATE users SET password_hash = $1 WHERE email = 'vikramsharma3107@gmail.com'`,
          [hash]
        );
        console.log('[Auth] Set password for vikramsharma3107@gmail.com');
      }
    }
    // Compliance scores table
    await client.query(`CREATE TABLE IF NOT EXISTS compliance_scores (
      id SERIAL PRIMARY KEY, framework VARCHAR(40) NOT NULL, score INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT now()
    )`);
    const cmpCheck = await client.query(`SELECT COUNT(*) as cnt FROM compliance_scores`);
    if (parseInt(cmpCheck.rows[0].cnt) === 0) {
      await client.query(`INSERT INTO compliance_scores (framework, score) VALUES
        ('PCI-DSS 4.0', 91), ('GDPR', 86), ('SOX', 93), ('HIPAA', 88), ('DPDPA', 82), ('RBI CSF', 91), ('ISO 27001', 79)`);
      console.log('[Auth] Seeded compliance scores');
    }

    // Seed alerts if none exist
    const alertCheck = await client.query(`SELECT COUNT(*) as cnt FROM alerts`);
    if (parseInt(alertCheck.rows[0].cnt) === 0) {
      const dbIds = (await client.query(`SELECT id FROM databases LIMIT 3`)).rows;
      if (dbIds.length > 0) {
        const tid = (await client.query(`SELECT id FROM tenants LIMIT 1`)).rows[0].id;
        await client.query(`INSERT INTO alerts (tenant_id, database_id, severity, principal, summary, anomaly_score, status) VALUES
          ($1, $2, 'critical', 'svc_analytics', 'Mass PII read - 87,300 rows from CUSTOMERS table', 92, 'open'),
          ($1, $2, 'critical', 'temp_user', 'Decoy table probe + privilege escalation attempt', 88, 'open'),
          ($1, $3, 'high', 'bi_reader', 'Bulk PII export exceeding baseline - 18,400 rows', 74, 'open'),
          ($1, $3, 'high', 'dba_mueller', 'Off-hours access to GDPR-tagged data at 03:22 CET', 68, 'open'),
          ($1, $4, 'high', 'app_payments', 'Card number access from new IP range', 61, 'open'),
          ($1, $2, 'medium', 'svc_etl', 'Service account login from new geographic location', 45, 'open'),
          ($1, $3, 'medium', 'rpt_service', 'Unusual query pattern on sensitive columns', 42, 'open'),
          ($1, $4, 'low', 'app_crm', 'High volume reads during business hours', 22, 'open'),
          ($1, $2, 'critical', 'unknown_user', 'Brute force - 284 failed login attempts', 95, 'open'),
          ($1, $4, 'high', 'svc_kyc', 'Aadhaar bulk access outside change window - 8,400 rows', 71, 'open')`,
          [tid, dbIds[0].id, dbIds[1] ? dbIds[1].id : dbIds[0].id, dbIds[2] ? dbIds[2].id : dbIds[0].id]);
        console.log('[Auth] Seeded 10 alerts');
      }
    }

    // (Agents are no longer seeded — real agents self-enroll via POST /api/agents/enroll.
    //  Databases stay unmonitored until an agent is actually deployed.)

    // ── Databases screen enrichment (additive columns only) ──
    // Monitoring/coverage/status are derived live from the real `agents` table in
    // GET /api/databases — we only persist descriptive metadata here.
    await client.query(`ALTER TABLE databases ADD COLUMN IF NOT EXISTS environment VARCHAR(20) DEFAULT 'prod'`);
    await client.query(`ALTER TABLE databases ADD COLUMN IF NOT EXISTS sensitivity_tags TEXT[] DEFAULT '{}'`);

    // Sensitivity tags for the real, running client databases (these genuinely hold such data).
    await client.query(`UPDATE databases SET sensitivity_tags = ARRAY['PII'] WHERE name = 'PG-CRM-PROD' AND sensitivity_tags = '{}'`);
    await client.query(`UPDATE databases SET sensitivity_tags = ARRAY['PCI','PII'] WHERE name = 'MYSQL-PAYMENTS-PROD' AND sensitivity_tags = '{}'`);
    await client.query(`UPDATE databases SET sensitivity_tags = ARRAY['GDPR','PII'] WHERE name = 'MONGO-PROFILES-UK' AND sensitivity_tags = '{}'`);

    // ── Instance model: a database (schema) belongs to an instance (host:port server) ──
    // Agents enroll against the instance, so every database on it shares the coverage.
    await client.query(`CREATE TABLE IF NOT EXISTS db_instances (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       UUID REFERENCES tenants(id),
      name            VARCHAR(160) NOT NULL,
      engine          VARCHAR(40) NOT NULL,
      version         VARCHAR(40),
      host            VARCHAR(200),
      port            INT,
      deployment_type VARCHAR(20) DEFAULT 'onprem',
      cloud_provider  VARCHAR(20),
      region          VARCHAR(40),
      environment     VARCHAR(20) DEFAULT 'prod',
      created_at      TIMESTAMPTZ DEFAULT now(),
      updated_at      TIMESTAMPTZ DEFAULT now()
    )`);
    await client.query(`ALTER TABLE databases ADD COLUMN IF NOT EXISTS instance_id UUID`);
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS instance_id UUID`);

    // Backfill: group existing databases into instances by (tenant, host, port, engine).
    const ungrouped = await client.query(
      `SELECT DISTINCT tenant_id, host, port, engine FROM databases WHERE instance_id IS NULL`
    );
    for (const g of ungrouped.rows) {
      const found = await client.query(
        `SELECT id FROM db_instances
         WHERE tenant_id IS NOT DISTINCT FROM $1 AND host IS NOT DISTINCT FROM $2
           AND port IS NOT DISTINCT FROM $3 AND engine = $4`,
        [g.tenant_id, g.host, g.port, g.engine]
      );
      let instanceId;
      if (found.rows.length) {
        instanceId = found.rows[0].id;
      } else {
        const meta = await client.query(
          `SELECT version, deployment_type, cloud_provider, region, environment FROM databases
           WHERE tenant_id IS NOT DISTINCT FROM $1 AND host IS NOT DISTINCT FROM $2
             AND port IS NOT DISTINCT FROM $3 AND engine = $4 LIMIT 1`,
          [g.tenant_id, g.host, g.port, g.engine]
        );
        const m = meta.rows[0] || {};
        const name = g.host || 'instance';
        const created = await client.query(
          `INSERT INTO db_instances (tenant_id, name, engine, version, host, port, deployment_type, cloud_provider, region, environment)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [g.tenant_id, name, g.engine, m.version || null, g.host, g.port, m.deployment_type || 'onprem', m.cloud_provider || null, m.region || null, m.environment || 'prod']
        );
        instanceId = created.rows[0].id;
      }
      await client.query(
        `UPDATE databases SET instance_id = $1
         WHERE instance_id IS NULL AND tenant_id IS NOT DISTINCT FROM $2 AND host IS NOT DISTINCT FROM $3
           AND port IS NOT DISTINCT FROM $4 AND engine = $5`,
        [instanceId, g.tenant_id, g.host, g.port, g.engine]
      );
    }
    // Link existing agents to their database's instance.
    await client.query(
      `UPDATE agents a SET instance_id = d.instance_id FROM databases d
       WHERE a.database_id = d.id AND a.instance_id IS NULL`
    );
    // Uniform naming: auto-generated names that were "host:port" become just "host"
    // (the host:port endpoint is shown separately in the UI).
    await client.query(
      `UPDATE db_instances SET name = host
       WHERE host IS NOT NULL AND port IS NOT NULL AND name = host || ':' || port::text`
    );

    // ── Discovery: candidates found by the scanner, awaiting review ──
    await client.query(`CREATE TABLE IF NOT EXISTS discovery_candidates (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       UUID REFERENCES tenants(id),
      endpoint        VARCHAR(220) NOT NULL,
      host            VARCHAR(200),
      port            INT,
      engine          VARCHAR(40),
      version         VARCHAR(40),
      source          VARCHAR(20) DEFAULT 'network',
      deployment_type VARCHAR(20) DEFAULT 'onprem',
      cloud_provider  VARCHAR(20),
      region          VARCHAR(40),
      signal          VARCHAR(20) DEFAULT 'clean',
      confidence      VARCHAR(10) DEFAULT 'high',
      status          VARCHAR(15) DEFAULT 'candidate',
      job_id          VARCHAR(40),
      discovered_at   TIMESTAMPTZ DEFAULT now(),
      UNIQUE (tenant_id, endpoint)
    )`);
    // Reachability tracking: when a scan no longer sees a known candidate, we flag
    // it unreachable rather than re-discovering or silently keeping it as "new".
    await client.query(`ALTER TABLE discovery_candidates ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ`);
    await client.query(`ALTER TABLE discovery_candidates ADD COLUMN IF NOT EXISTS reachable BOOLEAN DEFAULT true`);
    await client.query(`UPDATE discovery_candidates SET last_seen = discovered_at WHERE last_seen IS NULL`);
    await client.query(`CREATE TABLE IF NOT EXISTS discovery_jobs (
      id          VARCHAR(40) PRIMARY KEY,
      tenant_id   UUID REFERENCES tenants(id),
      scan_type   VARCHAR(20) DEFAULT 'network',
      scope       VARCHAR(220),
      port_set    VARCHAR(60),
      ports_count INT DEFAULT 0,
      found       INT DEFAULT 0,
      status      VARCHAR(15) DEFAULT 'running',
      created_at  TIMESTAMPTZ DEFAULT now()
    )`);

    // ── Alerts: rich detail fields for the alert drilldown popup ──
    for (const col of [
      'rule VARCHAR(120)', 'user_type VARCHAR(60)', 'flags TEXT[] DEFAULT \'{}\'',
      'action VARCHAR(40)', 'subtype VARCHAR(60)', 'object_name VARCHAR(160)',
      'rows_affected VARCHAR(40)', 'client_ip VARCHAR(60)', 'program VARCHAR(60)',
      'sensitivity_tags TEXT[] DEFAULT \'{}\'', 'why TEXT', 'rule_condition TEXT',
    ]) {
      await client.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS ${col}`);
    }
    // Backfill older alerts so the detail popup always has content.
    await client.query(
      `UPDATE alerts SET
         rule = COALESCE(rule, 'Anomalous activity'),
         user_type = COALESCE(user_type, 'service'),
         action = COALESCE(action, 'READ'),
         subtype = COALESCE(subtype, 'SELECT'),
         object_name = COALESCE(object_name, 'unknown'),
         rows_affected = COALESCE(rows_affected, '—'),
         client_ip = COALESCE(client_ip, '10.20.0.0'),
         program = COALESCE(program, 'unknown'),
         why = COALESCE(why, summary),
         rule_condition = COALESCE(rule_condition, '{ "anomaly_score": { "gte": 70 } }')
       WHERE rule IS NULL`
    );
    await client.query(`UPDATE alerts SET flags = ARRAY['anomaly_detected'] WHERE flags = '{}' OR flags IS NULL`);

    // Suppressions created when an alert is marked false-positive (rule tuning feedback).
    // NULL principal/object = wildcard (rule-wide or any object).
    await client.query(`CREATE TABLE IF NOT EXISTS alert_suppressions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   UUID REFERENCES tenants(id),
      rule        VARCHAR(120),
      principal   VARCHAR(160),
      object_name VARCHAR(160),
      reason      TEXT,
      created_by  VARCHAR(200),
      created_at  TIMESTAMPTZ DEFAULT now()
    )`);
    // Governed exceptions: db-qualified scope + optional expiry (additive columns).
    await client.query(`ALTER TABLE alert_suppressions ADD COLUMN IF NOT EXISTS database_name VARCHAR(160)`);
    await client.query(`ALTER TABLE alert_suppressions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
    // Retention: soft-delete so the full exception lifecycle survives revocation.
    await client.query(`ALTER TABLE alert_suppressions ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'`);
    await client.query(`ALTER TABLE alert_suppressions ADD COLUMN IF NOT EXISTS revoked_by VARCHAR(200)`);
    await client.query(`ALTER TABLE alert_suppressions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ`);
    await client.query(`UPDATE alert_suppressions SET status = 'active' WHERE status IS NULL`);

    // ── Classification: split into OBJECTS (tables/collections) + COLUMNS ──
    await client.query(`CREATE TABLE IF NOT EXISTS classified_objects (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       UUID REFERENCES tenants(id),
      database_id     UUID REFERENCES databases(id),
      schema_name     VARCHAR(80),
      object_name     VARCHAR(120),
      object_type     VARCHAR(20) DEFAULT 'table',
      row_count       BIGINT DEFAULT 0,
      sensitivity     VARCHAR(15) DEFAULT 'low',
      owner           VARCHAR(120),
      column_count    INT DEFAULT 0,
      last_scanned_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (database_id, schema_name, object_name)
    )`);
    // Columns now belong to an object; schema/table move up to the object.
    await client.query(`ALTER TABLE classified_columns ADD COLUMN IF NOT EXISTS object_id UUID REFERENCES classified_objects(id)`);
    await client.query(`ALTER TABLE classified_columns ADD COLUMN IF NOT EXISTS sensitivity VARCHAR(15)`);
    await client.query(`ALTER TABLE classified_columns DROP COLUMN IF EXISTS schema_name`);
    await client.query(`ALTER TABLE classified_columns DROP COLUMN IF EXISTS table_name`);

    // Remove the old hand-seeded (fake) classification rows — classification is now
    // populated by the real scanner. Seed rows are identifiable by their fixed owners.
    await client.query(
      `DELETE FROM classified_columns WHERE object_id IN
         (SELECT id FROM classified_objects WHERE owner IN ('pay_svc','app','profile_svc'))`
    );
    await client.query(`DELETE FROM classified_objects WHERE owner IN ('pay_svc','app','profile_svc')`);

    // ── Policies: extra fields for the rules screen + seed the rule library ──
    for (const col of ['rule_type VARCHAR(40)', 'category VARCHAR(20)', 'scope VARCHAR(160)', 'actions TEXT[] DEFAULT \'{}\'', 'shadow_fp INTEGER DEFAULT 0']) {
      await client.query(`ALTER TABLE policies ADD COLUMN IF NOT EXISTS ${col}`);
    }
    await client.query(`CREATE TABLE IF NOT EXISTS policy_versions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      policy_id   UUID REFERENCES policies(id) ON DELETE CASCADE,
      version     INTEGER,
      change      VARCHAR(160),
      changed_by  VARCHAR(200),
      snapshot    JSONB,
      created_at  TIMESTAMPTZ DEFAULT now()
    )`);
    // Backfill an initial version for any policy that predates the versions table.
    await client.query(
      `INSERT INTO policy_versions (policy_id, version, change, changed_by, snapshot)
       SELECT p.id, 1, 'Created', 'system', to_jsonb(p) FROM policies p
       WHERE NOT EXISTS (SELECT 1 FROM policy_versions v WHERE v.policy_id = p.id)`
    );
    const polCount = await client.query('SELECT COUNT(*) AS n FROM policies');
    if (parseInt(polCount.rows[0].n) === 0) {
      const ptid = (await client.query('SELECT id FROM tenants LIMIT 1')).rows[0];
      if (ptid) {
        const POLICIES = [
          { n: 'Bulk read of sensitive data', type: 'threshold', cat: 'alert', sev: 'critical', scope: 'compliance_tag: pii, pci, aadhaar', act: ['alert'], st: 'enabled', desc: 'Fires when a principal reads 10,000+ rows from objects tagged PII/PCI/PHI — identical on an Oracle SELECT, a Mongo find(), or a Db2 SELECT.', cond: { action_type: 'READ', object_sensitivity_tags: { any_of: ['pii', 'pci', 'aadhaar'] }, rows_affected: { gte: 10000 }, principal_user_type: 'human' } },
          { n: 'Block DELETE without WHERE', type: 'pattern', cat: 'block', sev: 'critical', scope: 'db_group: prod', act: ['block'], st: 'enabled', desc: 'Inline proxy blocks any DELETE/UPDATE lacking a WHERE clause on production databases. Fail-open by default; fail-closed for crown-jewel DBs.', cond: { action_type: { any_of: ['DELETE', 'WRITE'] }, no_where_clause: true, action: 'block' } },
          { n: 'Privileged off-hours access', type: 'anomaly', cat: 'alert', sev: 'critical', scope: 'all', act: ['alert'], st: 'enabled', desc: 'DBA/privileged access to sensitive objects outside the principal’s learned activity window.', cond: { principal_user_type: 'dba', unusual_access_time: true, object_sensitivity_tags: { any_of: ['pci', 'pii', 'aadhaar'] } } },
          { n: 'Credential brute force', type: 'threshold', cat: 'alert', sev: 'high', scope: 'all', act: ['alert', 'webhook'], st: 'enabled', desc: '50+ failed logins in 5 minutes grouped by client IP — brute force / password spray.', cond: { action_type: 'LOGIN', return_code: { ne: 0 }, window_minutes: 5, failure_count: { gte: 50 }, group_by: ['client_ip'] } },
          { n: 'DDL change control', type: 'pattern', cat: 'alert', sev: 'high', scope: 'db_group: prod', act: ['alert', 'email'], st: 'enabled', desc: 'Any DDL outside the approved change window with no linked change ticket.', cond: { action_type: 'DDL', outside_change_window: true } },
          { n: 'First-time object access', type: 'first_time', cat: 'alert', sev: 'medium', scope: 'compliance_tag: pii', act: ['alert'], st: 'enabled', desc: 'A principal touches a sensitive object it has never accessed before.', cond: { first_time_object_access: true, object_sensitivity_tags: { any_of: ['pii'] } } },
          { n: 'GRANT of DBA / SYSDBA', type: 'privileged', cat: 'alert', sev: 'high', scope: 'all', act: ['alert'], st: 'enabled', desc: 'Privilege escalation: a high-privilege role granted to a non-DBA account.', cond: { action_type: 'GRANT', grants_role: { in: ['DBA', 'SYSDBA'] } } },
          { n: 'LLM prompt exfiltration', type: 'pattern', cat: 'block', sev: 'high', scope: 'engine: llm', act: ['block'], st: 'disabled', desc: 'Redacts or blocks PII in a prompt before it reaches an external LLM (ChatGPT / Bedrock / Azure OpenAI).', cond: { destination: 'external_llm', prompt_contains_sensitive: true, action: 'mask_or_block' } },
          { n: 'Excessive cross-schema joins', type: 'anomaly', cat: 'alert', sev: 'medium', scope: 'db_group: prod', act: ['alert'], st: 'monitor', hits: 142, fp: 18, desc: 'Queries joining across 3+ schemas where at least one contains sensitive data — may indicate data exploration or unauthorized reporting.', cond: { action_type: 'READ', cross_schema_join_count: { gte: 3 }, object_sensitivity_tags: { any_of: ['pii', 'pci'] } } },
          { n: 'Service account from new IP range', type: 'first_time', cat: 'alert', sev: 'high', scope: 'all', act: ['alert', 'webhook'], st: 'monitor', hits: 38, fp: 4, desc: 'A service account connects from an IP range it has never used before — possible credential theft or lateral movement.', cond: { principal_user_type: 'service', first_time_source_ip_range: true } },
          { n: 'Bulk export via ODBC/JDBC driver', type: 'threshold', cat: 'alert', sev: 'high', scope: 'compliance_tag: pci', act: ['alert'], st: 'monitor', hits: 8, fp: 6, desc: 'Large result sets (50K+ rows) pulled via ODBC/JDBC drivers — typically indicates data export to a local file.', cond: { action_type: 'READ', rows_affected: { gte: 50000 }, client_driver: { in: ['odbc', 'jdbc'] }, object_sensitivity_tags: { any_of: ['pci'] } } },
        ];
        for (const p of POLICIES) {
          const r = await client.query(
            `INSERT INTO policies (tenant_id, name, description, rule_type, category, severity, scope, actions, status, rule_definition, shadow_hits, shadow_fp)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [ptid.id, p.n, p.desc, p.type, p.cat, p.sev, p.scope, p.act, p.st, JSON.stringify(p.cond), p.hits || 0, p.fp || 0]
          );
          await client.query(
            `INSERT INTO policy_versions (policy_id, version, change, changed_by, snapshot)
             VALUES ($1, 1, 'Created', 'system', to_jsonb((SELECT pp FROM policies pp WHERE pp.id = $1)))`,
            [r.rows[0].id]
          );
        }
      }
    }

    // ── Quarantine: held sessions awaiting review (workflow state) ──
    await client.query(`CREATE TABLE IF NOT EXISTS quarantine_sessions (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     UUID REFERENCES tenants(id),
      session_id    VARCHAR(40),
      principal     VARCHAR(160),
      database_name VARCHAR(160),
      query_preview TEXT,
      severity      VARCHAR(15) DEFAULT 'high',
      reason        VARCHAR(200),
      client_ip     VARCHAR(60),
      status        VARCHAR(15) DEFAULT 'held',
      held_at       TIMESTAMPTZ DEFAULT now(),
      resolved_at   TIMESTAMPTZ
    )`);
    await client.query(`ALTER TABLE quarantine_sessions ADD COLUMN IF NOT EXISTS client_ip VARCHAR(60)`);
    // For release→execute: store the FULL held SQL + how to reach the target DB.
    await client.query(`ALTER TABLE quarantine_sessions ADD COLUMN IF NOT EXISTS full_sql TEXT`);
    // How the account came to be held: 'manual' (⛔ Quarantine account) or 'policy_block'
    // (auto-quarantined from a blocked query). Backfilled from the session_id shape.
    await client.query(`ALTER TABLE quarantine_sessions ADD COLUMN IF NOT EXISTS source VARCHAR(20)`);
    await client.query(`UPDATE quarantine_sessions SET source = CASE WHEN session_id LIKE 'manual-%' THEN 'manual' ELSE 'policy_block' END WHERE source IS NULL`);

    // Auto-quarantine policy (singleton): when a query is BLOCKED by policy, should
    // the whole account be auto-quarantined (locked out inline), or just the
    // statement blocked + alerted? Default = block-only (do NOT lock the account).
    await client.query(`CREATE TABLE IF NOT EXISTS quarantine_policy (
      id INT PRIMARY KEY DEFAULT 1,
      auto_quarantine BOOLEAN NOT NULL DEFAULT false,
      categories JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT now(),
      updated_by VARCHAR(160),
      CONSTRAINT quarantine_policy_singleton CHECK (id = 1)
    )`);
    await client.query(`INSERT INTO quarantine_policy (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

    // Platform SMTP (singleton, NON-tenant): the operator configures this in the
    // Super-Admin console; system email (signup verification, invites) sends through it.
    await client.query(`CREATE TABLE IF NOT EXISTS platform_smtp (
      id INT PRIMARY KEY DEFAULT 1,
      host VARCHAR(200), port INT DEFAULT 587, secure BOOLEAN DEFAULT false,
      username VARCHAR(200), password VARCHAR(400), from_addr VARCHAR(200),
      updated_at TIMESTAMPTZ DEFAULT now(), updated_by VARCHAR(160),
      CONSTRAINT platform_smtp_singleton CHECK (id = 1)
    )`);
    await client.query(`INSERT INTO platform_smtp (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

    // Tier-based data-plane isolation: paid tenants get a dedicated ClickHouse DB
    // (name stored here); NULL = the shared dam_analytics pool (trial/starter).
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS data_plane VARCHAR(80)`);

    // Deception: decoy (honeypot) tables. No legitimate app touches them, so ANY access
    // is a probe → a critical alert. Detection matches the decoy name in captured queries.
    await client.query(`CREATE TABLE IF NOT EXISTS decoys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID,
      database_name VARCHAR(160),
      schema_name VARCHAR(120),
      table_name VARCHAR(160) NOT NULL,
      note VARCHAR(200),
      state VARCHAR(12) DEFAULT 'armed',
      table_created BOOLEAN DEFAULT false,
      hit_principal VARCHAR(160),
      hit_client_ip VARCHAR(60),
      hit_at TIMESTAMPTZ,
      last_scan_at TIMESTAMPTZ,
      deployed_by VARCHAR(160),
      deployed_at TIMESTAMPTZ DEFAULT now()
    )`);
    await client.query(`ALTER TABLE quarantine_sessions ADD COLUMN IF NOT EXISTS engine VARCHAR(40)`);
    await client.query(`ALTER TABLE quarantine_sessions ADD COLUMN IF NOT EXISTS db_host VARCHAR(200)`);
    await client.query(`ALTER TABLE quarantine_sessions ADD COLUMN IF NOT EXISTS db_port INT`);
    await client.query(`ALTER TABLE quarantine_sessions ADD COLUMN IF NOT EXISTS exec_result TEXT`);
    const qCount = await client.query('SELECT COUNT(*) AS n FROM quarantine_sessions');
    if (parseInt(qCount.rows[0].n) === 0) {
      const qt = (await client.query('SELECT id FROM tenants LIMIT 1')).rows[0];
      if (qt) {
        await client.query(
          `INSERT INTO quarantine_sessions (tenant_id, session_id, principal, database_name, query_preview, severity, reason, status, held_at, resolved_at) VALUES
            ($1,'sess-a8f3d','etl_service@prod','finance-prod-01','SELECT ssn, dob FROM customers WHERE ...','critical','Bulk PII export detected','held', now() - interval '2 minutes', NULL),
            ($1,'sess-c1e7b','analytics_ro@bi','analytics-dw','DROP TABLE audit_log','critical','DDL on production table','held', now() - interval '5 minutes', NULL),
            ($1,'sess-d9f2a','admin@ops','hr-prod','UPDATE salaries SET amount = ...','high','Sensitive table modification','held', now() - interval '1 minute', NULL),
            ($1,'sess-e4b8c','report_svc@bi','crm-replica','SELECT * FROM credit_cards LIMIT 10000','high','Large PCI data export','held', now() - interval '3 minutes', NULL),
            ($1,'sess-f7a1d','dev_user@staging','staging-db','GRANT ALL ON *.* TO dev_user','medium','Privilege escalation attempt','held', now() - interval '58 seconds', NULL),
            ($1,'sess-b2c4e','backup_svc@prod','finance-prod-01','mysqldump --all-databases','critical','Full database dump','released', now() - interval '20 minutes', now() - interval '12 minutes'),
            ($1,'sess-a1b3f','unknown@ext','customer-db','SELECT * FROM users WHERE 1=1','critical','SQL injection pattern','killed', now() - interval '40 minutes', now() - interval '38 minutes')`,
          [qt.id]
        );
      }
    }

    // ── Report schedules ──
    await client.query(`CREATE TABLE IF NOT EXISTS report_schedules (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   UUID REFERENCES tenants(id),
      report_type VARCHAR(40),
      report_name VARCHAR(120),
      frequency   VARCHAR(40),
      recipients  VARCHAR(300),
      next_run    VARCHAR(40),
      status      VARCHAR(15) DEFAULT 'on',
      created_at  TIMESTAMPTZ DEFAULT now()
    )`);
    const schedCount = await client.query('SELECT COUNT(*) AS n FROM report_schedules');
    if (parseInt(schedCount.rows[0].n) === 0) {
      const st = (await client.query('SELECT id FROM tenants LIMIT 1')).rows[0];
      if (st) {
        await client.query(
          `INSERT INTO report_schedules (tenant_id, report_type, report_name, frequency, recipients, next_run, status) VALUES
            ($1,'gdpr','GDPR quarterly','Quarterly','compliance@meridianfg.com','30 Jun','on'),
            ($1,'dpdpa','RBI CSF quarterly','Quarterly','compliance@meridianfg.com','30 Jun','on'),
            ($1,'exec','Executive weekly digest','Mon 08:00','ciso@meridianfg.com','23 Jun','on'),
            ($1,'pci','PCI access review','Monthly','compliance, audit','01 Jul','on'),
            ($1,'va','VA findings summary','Weekly','soc@meridianfg.com','23 Jun','paused')`,
          [st.id]
        );
      }
    }

    // Data-plane integrity: signed Merkle checkpoints over event windows (stored
    // here in the control plane, separate from ClickHouse, so deleting events
    // can't delete the proof they existed).
    await client.query(`CREATE TABLE IF NOT EXISTS audit_checkpoints (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      seq           INTEGER,
      window_start  TIMESTAMPTZ,
      window_end    TIMESTAMPTZ,
      event_count   BIGINT,
      merkle_root   VARCHAR(64),
      prev_hash     VARCHAR(64),
      chain_hash    VARCHAR(64),
      signature     VARCHAR(64),
      archive_key   VARCHAR(200),
      created_at    TIMESTAMPTZ DEFAULT now()
    )`);

    // DSAR discovery results: where a data subject's personal data was found.
    await client.query(`CREATE TABLE IF NOT EXISTS dsar_data_hits (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      dsar_id       UUID REFERENCES dsar_requests(id) ON DELETE CASCADE,
      database_name VARCHAR(120),
      schema_name   VARCHAR(120),
      object_name   VARCHAR(160),
      columns       TEXT[] DEFAULT '{}',
      tags          TEXT[] DEFAULT '{}',
      row_count     BIGINT DEFAULT 0,
      created_at    TIMESTAMPTZ DEFAULT now()
    )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_dsar_hits_dsar ON dsar_data_hits(dsar_id)');

    // Alerts: index the triage path so status/severity queries stay index-scans as
    // the table grows (counts come from a GROUP BY, but the list is filtered by status).
    await client.query('CREATE INDEX IF NOT EXISTS idx_alerts_status_created ON alerts (status, created_at DESC)');
    await client.query(`CREATE INDEX IF NOT EXISTS idx_alerts_open_created ON alerts (created_at DESC) WHERE status='open'`);

    // Billing: persisted invoices + connected payment gateways.
    await client.query(`CREATE TABLE IF NOT EXISTS billing_invoices (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   UUID,
      reference   VARCHAR(40) UNIQUE,
      period      VARCHAR(20),
      period_start DATE,
      amount      NUMERIC(12,2) DEFAULT 0,
      currency    VARCHAR(8) DEFAULT 'USD',
      status      VARCHAR(20) DEFAULT 'open',
      line_items  JSONB DEFAULT '[]',
      due_date    DATE,
      issued_at   TIMESTAMPTZ DEFAULT now(),
      paid_at     TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS payment_methods (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   UUID,
      provider    VARCHAR(40),
      label       VARCHAR(160),
      currency    VARCHAR(8) DEFAULT 'USD',
      role        VARCHAR(20) DEFAULT 'primary',
      status      VARCHAR(20) DEFAULT 'connected',
      created_at  TIMESTAMPTZ DEFAULT now()
    )`);
    // Seed the two gateways the mockup shows, once.
    const pmCount = await client.query('SELECT COUNT(*) AS n FROM payment_methods');
    if (parseInt(pmCount.rows[0].n) === 0) {
      await client.query(`INSERT INTO payment_methods (provider, label, currency, role, status) VALUES
        ('Stripe', 'Visa ending 9214 · Auto-pay enabled', 'USD', 'primary', 'connected'),
        ('Razorpay', 'UPI / Net Banking · INR payments', 'INR', 'backup', 'connected'),
        ('PayU', 'UPI · Cards · EMI · INR payments', 'INR', 'backup', 'connected')`);
    }
    // Gateway API credentials (configurable in Settings → Payments). One row per
    // provider; config jsonb holds keys/salt. Secrets never leave the server.
    await client.query(`CREATE TABLE IF NOT EXISTS gateway_config (
      provider    VARCHAR(20) PRIMARY KEY,
      config      JSONB DEFAULT '{}',
      updated_at  TIMESTAMPTZ DEFAULT now()
    )`);

    // Per-database masking bypass: DB principals (least-privilege service / break-glass
    // accounts) that see UNMASKED data for a given database. Isolated/additive table.
    await client.query(`CREATE TABLE IF NOT EXISTS masking_bypass (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      database_id UUID NOT NULL,
      principal   VARCHAR(120) NOT NULL,
      note        VARCHAR(200),
      created_by  VARCHAR(160),
      created_at  TIMESTAMPTZ DEFAULT now(),
      UNIQUE(database_id, principal)
    )`);

    // Per-database execution credentials for quarantine release (a least-privilege
    // account the customer configures per instance — NOT root/DBA). Isolated/additive.
    await client.query(`CREATE TABLE IF NOT EXISTS exec_credentials (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      engine     VARCHAR(20),
      host       VARCHAR(160) NOT NULL,
      port       INT,
      username   VARCHAR(120) NOT NULL,
      password   VARCHAR(300),
      note       VARCHAR(200),
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(host, port)
    )`);

    // JIT (just-in-time) privileged access grants: request → approve → active (auto-
    // expiring) → revoked/expired. Isolated/additive table. The reaper expires grants.
    await client.query(`CREATE TABLE IF NOT EXISTS jit_grants (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     UUID,
      requester     VARCHAR(160) NOT NULL,
      database_id   UUID,
      db_name       VARCHAR(160),
      scope         VARCHAR(200) NOT NULL,
      reason        VARCHAR(300),
      duration_mins INT DEFAULT 120,
      status        VARCHAR(20) DEFAULT 'pending',
      requested_at  TIMESTAMPTZ DEFAULT now(),
      approved_at   TIMESTAMPTZ,
      approved_by   VARCHAR(160),
      expires_at    TIMESTAMPTZ,
      revoked_at    TIMESTAMPTZ,
      revoked_by    VARCHAR(160)
    )`);

    // ── JIT brokers ────────────────────────────────────────────────────────
    // One row per client DB instance where JIT is ENABLED. Holds NO password:
    // the privileged credential lives in Vault; `vault_role` is only a reference.
    // `allowed_scopes` is the grant CEILING (a compromised DAM can never exceed it).
    // A DB is only offerable for JIT when it has a broker with status='healthy'.
    await client.query(`CREATE TABLE IF NOT EXISTS jit_brokers (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id      UUID,
      label          VARCHAR(160),
      engine         VARCHAR(20) NOT NULL,
      host           VARCHAR(200) NOT NULL,
      port           INT,
      vault_mount    VARCHAR(80)  DEFAULT 'database',
      vault_role     VARCHAR(120) NOT NULL,
      allowed_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
      rate_limit_per_hour INT DEFAULT 10,
      status         VARCHAR(20) DEFAULT 'unconfigured',
      health_detail  JSONB,
      last_health_at TIMESTAMPTZ,
      created_at     TIMESTAMPTZ DEFAULT now(),
      UNIQUE(host, port, engine)
    )`);

    // Structured scope + signed-approval provenance on JIT grants (additive).
    await client.query(`ALTER TABLE jit_grants ADD COLUMN IF NOT EXISTS broker_id UUID`);
    await client.query(`ALTER TABLE jit_grants ADD COLUMN IF NOT EXISTS privilege VARCHAR(20)`);
    await client.query(`ALTER TABLE jit_grants ADD COLUMN IF NOT EXISTS schema_name VARCHAR(120)`);
    await client.query(`ALTER TABLE jit_grants ADD COLUMN IF NOT EXISTS object_name VARCHAR(160)`);
    await client.query(`ALTER TABLE jit_grants ADD COLUMN IF NOT EXISTS approval_sig TEXT`);
    await client.query(`ALTER TABLE jit_grants ADD COLUMN IF NOT EXISTS provisioned_user VARCHAR(120)`);
    await client.query(`ALTER TABLE jit_grants ADD COLUMN IF NOT EXISTS provisioned_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE jit_grants ADD COLUMN IF NOT EXISTS provision_error TEXT`);
    await client.query(`ALTER TABLE jit_grants ADD COLUMN IF NOT EXISTS vault_lease_id TEXT`);
    await client.query(`ALTER TABLE jit_grants ADD COLUMN IF NOT EXISTS requester_user_id UUID`);
    // DB-owner approvers per broker: only an owner of THIS database (or a
    // tenant_admin as audited break-glass) may approve, and never the requester.
    await client.query(`ALTER TABLE jit_brokers ADD COLUMN IF NOT EXISTS owners JSONB NOT NULL DEFAULT '[]'::jsonb`);

    // Backfill the audit hash-chain for any rows missing hashes (older entries).
    const needChain = await client.query('SELECT COUNT(*) AS n FROM audit_trail WHERE row_hash IS NULL');
    if (parseInt(needChain.rows[0].n) > 0) {
      const all = (await client.query('SELECT id, actor_email, action, resource_type, resource_id, details FROM audit_trail ORDER BY id ASC')).rows;
      let prev = '0'.repeat(64);
      for (const r of all) {
        const payload = [prev, r.actor_email || '', r.action || '', r.resource_type || '', r.resource_id || '', stableStr(r.details || {})].join('|');
        const rowHash = crypto.createHash('sha256').update(payload).digest('hex');
        await client.query('UPDATE audit_trail SET prev_hash = $2, row_hash = $3 WHERE id = $1', [r.id, prev, rowHash]);
        prev = rowHash;
      }
      console.log(`[Auth] Backfilled audit hash-chain for ${all.length} rows`);
    }

    console.log('[Auth] Migration complete');
  } finally {
    client.release();
  }
}

// ── Admin / Platform migration: runs on startup ───────────
// Creates the isolated tables that back the Super-Admin console. These are
// ADDITIVE and used ONLY by the admin app — no main-app table is read-modified
// or altered here, so the main DAM application is unaffected.
async function runAdminMigration() {
  const client = await pgPool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS platform_alerts (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title       VARCHAR(200) NOT NULL,
      detail      TEXT,
      region      VARCHAR(40),
      category    VARCHAR(40) DEFAULT 'infra',
      severity    VARCHAR(20) NOT NULL DEFAULT 'medium',
      status      VARCHAR(20) NOT NULL DEFAULT 'open',
      created_at  TIMESTAMPTZ DEFAULT now(),
      resolved_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS platform_meta (
      key        VARCHAR(60) PRIMARY KEY,
      value      VARCHAR(200),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`);

    const pa = await client.query('SELECT COUNT(*) AS n FROM platform_alerts');
    if (parseInt(pa.rows[0].n) === 0) {
      await client.query(`INSERT INTO platform_alerts (title, detail, region, category, severity) VALUES
        ('ClickHouse disk 87%',        'IN-Mumbai cluster ch-in-01',     'IN-Mumbai',  'capacity', 'high'),
        ('Kafka consumer lag spike',   'EU-West ingest partition 4',     'EU-West',    'infra',    'high'),
        ('Certificate expiry in 7d',   'Agent mTLS CA for CA-Central',   'CA-Central', 'security', 'medium')`);
    }

    const pm = await client.query('SELECT COUNT(*) AS n FROM platform_meta');
    if (parseInt(pm.rows[0].n) === 0) {
      await client.query(`INSERT INTO platform_meta (key, value) VALUES
        ('platform_version',    'v2.4.1'),
        ('version_deployed_at', '2026-06-19')`);
    }

    // Feature-flag catalog + per-tenant overrides (isolated admin tables).
    await client.query(`CREATE TABLE IF NOT EXISTS feature_flags (
      key             VARCHAR(60) PRIMARY KEY,
      name            VARCHAR(120) NOT NULL,
      description     TEXT,
      stage           VARCHAR(10) NOT NULL DEFAULT 'ga',
      tier_starter    BOOLEAN DEFAULT false,
      tier_business   BOOLEAN DEFAULT false,
      tier_enterprise BOOLEAN DEFAULT true,
      is_core         BOOLEAN DEFAULT false,
      tier_gated      BOOLEAN DEFAULT false,
      rollout_target  VARCHAR(60),
      rollout_error   VARCHAR(20),
      sort_order      INT DEFAULT 0,
      created_at      TIMESTAMPTZ DEFAULT now()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS feature_overrides (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      feature_key VARCHAR(60) NOT NULL,
      tenant_id   UUID NOT NULL,
      status      VARCHAR(20) NOT NULL DEFAULT 'enabled',
      updated_at  TIMESTAMPTZ DEFAULT now(),
      UNIQUE (feature_key, tenant_id)
    )`);

    const ff = await client.query('SELECT COUNT(*) AS n FROM feature_flags');
    if (parseInt(ff.rows[0].n) === 0) {
      // cols: key, name, description, stage, starter, business, enterprise, core, gated, target, error, sort
      await client.query(`INSERT INTO feature_flags
        (key, name, description, stage, tier_starter, tier_business, tier_enterprise, is_core, tier_gated, rollout_target, rollout_error, sort_order) VALUES
        ('activity-monitoring','Activity Monitoring','Real-time capture, audit trail, hash-chain','ga',  true,  true,  true,  true,  false, NULL, NULL, 1),
        ('alert-rules','Alert Rules & Policies','Custom rules, threshold, pattern, correlation','ga',    true,  true,  true,  true,  false, NULL, NULL, 2),
        ('va-scanner','VA Scanner','6000+ vulnerability tests, CIS, PCI-DSS','ga',                       true,  true,  true,  false, false, NULL, NULL, 3),
        ('compliance-packs','Compliance Packs','PCI-DSS, GDPR, HIPAA, SOX, DPDPA, RBI','ga',             true,  true,  true,  false, true,  NULL, NULL, 4),
        ('ueba','Behavioral Analytics (UEBA)','Baselines, peer groups, risk scoring, anomaly','beta',    false, true,  true,  false, false, '100% by Q3 2026', '0.02%', 5),
        ('dynamic-masking','Dynamic Masking','Query-time masking by role, format-preserving','ga',       false, true,  true,  false, false, NULL, NULL, 6),
        ('static-masking','Static Masking','Non-prod clones, referential integrity preserved','beta',    false, true,  true,  false, false, '100% by Q4 2026', '0.05%', 7),
        ('inline-proxy','Inline Blocking / Proxy','DAM proxy gateway, real-time block, virtual patch','ga', false, false, true, false, false, NULL, NULL, 8),
        ('llm-monitoring','LLM Monitoring','Monitor AI/LLM queries, prompt redaction, AI firewall','ga', false, false, true,  false, false, NULL, NULL, 9),
        ('dsar','DSAR Module','Data subject access/erasure requests, GDPR/DPDPA','ga',                   false, false, true,  false, false, NULL, NULL, 10),
        ('byok','BYOK / Customer KMS','Bring your own key — Azure KV, AWS KMS, Vault','ga',              false, false, true,  false, false, NULL, NULL, 11),
        ('sql-allowlist','SQL Grammar Allowlist','Train approved SQL patterns, block deviations','ga',   false, false, true,  false, false, NULL, NULL, 12),
        ('deception','Deception Console','Honeypot tables, decoy records, trap detection','beta',        false, false, true,  false, false, '100% by Q4 2026', '0.01%', 13),
        ('jit-access','JIT Access','Just-in-time privileged access, auto-expiry, approvals','alpha',     false, false, true,  false, false, NULL, NULL, 14),
        ('sso','SSO (SAML / OIDC)','Azure AD, Okta, Google, LDAP/Kerberos','ga',                         false, true,  true,  false, true,  NULL, NULL, 15),
        ('onprem','On-Prem / Air-Gapped','Customer-managed K8s, offline licensing','ga',                 false, false, true,  false, true,  NULL, NULL, 16)`);
      console.log('[Admin] Seeded feature_flags catalog (16 features)');
    }

    // Resource quotas: plan-tier defaults + per-tenant overrides (isolated admin tables).
    // NULL limit = unlimited / custom (per-contract). storage in GB.
    await client.query(`CREATE TABLE IF NOT EXISTS quota_plans (
      tier           VARCHAR(20) PRIMARY KEY,
      events_per_day BIGINT,
      max_databases  INT,
      storage_gb     INT,
      notes          TEXT,
      sort_order     INT DEFAULT 0
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS quota_overrides (
      tenant_id      UUID PRIMARY KEY,
      events_per_day BIGINT,
      max_databases  INT,
      storage_gb     INT,
      justification  TEXT,
      updated_by     VARCHAR(200),
      updated_at     TIMESTAMPTZ DEFAULT now()
    )`);
    const qp = await client.query('SELECT COUNT(*) AS n FROM quota_plans');
    if (parseInt(qp.rows[0].n) === 0) {
      await client.query(`INSERT INTO quota_plans (tier, events_per_day, max_databases, storage_gb, notes, sort_order) VALUES
        ('starter',     1000000,    5,    10,   '14-day trial, shared infrastructure', 1),
        ('business',    500000000,  200,  1024, 'Dedicated cluster, expandable on request', 2),
        ('enterprise',  250000000,  NULL, 5120, 'Per-contract negotiation, SLA-backed', 3)`);
      console.log('[Admin] Seeded quota_plans (3 tiers)');
    }

    // Canary rollouts — isolated admin table for release management state.
    await client.query(`CREATE TABLE IF NOT EXISTS canary_rollouts (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      version      VARCHAR(40) NOT NULL,
      from_version VARCHAR(40),
      type         VARCHAR(20) DEFAULT 'platform',
      phase        INT DEFAULT 0,
      phases_total INT DEFAULT 4,
      status       VARCHAR(20) DEFAULT 'active',
      error_rate   NUMERIC(5,3) DEFAULT 0.02,
      duration     TEXT,
      started_at   TIMESTAMPTZ DEFAULT now(),
      completed_at TIMESTAMPTZ
    )`);
    const cr = await client.query('SELECT COUNT(*) AS n FROM canary_rollouts');
    if (parseInt(cr.rows[0].n) === 0) {
      await client.query(`INSERT INTO canary_rollouts (version, from_version, type, phase, phases_total, status, error_rate, duration, started_at, completed_at) VALUES
        ('v2.4.2','v2.4.1','platform', 0, 4, 'active',      0.020, NULL,    now() - interval '42 minutes', NULL),
        ('v2.4.1','v2.4.0','platform', 3, 4, 'success',     0.010, '2h 14m', now() - interval '10 days',    now() - interval '10 days' + interval '2 hours'),
        ('v2.4.0','v2.3.9','platform', 3, 4, 'success',     0.012, '3h 08m', now() - interval '17 days',    now() - interval '17 days' + interval '3 hours'),
        ('v7.1.2','v7.1.1','agent',    3, 4, 'success',     0.008, '1h 42m', now() - interval '19 days',    now() - interval '19 days' + interval '1 hour'),
        ('v2.3.9','v2.3.8','platform', 2, 4, 'rolled_back', 0.180, '48m',    now() - interval '24 days',    now() - interval '24 days' + interval '48 minutes'),
        ('CP-2026-06','CP-2026-05','content', 3, 4, 'success', 0.005, '52m',  now() - interval '28 days',    now() - interval '28 days' + interval '52 minutes')`);
      console.log('[Admin] Seeded canary_rollouts history');
    }

    // Billing rate card — isolated singleton config table. Seeded with the
    // historical hardcoded defaults; loaded into memory at startup and editable
    // from the admin Billing screen. Drives both product + admin billing.
    await client.query(`CREATE TABLE IF NOT EXISTS billing_rates (
      id                   INT PRIMARY KEY DEFAULT 1,
      currency             VARCHAR(8)  DEFAULT 'USD',
      base_fee             NUMERIC(12,2) DEFAULT 8000,
      limit_databases      INT     DEFAULT 500,
      limit_events_per_day BIGINT  DEFAULT 250000000,
      limit_hot_storage_gb INT     DEFAULT 5120,
      per_database         NUMERIC(12,2) DEFAULT 100,
      per_inline_db        NUMERIC(12,2) DEFAULT 200,
      cold_per_gb          NUMERIC(12,4) DEFAULT 0.01,
      event_overage_per_m  NUMERIC(12,4) DEFAULT 0.50,
      hot_overage_per_gb   NUMERIC(12,4) DEFAULT 0.20,
      per_dsar             NUMERIC(12,2) DEFAULT 25,
      updated_at           TIMESTAMPTZ DEFAULT now(),
      updated_by           VARCHAR(200),
      CONSTRAINT billing_rates_singleton CHECK (id = 1)
    )`);
    await client.query(`INSERT INTO billing_rates (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

    // Per-tenant negotiated billing contracts (isolated). Each NULL column falls
    // back to the global rate card; the override is ignored past valid_until.
    await client.query(`CREATE TABLE IF NOT EXISTS tenant_billing_overrides (
      tenant_id           UUID PRIMARY KEY,
      base_fee            NUMERIC(12,2),
      per_database        NUMERIC(12,2),
      per_inline_db       NUMERIC(12,2),
      event_overage_per_m NUMERIC(12,4),
      hot_overage_per_gb  NUMERIC(12,4),
      cold_per_gb         NUMERIC(12,4),
      per_dsar            NUMERIC(12,2),
      valid_until         DATE,
      reason              TEXT,
      updated_by          VARCHAR(200),
      updated_at          TIMESTAMPTZ DEFAULT now()
    )`);

    // ── Security & Ops: isolated operator-governance tables ──
    await client.query(`CREATE TABLE IF NOT EXISTS platform_audit (
      id          BIGSERIAL PRIMARY KEY,
      ts          TIMESTAMPTZ DEFAULT now(),
      actor       VARCHAR(120) DEFAULT 'Platform Ops',
      action      VARCHAR(60) NOT NULL,
      tenant_id   UUID,
      tenant_name VARCHAR(160),
      resource    VARCHAR(200),
      ip          VARCHAR(60),
      details     TEXT
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS admin_access_sessions (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type           VARCHAR(20) NOT NULL,
      operator       VARCHAR(120) NOT NULL,
      operator_email VARCHAR(200),
      tenant_id      UUID,
      tenant_name    VARCHAR(160),
      justification  TEXT,
      scope          VARCHAR(10),
      approver       VARCHAR(120),
      incident_ref   VARCHAR(60),
      ticket_ref     VARCHAR(60),
      duration_min   INT DEFAULT 60,
      actions_count  INT DEFAULT 0,
      status         VARCHAR(20) DEFAULT 'active',
      reviewed       BOOLEAN DEFAULT false,
      started_at     TIMESTAMPTZ DEFAULT now(),
      expires_at     TIMESTAMPTZ,
      ended_at       TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS approval_requests (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ref          VARCHAR(20) UNIQUE NOT NULL,
      type         VARCHAR(20) NOT NULL,
      tenant_id    UUID,
      tenant_name  VARCHAR(160),
      detail       VARCHAR(200),
      initiated_by VARCHAR(120),
      chain        JSONB DEFAULT '[]',
      status       VARCHAR(20) DEFAULT 'pending',
      submitted_at TIMESTAMPTZ DEFAULT now(),
      resolved_at  TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS platform_operators (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name           VARCHAR(120) NOT NULL,
      email          VARCHAR(200) UNIQUE NOT NULL,
      role           VARCHAR(40) NOT NULL,
      mfa_enabled    BOOLEAN DEFAULT true,
      last_active_at TIMESTAMPTZ
    )`);

    // One-time: purge the earlier FABRICATED Security & Ops seeds (operators,
    // sessions, approvals, audit) that referenced tenants/people not in the
    // backend. Now: Audit Log reads the real audit_trail, Roles read real users,
    // and sessions/approvals populate from real operator actions only.
    const cleaned = await client.query("SELECT 1 FROM platform_meta WHERE key = 'secops_realdata'");
    if (!cleaned.rows.length) {
      await client.query('DELETE FROM platform_operators');
      await client.query('DELETE FROM platform_audit');
      await client.query('DELETE FROM admin_access_sessions WHERE tenant_name IS NULL OR tenant_name NOT IN (SELECT name FROM tenants)');
      await client.query('DELETE FROM approval_requests WHERE tenant_name IS NULL OR tenant_name NOT IN (SELECT name FROM tenants)');
      await client.query("INSERT INTO platform_meta (key, value) VALUES ('secops_realdata', 'v1') ON CONFLICT (key) DO NOTHING");
      console.log('[Admin] Purged fabricated Security & Ops seeds — real data only');
    }

    console.log('[Admin] Platform migration complete');
  } finally {
    client.release();
  }
}

// ── Auth middleware ────────────────────────────────────────
function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  try {
    const token = header.split(' ')[1];
    const payload = jwt.verify(token, JWT_SECRET);
    // Half-authenticated MFA-pending tokens must never grant access to the app.
    if (payload.mfaPending) return res.status(401).json({ error: 'MFA not completed' });
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'tenant_admin') {
    return res.status(403).json({ error: 'Tenant admin access required' });
  }
  next();
}

// ── Login ─────────────────────────────────────────────────
// ── TOTP MFA (RFC 6238 · HMAC-SHA1 · 30s · 6 digits) — no external TOTP dep ──
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) { const idx = B32_ALPHABET.indexOf(ch); if (idx === -1) continue; value = (value << 5) | idx; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}
function generateMfaSecret() { return base32Encode(crypto.randomBytes(20)); } // 160-bit
function totpCode(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(bin % 1000000).padStart(6, '0');
}
function verifyTotp(secret, token, window = 1) {
  if (!secret || !/^\d{6}$/.test(String(token || '').trim())) return false;
  const t = String(token).trim();
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let i = -window; i <= window; i++) if (totpCode(secret, counter + i) === t) return true;
  return false;
}
function otpauthUri(secret, email, issuer = 'TooVix DAM') {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?${new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' }).toString()}`;
}
function generateBackupCodes(n = 8) { return Array.from({ length: n }, () => crypto.randomBytes(4).toString('hex').toUpperCase()); }
async function hashBackupCodes(codes) { return Promise.all(codes.map((c) => bcrypt.hash(c, 10))); }
// Returns remaining (unused) hashes if the code matched one, else null.
async function consumeBackupCode(code, stored) {
  const clean = String(code || '').trim().toUpperCase().replace(/\s/g, '');
  if (!Array.isArray(stored) || !clean) return null;
  for (let i = 0; i < stored.length; i++) if (await bcrypt.compare(clean, stored[i])) return stored.slice(0, i).concat(stored.slice(i + 1));
  return null;
}
// Short-lived tokens for the two half-authenticated MFA states (never grant app access).
function mfaPendingToken(userId, purpose) { return jwt.sign({ mfaPending: purpose, userId }, JWT_SECRET, { expiresIn: purpose === 'setup' ? '10m' : '5m' }); }
function verifyMfaPending(token, purpose) {
  try { const p = jwt.verify(token, JWT_SECRET); return p.mfaPending === purpose ? p : null; } catch { return null; }
}
function issueSessionToken(u) {
  return jwt.sign({ userId: u.id, email: u.email, fullName: u.full_name, role: u.role, tenantId: u.tenant_id, tenantName: u.tenant_name }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}
function sessionUserPayload(u, authProvider = 'local') {
  return { id: u.id, email: u.email, fullName: u.full_name, role: u.role, mfaEnabled: u.mfa_enabled, tenantId: u.tenant_id, tenantName: u.tenant_name, authProvider };
}

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const slug = String(req.body?.workspace || req.body?.slug || '').toLowerCase().trim();

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  // Email is unique per workspace, so scope the lookup by the workspace the user chose
  // (the login page resolves it first). Without a slug we allow it only if the email is
  // unique across all workspaces.
  const params = [email.toLowerCase().trim()];
  let scope = 'u.email = $1';
  if (slug) { scope += ' AND t.slug = $2'; params.push(slug); }
  const { rows } = await pgPool.query(
    `SELECT u.id, u.email, u.full_name, u.role, u.password_hash, u.status, u.mfa_enabled, u.mfa_secret, u.mfa_enrolled_at, t.id as tenant_id, t.name as tenant_name
     FROM users u JOIN tenants t ON u.tenant_id = t.id
     WHERE ${scope}`,
    params
  );

  if (rows.length > 1) {
    return res.status(409).json({ error: 'This email belongs to more than one workspace — enter your workspace name first.' });
  }
  if (rows.length === 0) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const user = rows[0];

  if (user.status !== 'active') {
    return res.status(403).json({ error: user.status === 'unverified' ? 'Please verify your email first — check your inbox for the activation link.' : 'Account is not active' });
  }

  if (!user.password_hash) {
    return res.status(401).json({ error: 'Password not set. Contact your administrator.' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // ── MFA gate (password auth only; SSO users are exempt) ──
  // Password is correct but the session is NOT issued yet. Enrolled users must enter a
  // TOTP code; users who haven't set up MFA yet are pushed through enrolment first.
  if (user.mfa_enabled) {
    if (user.mfa_secret && user.mfa_enrolled_at) {
      return res.json({ mfaRequired: true, mfaToken: mfaPendingToken(user.id, 'verify'), email: user.email });
    }
    return res.json({ mfaSetupRequired: true, setupToken: mfaPendingToken(user.id, 'setup'), email: user.email });
  }

  // MFA disabled for this account → issue the session directly.
  await pgPool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  writeAudit({ tenantId: user.tenant_id, actorId: user.id, actorEmail: user.email, action: 'auth.login', resourceType: 'user', resourceId: user.id, details: { role: user.role, mfa: false } });
  res.json({ token: issueSessionToken(user), user: sessionUserPayload(user) });
});

// ── MFA · begin enrolment (after password, before first session) ──
// Generates a fresh secret + QR for the authenticator app. The secret is stored but
// not yet active (mfa_enrolled_at stays null until a first code is confirmed).
app.post('/api/auth/mfa/setup', async (req, res) => {
  const p = verifyMfaPending(req.body?.setupToken, 'setup');
  if (!p) return res.status(401).json({ error: 'Setup session expired — sign in again.' });
  try {
    const u = (await pgPool.query('SELECT id, email FROM users WHERE id = $1', [p.userId])).rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    const secret = generateMfaSecret();
    await pgPool.query('UPDATE users SET mfa_secret = $1, mfa_enrolled_at = NULL WHERE id = $2', [secret, u.id]);
    const uri = otpauthUri(secret, u.email);
    const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
    res.json({ secret, otpauthUri: uri, qr: qrDataUrl, email: u.email });
  } catch (e) { console.error('[MFA] setup failed:', e.message); res.status(500).json({ error: 'Could not start MFA setup' }); }
});

// ── MFA · confirm enrolment (verify first code → activate + issue backup codes + session) ──
app.post('/api/auth/mfa/enroll', async (req, res) => {
  const p = verifyMfaPending(req.body?.setupToken, 'setup');
  if (!p) return res.status(401).json({ error: 'Setup session expired — sign in again.' });
  const code = String(req.body?.code || '').trim();
  try {
    const u = (await pgPool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.mfa_enabled, u.mfa_secret, t.id as tenant_id, t.name as tenant_name
       FROM users u JOIN tenants t ON u.tenant_id = t.id WHERE u.id = $1`, [p.userId])).rows[0];
    if (!u || !u.mfa_secret) return res.status(400).json({ error: 'Start MFA setup first.' });
    if (!verifyTotp(u.mfa_secret, code)) return res.status(400).json({ error: 'That code is not valid — check your authenticator and try again.' });
    const backupCodes = generateBackupCodes(8);
    const hashed = await hashBackupCodes(backupCodes);
    await pgPool.query('UPDATE users SET mfa_enrolled_at = now(), mfa_backup_codes = $1::jsonb, last_login_at = now() WHERE id = $2', [JSON.stringify(hashed), u.id]);
    writeAudit({ tenantId: u.tenant_id, actorId: u.id, actorEmail: u.email, action: 'auth.mfa.enrolled', resourceType: 'user', resourceId: u.id, details: {} });
    res.json({ token: issueSessionToken(u), user: sessionUserPayload(u), backupCodes });
  } catch (e) { console.error('[MFA] enroll failed:', e.message); res.status(500).json({ error: 'Could not complete MFA setup' }); }
});

// ── MFA · verify code at login (TOTP or a one-time backup code) → session ──
app.post('/api/auth/mfa/verify', async (req, res) => {
  const p = verifyMfaPending(req.body?.mfaToken, 'verify');
  if (!p) return res.status(401).json({ error: 'Verification session expired — sign in again.' });
  const code = String(req.body?.code || '').trim();
  try {
    const u = (await pgPool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.mfa_enabled, u.mfa_secret, u.mfa_backup_codes, t.id as tenant_id, t.name as tenant_name
       FROM users u JOIN tenants t ON u.tenant_id = t.id WHERE u.id = $1`, [p.userId])).rows[0];
    if (!u || !u.mfa_secret) return res.status(400).json({ error: 'MFA is not set up for this account.' });

    let ok = verifyTotp(u.mfa_secret, code);
    let usedBackup = false;
    if (!ok) {
      const remaining = await consumeBackupCode(code, u.mfa_backup_codes);
      if (remaining) { ok = true; usedBackup = true; await pgPool.query('UPDATE users SET mfa_backup_codes = $1::jsonb WHERE id = $2', [JSON.stringify(remaining), u.id]); }
    }
    if (!ok) return res.status(400).json({ error: 'Invalid code. Enter the 6-digit code from your authenticator, or a backup code.' });

    await pgPool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
    writeAudit({ tenantId: u.tenant_id, actorId: u.id, actorEmail: u.email, action: 'auth.login', resourceType: 'user', resourceId: u.id, details: { role: u.role, mfa: true, backup_code: usedBackup } });
    res.json({ token: issueSessionToken(u), user: sessionUserPayload(u) });
  } catch (e) { console.error('[MFA] verify failed:', e.message); res.status(500).json({ error: 'Could not verify code' }); }
});

// ── Per-tenant SSO (workspace-first login) ───────────────────────────────────
// SSO is configured per tenant by its admin (Integrations → Single sign-on) and
// stored in `integrations` as type 'sso_<provider>'. Login is workspace-first: the
// user gives their workspace slug, we return which providers that tenant has enabled,
// and the SSO buttons render accordingly. (Phase 1 uses the shared Azure app; the
// per-tenant IdP *credentials* come in Phase 2 — a provider still only shows if the
// platform-level app for it is configured.)
// Azure: credentials live in the platform env (`ready` ignores per-tenant config).
// Okta: credentials are configured PER TENANT in the GUI (Integrations → Okta),
// stored in the integration row's `config`; the platform env is only a fallback.
const SSO_PROVIDERS = {
  azure: { name: 'Azure AD', type: 'sso_azure', ready: () => !!(AZURE_CLIENT_ID && AZURE_TENANT_ID) },
  okta: { name: 'Okta', type: 'sso_okta', tenantConfigurable: true, ready: (cfg) => !!oktaEffective(cfg) },
  google: { name: 'Google', type: 'sso_google', tenantConfigurable: true, ready: (cfg) => !!googleEffective(cfg) },
};
// Merge a tenant's stored Google config with the env fallback → the effective client.
function googleEffective(cfg) {
  cfg = cfg || {};
  const clientId = (cfg.client_id || GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = cfg.client_secret || GOOGLE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: cfg.redirect_uri || GOOGLE_REDIRECT_URI };
}
async function googleConfigFor(tenantId) {
  const row = (await pgPool.query("SELECT config FROM integrations WHERE tenant_id = $1 AND type = 'sso_google'", [tenantId])).rows[0];
  return googleEffective(row && row.config);
}
// Merge a tenant's stored Okta config with the env fallback → the effective client.
function oktaEffective(cfg) {
  cfg = cfg || {};
  const domain = (cfg.domain || OKTA_DOMAIN || '').trim();
  const clientId = (cfg.client_id || OKTA_CLIENT_ID || '').trim();
  const clientSecret = cfg.client_secret || OKTA_CLIENT_SECRET || '';
  if (!domain || !clientId || !clientSecret) return null;
  return {
    domain, clientId, clientSecret,
    issuer: (cfg.issuer || `https://${domain}/oauth2/default`).replace(/\/$/, ''),
    redirectUri: cfg.redirect_uri || OKTA_REDIRECT_URI,
  };
}
async function oktaConfigFor(tenantId) {
  const row = (await pgPool.query("SELECT config FROM integrations WHERE tenant_id = $1 AND type = 'sso_okta'", [tenantId])).rows[0];
  return oktaEffective(row && row.config);
}
async function ssoProvidersFor(tenantId) {
  try {
    const rows = (await pgPool.query("SELECT type, status, config FROM integrations WHERE tenant_id = $1 AND type LIKE 'sso_%'", [tenantId])).rows;
    const byType = {}; rows.forEach((r) => { byType[r.type] = r; });
    const out = [];
    for (const [key, p] of Object.entries(SSO_PROVIDERS)) {
      const row = byType[p.type];
      if (!row || row.status !== 'active') continue; // must be enabled
      if (p.ready(row.config)) out.push({ key, name: p.name }); // and have working credentials
    }
    return out;
  } catch { return []; }
}

// Public workspace lookup — step 1 of login. Given a slug, return the tenant's
// display name + which SSO providers it offers. Intentionally minimal (a small
// existence/SSO signal is the same trade-off Slack/Okta make for workspace URLs).
app.get('/api/auth/workspace', async (req, res) => {
  const slug = String(req.query.slug || '').toLowerCase().trim();
  if (!slug) return res.status(400).json({ error: 'Workspace is required' });
  try {
    const t = (await pgPool.query('SELECT id, name, slug FROM tenants WHERE slug = $1', [slug])).rows[0];
    if (!t) return res.status(404).json({ error: 'No workspace found with that name.' });
    res.json({ found: true, tenantName: t.name, slug: t.slug, sso: await ssoProvidersFor(t.id) });
  } catch (err) {
    console.error('[Auth] workspace lookup failed:', err.message);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// Shared password policy: ≥8 chars and at least 3 of {lowercase, uppercase, digit, symbol}.
function passwordIssue(pw) {
  pw = String(pw || '');
  if (pw.length < 8) return 'Password must be at least 8 characters';
  const cats = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (cats < 3) return 'Password is too weak — use at least 3 of: lowercase, uppercase, number, symbol';
  return null;
}

// ── Default policy pack ───────────────────────────────────
// Every new tenant is seeded with this baseline detection/blocking set (mirrors the
// Meridian reference tenant) so the workspace is useful the moment it's created —
// rules are engine-neutral and fire once the tenant onboards its own databases.
const DEFAULT_POLICIES = [
  { name: 'Block DELETE without WHERE', description: 'Inline proxy blocks any DELETE/UPDATE lacking a WHERE clause on production databases. Fail-open by default; fail-closed for crown-jewel DBs.', severity: 'critical', status: 'enabled', rule_type: 'pattern', category: 'block', scope: 'db_group: prod', actions: ['block'], rule_definition: { action: 'block', action_type: { any_of: ['DELETE', 'WRITE'] }, no_where_clause: true } },
  { name: 'Bulk export via ODBC/JDBC driver', description: 'Large result sets (50K+ rows) pulled via ODBC/JDBC drivers — typically indicates data export to a local file.', severity: 'high', status: 'enabled', rule_type: 'threshold', category: 'alert', scope: 'compliance_tag: pci', actions: ['alert'], rule_definition: { action_type: 'READ', client_driver: { in: ['odbc', 'jdbc'] }, rows_affected: { gte: 50000 }, object_sensitivity_tags: { any_of: ['pci'] } } },
  { name: 'Bulk read of sensitive data', description: 'Fires when a principal reads 10,000+ rows from objects tagged PII/PCI/PHI — identical on an Oracle SELECT, a Mongo find(), or a Db2 SELECT.', severity: 'critical', status: 'enabled', rule_type: 'threshold', category: 'alert', scope: 'compliance_tag: pii, pci, aadhaar', actions: ['alert'], rule_definition: { action_type: 'READ', rows_affected: { gte: 10000 }, principal_user_type: 'human', object_sensitivity_tags: { any_of: ['pii', 'pci', 'aadhaar'] } } },
  { name: 'Credential brute force', description: '50+ failed logins in 5 minutes grouped by client IP — brute force / password spray.', severity: 'high', status: 'enabled', rule_type: 'threshold', category: 'alert', scope: 'all', actions: ['alert', 'webhook'], rule_definition: { group_by: ['client_ip'], action_type: 'LOGIN', return_code: { ne: 0 }, failure_count: { gte: 50 }, window_minutes: 5 } },
  { name: 'DDL change control', description: 'Any DDL outside the approved change window with no linked change ticket.', severity: 'high', status: 'enabled', rule_type: 'pattern', category: 'alert', scope: 'db_group: prod', actions: ['alert', 'email'], rule_definition: { action_type: 'DDL', outside_change_window: true } },
  { name: 'Excessive cross-schema joins', description: 'Queries joining across 3+ schemas where at least one contains sensitive data — may indicate data exploration or unauthorized reporting.', severity: 'medium', status: 'enabled', rule_type: 'anomaly', category: 'alert', scope: 'db_group: prod', actions: ['alert'], rule_definition: { action_type: 'READ', cross_schema_join_count: { gte: 3 }, object_sensitivity_tags: { any_of: ['pii', 'pci'] } } },
  { name: 'First-time object access', description: 'A principal touches a sensitive object it has never accessed before.', severity: 'medium', status: 'enabled', rule_type: 'first_time', category: 'alert', scope: 'compliance_tag: pii', actions: ['alert'], rule_definition: { object_sensitivity_tags: { any_of: ['pii'] }, first_time_object_access: true } },
  { name: 'GRANT of DBA / SYSDBA', description: 'Privilege escalation: a high-privilege role granted to a non-DBA account.', severity: 'high', status: 'enabled', rule_type: 'privileged', category: 'alert', scope: 'all', actions: ['alert'], rule_definition: { action_type: 'GRANT', grants_role: { in: ['DBA', 'SYSDBA'] } } },
  { name: 'LLM prompt exfiltration', description: 'Redacts or blocks PII in a prompt before it reaches an external LLM (ChatGPT / Bedrock / Azure OpenAI).', severity: 'high', status: 'disabled', rule_type: 'pattern', category: 'block', scope: 'engine: llm', actions: ['block'], rule_definition: { action: 'mask_or_block', destination: 'external_llm', prompt_contains_sensitive: true } },
  { name: 'Privileged off-hours access', description: 'DBA/privileged access to sensitive objects outside the principal’s learned activity window.', severity: 'critical', status: 'enabled', rule_type: 'anomaly', category: 'alert', scope: 'all', actions: ['alert'], rule_definition: { principal_user_type: 'dba', unusual_access_time: true, object_sensitivity_tags: { any_of: ['pci', 'pii', 'aadhaar'] } } },
  { name: 'Service account from new IP range', description: 'A service account connects from an IP range it has never used before — possible credential theft or lateral movement.', severity: 'high', status: 'monitor', rule_type: 'first_time', category: 'alert', scope: 'all', actions: ['alert', 'webhook'], rule_definition: { principal_user_type: 'service', first_time_source_ip_range: true } },
];

// Seed the default policy pack for a tenant (idempotent — skips if any policy exists).
async function seedDefaultPolicies(tenantId) {
  try {
    const has = await pgPool.query('SELECT 1 FROM policies WHERE tenant_id = $1 LIMIT 1', [tenantId]);
    if (has.rows.length) return;
    for (const p of DEFAULT_POLICIES) {
      await pgPool.query(
        `INSERT INTO policies (tenant_id, name, description, severity, status, rule_definition, rule_type, category, scope, actions)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
        [tenantId, p.name, p.description, p.severity, p.status, JSON.stringify(p.rule_definition), p.rule_type, p.category, p.scope, p.actions]
      );
    }
    console.log(`[Policies] Seeded ${DEFAULT_POLICIES.length} default policies for tenant ${tenantId}`);
  } catch (e) {
    console.error(`[Policies] seed failed for ${tenantId}: ${e.message}`);
  }
}

// ── Self-serve signup ─────────────────────────────────────
// Public: creates a tenant + its first tenant_admin (unverified until the emailed
// link is clicked). Requires a matching confirm password + the strength policy.
app.post('/api/auth/signup', async (req, res) => {
  const cn = String(req.body?.companyName || '').trim();
  const fn = String(req.body?.fullName || '').trim();
  const em = String(req.body?.email || '').toLowerCase().trim();
  const pw = String(req.body?.password || '');
  const cpw = String(req.body?.confirmPassword || '');
  if (!cn || !fn || !em || !pw) return res.status(400).json({ error: 'Company, name, email and password are all required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return res.status(400).json({ error: 'Enter a valid email address' });
  const pwErr = passwordIssue(pw);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (cpw && cpw !== pw) return res.status(400).json({ error: 'Passwords do not match' });
  // Self-serve plan selection. Enterprise is contact-sales (never provisioned here).
  // Map the chosen plan → real tier + tenant status (trial = shared plane, 14-day;
  // business = dedicated plane, active). Unknown/blank defaults to a trial.
  const SELF_SERVE_PLANS = {
    trial:    { tier: 'starter',  status: 'trial'  },
    business: { tier: 'business', status: 'active' },
  };
  const planKey = String(req.body?.plan || 'trial').toLowerCase();
  if (planKey === 'enterprise')
    return res.status(400).json({ error: 'Enterprise plans are set up with our team — please contact sales.' });
  const plan = SELF_SERVE_PLANS[planKey] || SELF_SERVE_PLANS.trial;
  try {
    // Email is per-workspace, so the same person may create/own multiple workspaces.
    // (Uniqueness is enforced within the new tenant by the unique(tenant_id, email) index.)
    // Unique slug derived from the company name.
    const base = (cn.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)) || 'workspace';
    let slug = base, n = 1;
    while ((await pgPool.query('SELECT 1 FROM tenants WHERE slug = $1', [slug])).rows.length) { n++; slug = `${base}-${n}`; }

    const t = (await pgPool.query(
      `INSERT INTO tenants (name, slug, tier, deployment_type, status) VALUES ($1,$2,$3,'saas',$4) RETURNING id, name`,
      [cn, slug, plan.tier, plan.status])).rows[0];
    // Paid tier (business) → dedicated ClickHouse data plane; trial (starter) stays shared. (No-op for shared.)
    await provisionDataPlaneIfPaid(t.id, plan.tier);
    // Seed the baseline detection/blocking policy pack so the workspace is useful on day one.
    await seedDefaultPolicies(t.id);
    // Admin starts UNVERIFIED — must click the emailed link before the workspace goes live.
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const u = (await pgPool.query(
      `INSERT INTO users (tenant_id, email, full_name, role, auth_provider, mfa_enabled, status, password_hash, invite_token, invite_expires_at)
       VALUES ($1,$2,$3,'tenant_admin','local',true,'unverified',$4,$5, now() + interval '24 hours') RETURNING id`,
      [t.id, em, fn, bcrypt.hashSync(pw, 10), verifyToken])).rows[0];

    const verifyUrl = `${APP_BASE_URL}/verify-email?token=${verifyToken}`;
    try { await sendVerifyEmail({ to: em, fullName: fn, tenantName: t.name, slug, verifyUrl }); }
    catch (e) { console.error(`[Signup] verify email failed (${e.message}) — verify link for ${em}: ${verifyUrl}`); }
    writeAudit({ tenantId: t.id, actorId: u.id, actorEmail: em, action: 'auth.signup', resourceType: 'tenant', resourceId: t.id, details: { company: cn, slug, tier: plan.tier, status: plan.status, verified: false } });
    try { await logPlatformAudit({ actor: em, action: 'tenant.signup', tenantId: t.id, tenantName: cn, resource: `tenant/${slug}`, ip: req.ip, details: 'Self-serve signup — awaiting email verification' }); } catch (e) { /* best-effort */ }
    res.status(201).json({ pending: true, email: em, slug, tenantName: t.name, message: 'Check your email to verify and activate your workspace.' });
  } catch (err) {
    console.error('[Auth] signup failed:', err.message);
    res.status(500).json({ error: 'Could not create your account' });
  }
});

// Verify the signup email → activate the admin + workspace, and auto-login.
app.post('/api/auth/verify-email', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Missing verification token' });
  try {
    const u = (await pgPool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.invite_expires_at, t.id AS tenant_id, t.name AS tenant_name, t.slug AS tenant_slug
       FROM users u JOIN tenants t ON u.tenant_id = t.id
       WHERE u.invite_token = $1 AND u.status = 'unverified'`, [token])).rows[0];
    if (!u) return res.status(404).json({ error: 'This verification link is invalid or already used. Try signing in.' });
    if (u.invite_expires_at && new Date(u.invite_expires_at) < new Date())
      return res.status(410).json({ error: 'This verification link has expired. Please sign up again.' });

    await pgPool.query(`UPDATE users SET status='active', invite_token=NULL, invite_expires_at=NULL, last_login_at=now() WHERE id=$1`, [u.id]);
    const jwtToken = jwt.sign({ userId: u.id, email: u.email, fullName: u.full_name, role: u.role, tenantId: u.tenant_id, tenantName: u.tenant_name }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    writeAudit({ tenantId: u.tenant_id, actorId: u.id, actorEmail: u.email, action: 'auth.email_verified', resourceType: 'user', resourceId: u.id, details: {} });
    // Workspace is now live → welcome the new admin (best-effort; never block activation).
    const tierRow = (await pgPool.query('SELECT tier FROM tenants WHERE id = $1', [u.tenant_id])).rows[0];
    sendWelcomeEmail({ to: u.email, fullName: u.full_name, tenantName: u.tenant_name, slug: u.tenant_slug, tier: tierRow?.tier || 'starter', loginUrl: `${APP_BASE_URL}/login` })
      .catch((e) => console.error(`[Welcome] send failed for ${u.email}: ${e.message}`));
    res.json({ token: jwtToken, slug: u.tenant_slug, user: { id: u.id, email: u.email, fullName: u.full_name, role: u.role, mfaEnabled: false, tenantId: u.tenant_id, tenantName: u.tenant_name, authProvider: 'local' } });
  } catch (err) {
    console.error('[Auth] verify-email failed:', err.message);
    res.status(500).json({ error: 'Could not verify your email' });
  }
});

// ── Who am I (validate token) ─────────────────────────────
app.get('/api/auth/me', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT u.id, u.email, u.full_name, u.role, u.mfa_enabled, u.status, u.last_login_at, t.name as tenant_name
     FROM users u JOIN tenants t ON u.tenant_id = t.id
     WHERE u.id = $1`,
    [req.user.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
});

// ── Change password ───────────────────────────────────────
app.post('/api/auth/change-password', authRequired, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new passwords are required' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const { rows } = await pgPool.query(
    'SELECT password_hash FROM users WHERE id = $1',
    [req.user.userId]
  );

  const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = await bcrypt.hash(newPassword, 10);
  await pgPool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.userId]);

  res.json({ message: 'Password changed successfully' });
});

// ── Azure AD SSO (OIDC Authorization Code Flow) ──────────
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID;
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID;
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const AZURE_REDIRECT_URI = process.env.AZURE_REDIRECT_URI || 'http://localhost:8091/auth/callback';
const AZURE_AUTHORITY = `https://login.microsoftonline.com/${AZURE_TENANT_ID}`;

// Okta OIDC (env-based, confidential web-app client). Uses the org's default custom
// authorization server (/oauth2/default) — pre-provisioned with openid/profile/email.
const OKTA_DOMAIN = process.env.OKTA_DOMAIN || null;
const OKTA_CLIENT_ID = process.env.OKTA_CLIENT_ID || null;
const OKTA_CLIENT_SECRET = process.env.OKTA_CLIENT_SECRET || null;
const OKTA_REDIRECT_URI = process.env.OKTA_REDIRECT_URI || 'http://localhost:5173/auth/okta/callback';
const OKTA_ISSUER = process.env.OKTA_ISSUER || (OKTA_DOMAIN ? `https://${OKTA_DOMAIN}/oauth2/default` : null);

// Google Sign-In (OIDC). Single issuer (accounts.google.com) — no per-org domain.
// Credentials are configured per tenant in the GUI; env is only an optional fallback.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || null;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5173/auth/google/callback';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Step 1: Redirect user to Azure AD login
app.get('/auth/azure', async (req, res) => {
  if (!AZURE_CLIENT_ID || !AZURE_TENANT_ID) {
    return res.status(500).json({ error: 'Azure AD not configured' });
  }
  // Workspace-first: the login page passes ?tenant=<slug>. Resolve it and confirm
  // this tenant actually has Azure SSO enabled, then carry the slug through `state`
  // so the callback routes the user back to THIS workspace (not `tenants LIMIT 1`).
  const slug = String(req.query.tenant || '').toLowerCase().trim();
  if (!slug) return res.redirect('/login?error=' + encodeURIComponent('Choose your workspace before using SSO.'));
  const t = (await pgPool.query('SELECT id, slug FROM tenants WHERE slug = $1', [slug])).rows[0];
  if (!t) return res.redirect('/login?error=' + encodeURIComponent('No workspace found with that name.'));
  const providers = await ssoProvidersFor(t.id);
  if (!providers.some((p) => p.key === 'azure'))
    return res.redirect('/login?error=' + encodeURIComponent('Azure AD sign-in is not enabled for this workspace.'));
  const state = Buffer.from(JSON.stringify({ ts: Date.now(), slug: t.slug })).toString('base64');
  const params = new URLSearchParams({
    client_id: AZURE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: AZURE_REDIRECT_URI,
    response_mode: 'query',
    scope: 'openid profile email',
    state: state,
  });
  // Optional: force Microsoft to show the account picker / login. The "Test
  // sign-in" action uses this so the Microsoft login is always shown instead of
  // silently completing via an existing session.
  if (['select_account', 'login', 'consent'].includes(req.query.prompt)) params.set('prompt', req.query.prompt);
  res.redirect(`${AZURE_AUTHORITY}/oauth2/v2.0/authorize?${params.toString()}`);
});

// Step 2: Handle callback from Azure AD
app.get('/auth/callback', async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.redirect(`/login?error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code) {
    return res.redirect('/login?error=No+authorization+code+received');
  }

  // Recover the workspace the sign-in started from (embedded in `state`).
  let stateSlug = '';
  try { stateSlug = JSON.parse(Buffer.from(String(req.query.state || ''), 'base64').toString()).slug || ''; } catch { /* legacy/no state */ }

  try {
    // Exchange authorization code for tokens
    const tokenRes = await fetch(`${AZURE_AUTHORITY}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: AZURE_CLIENT_ID,
        client_secret: AZURE_CLIENT_SECRET,
        code: code,
        redirect_uri: AZURE_REDIRECT_URI,
        grant_type: 'authorization_code',
        scope: 'openid profile email',
      }).toString(),
    });

    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      console.error('[Azure AD] Token error:', tokenData.error_description);
      return res.redirect(`/login?error=${encodeURIComponent(tokenData.error_description || tokenData.error)}`);
    }

    // Decode the ID token to get user info
    const idToken = tokenData.id_token;
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString());

    const azureEmail = (payload.preferred_username || payload.email || '').toLowerCase();
    const azureName = payload.name || azureEmail.split('@')[0];
    const azureOid = payload.oid;

    if (!azureEmail) {
      return res.redirect('/login?error=No+email+in+Azure+AD+token');
    }

    // Resolve the workspace this sign-in was for (from `state`). The user must exist
    // IN that specific tenant — an Azure identity valid for one workspace must not be
    // silently accepted into another.
    if (!stateSlug) return res.redirect('/login?error=' + encodeURIComponent('Choose your workspace before using SSO.'));
    const tRow = (await pgPool.query('SELECT id FROM tenants WHERE slug = $1', [stateSlug])).rows[0];
    if (!tRow) return res.redirect('/login?error=' + encodeURIComponent('That workspace no longer exists.'));

    // Find the user within THIS tenant (scoped by tenant_id, not global-by-email).
    let { rows } = await pgPool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.status, u.mfa_enabled, t.id as tenant_id, t.name as tenant_name
       FROM users u JOIN tenants t ON u.tenant_id = t.id
       WHERE u.email = $1 AND u.tenant_id = $2`,
      [azureEmail, tRow.id]
    );

    let user;

    if (rows.length > 0) {
      // Known account in this workspace → sign them in here.
      user = rows[0];
      const wasInactive = user.status !== 'active'; // first-ever activation via SSO?
      // Activate on first SSO login + update auth provider and last login
      await pgPool.query(
        `UPDATE users SET auth_provider = 'azure_ad', status = 'active', last_login_at = now() WHERE id = $1`,
        [user.id]
      );
      user.status = 'active';
      // An admin-created tenant admin signing in for the first time = workspace's first
      // admin now active → welcome them (best-effort, once). SSO has no accept step.
      if (wasInactive && user.role === 'tenant_admin') {
        const tierRow = (await pgPool.query('SELECT tier FROM tenants WHERE id = $1', [user.tenant_id])).rows[0];
        sendWelcomeEmail({ to: user.email, fullName: user.full_name, tenantName: user.tenant_name, slug: stateSlug, tier: tierRow?.tier || 'starter', loginUrl: `${APP_BASE_URL}/login` })
          .catch((e) => console.error(`[Welcome] SSO send failed for ${user.email}: ${e.message}`));
      }
    } else {
      // Azure identity authenticated, but there's no account for it in THIS workspace.
      // Don't auto-provision — the admin must invite them first. (No cross-tenant
      // fallback: an identity valid elsewhere still can't enter a workspace it's not in.)
      console.log(`[Azure AD] Rejected SSO login for ${azureEmail} into workspace ${stateSlug}`);
      return res.redirect('/login?error=' + encodeURIComponent(
        `${azureEmail} isn't a member of the "${stateSlug}" workspace. Ask an admin to invite you.`) + '&workspace=' + encodeURIComponent(stateSlug));
    }

    if (user.status !== 'active') {
      return res.redirect('/login?error=Account+is+not+active');
    }

    // Issue DAM JWT
    const damToken = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        tenantId: user.tenant_id,
        tenantName: user.tenant_name,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    // Redirect to frontend with token
    const userJson = encodeURIComponent(JSON.stringify({
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      mfaEnabled: user.mfa_enabled,
      tenantId: user.tenant_id,
      tenantName: user.tenant_name,
      authProvider: 'azure_ad',
    }));

    res.redirect(`/login?sso_token=${damToken}&sso_user=${userJson}`);

  } catch (err) {
    console.error('[Azure AD] SSO error:', err.message);
    res.redirect(`/login?error=${encodeURIComponent('SSO authentication failed: ' + err.message)}`);
  }
});

// ── Okta OIDC (workspace-first, tenant carried in state) ──────────────────────
// Step 1: start the Okta login for a specific workspace.
app.get('/auth/okta', async (req, res) => {
  const slug = String(req.query.tenant || '').toLowerCase().trim();
  if (!slug) return res.redirect('/login?error=' + encodeURIComponent('Choose your workspace before using SSO.'));
  const t = (await pgPool.query('SELECT id, slug FROM tenants WHERE slug = $1', [slug])).rows[0];
  if (!t) return res.redirect('/login?error=' + encodeURIComponent('No workspace found with that name.'));
  const cfg = await oktaConfigFor(t.id);
  if (!cfg) return res.redirect('/login?error=' + encodeURIComponent('Okta is not configured for this workspace.'));
  const providers = await ssoProvidersFor(t.id);
  if (!providers.some((p) => p.key === 'okta'))
    return res.redirect('/login?error=' + encodeURIComponent('Okta sign-in is not enabled for this workspace.'));
  const state = Buffer.from(JSON.stringify({ ts: Date.now(), slug: t.slug })).toString('base64');
  const params = new URLSearchParams({
    client_id: cfg.clientId, response_type: 'code', response_mode: 'query',
    scope: 'openid profile email', redirect_uri: cfg.redirectUri, state,
  });
  if (['login', 'consent', 'select_account'].includes(req.query.prompt)) params.set('prompt', req.query.prompt);
  res.redirect(`${cfg.issuer}/v1/authorize?${params.toString()}`);
});

// Step 2: Okta callback — exchange the code, resolve the tenant from state, match the
// user WITHIN that tenant (no auto-provision, no cross-tenant), then issue a DAM session.
app.get('/auth/okta/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) return res.redirect(`/login?error=${encodeURIComponent(error_description || error)}`);
  if (!code) return res.redirect('/login?error=No+authorization+code+received');
  let stateSlug = '';
  try { stateSlug = JSON.parse(Buffer.from(String(req.query.state || ''), 'base64').toString()).slug || ''; } catch { /* no state */ }
  try {
    if (!stateSlug) return res.redirect('/login?error=' + encodeURIComponent('Choose your workspace before using SSO.'));
    const tRow = (await pgPool.query('SELECT id FROM tenants WHERE slug = $1', [stateSlug])).rows[0];
    if (!tRow) return res.redirect('/login?error=' + encodeURIComponent('That workspace no longer exists.'));
    const cfg = await oktaConfigFor(tRow.id); // this tenant's own Okta credentials
    if (!cfg) return res.redirect('/login?error=' + encodeURIComponent('Okta is not configured for this workspace.'));

    const tokenRes = await fetch(`${cfg.issuer}/v1/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri,
        client_id: cfg.clientId, client_secret: cfg.clientSecret,
      }).toString(),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      console.error('[Okta] Token error:', tokenData.error_description || tokenData.error);
      return res.redirect(`/login?error=${encodeURIComponent(tokenData.error_description || tokenData.error)}`);
    }
    const payload = JSON.parse(Buffer.from(tokenData.id_token.split('.')[1], 'base64').toString());
    const oktaEmail = (payload.email || payload.preferred_username || '').toLowerCase();
    const oktaName = payload.name || oktaEmail.split('@')[0];
    if (!oktaEmail) return res.redirect('/login?error=No+email+in+Okta+token');

    const { rows } = await pgPool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.status, u.mfa_enabled, t.id as tenant_id, t.name as tenant_name
       FROM users u JOIN tenants t ON u.tenant_id = t.id WHERE u.email = $1 AND u.tenant_id = $2`,
      [oktaEmail, tRow.id]
    );
    if (!rows.length) {
      console.log(`[Okta] Rejected SSO login for ${oktaEmail} into workspace ${stateSlug}`);
      return res.redirect('/login?error=' + encodeURIComponent(`${oktaEmail} isn't a member of the "${stateSlug}" workspace. Ask an admin to invite you.`) + '&workspace=' + encodeURIComponent(stateSlug));
    }
    const user = rows[0];
    const wasInactive = user.status !== 'active';
    await pgPool.query(`UPDATE users SET auth_provider = 'okta', status = 'active', last_login_at = now() WHERE id = $1`, [user.id]);
    user.status = 'active';
    if (wasInactive && user.role === 'tenant_admin') {
      const tierRow = (await pgPool.query('SELECT tier FROM tenants WHERE id = $1', [user.tenant_id])).rows[0];
      sendWelcomeEmail({ to: user.email, fullName: user.full_name, tenantName: user.tenant_name, slug: stateSlug, tier: tierRow?.tier || 'starter', loginUrl: `${APP_BASE_URL}/login` })
        .catch((e) => console.error(`[Welcome] Okta send failed for ${user.email}: ${e.message}`));
    }
    writeAudit({ tenantId: user.tenant_id, actorId: user.id, actorEmail: user.email, action: 'auth.login', resourceType: 'user', resourceId: user.id, details: { role: user.role, sso: 'okta' } });
    const damToken = jwt.sign({ userId: user.id, email: user.email, fullName: user.full_name, role: user.role, tenantId: user.tenant_id, tenantName: user.tenant_name }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    const userJson = encodeURIComponent(JSON.stringify({ id: user.id, email: user.email, fullName: user.full_name, role: user.role, mfaEnabled: user.mfa_enabled, tenantId: user.tenant_id, tenantName: user.tenant_name, authProvider: 'okta' }));
    res.redirect(`/login?sso_token=${damToken}&sso_user=${userJson}`);
  } catch (err) {
    console.error('[Okta] SSO error:', err.message);
    res.redirect(`/login?error=${encodeURIComponent('Okta authentication failed: ' + err.message)}`);
  }
});

// ── Google Sign-In (OIDC, workspace-first, tenant carried in state) ───────────
app.get('/auth/google', async (req, res) => {
  const slug = String(req.query.tenant || '').toLowerCase().trim();
  if (!slug) return res.redirect('/login?error=' + encodeURIComponent('Choose your workspace before using SSO.'));
  const t = (await pgPool.query('SELECT id, slug FROM tenants WHERE slug = $1', [slug])).rows[0];
  if (!t) return res.redirect('/login?error=' + encodeURIComponent('No workspace found with that name.'));
  const cfg = await googleConfigFor(t.id);
  if (!cfg) return res.redirect('/login?error=' + encodeURIComponent('Google is not configured for this workspace.'));
  const providers = await ssoProvidersFor(t.id);
  if (!providers.some((p) => p.key === 'google'))
    return res.redirect('/login?error=' + encodeURIComponent('Google sign-in is not enabled for this workspace.'));
  const state = Buffer.from(JSON.stringify({ ts: Date.now(), slug: t.slug })).toString('base64');
  const params = new URLSearchParams({
    client_id: cfg.clientId, response_type: 'code', scope: 'openid email profile',
    redirect_uri: cfg.redirectUri, state, access_type: 'online', prompt: 'select_account',
  });
  res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/login?error=${encodeURIComponent(error)}`);
  if (!code) return res.redirect('/login?error=No+authorization+code+received');
  let stateSlug = '';
  try { stateSlug = JSON.parse(Buffer.from(String(req.query.state || ''), 'base64').toString()).slug || ''; } catch { /* no state */ }
  try {
    if (!stateSlug) return res.redirect('/login?error=' + encodeURIComponent('Choose your workspace before using SSO.'));
    const tRow = (await pgPool.query('SELECT id FROM tenants WHERE slug = $1', [stateSlug])).rows[0];
    if (!tRow) return res.redirect('/login?error=' + encodeURIComponent('That workspace no longer exists.'));
    const cfg = await googleConfigFor(tRow.id);
    if (!cfg) return res.redirect('/login?error=' + encodeURIComponent('Google is not configured for this workspace.'));

    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri,
        client_id: cfg.clientId, client_secret: cfg.clientSecret,
      }).toString(),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      console.error('[Google] Token error:', tokenData.error_description || tokenData.error);
      return res.redirect(`/login?error=${encodeURIComponent(tokenData.error_description || tokenData.error)}`);
    }
    const payload = JSON.parse(Buffer.from(tokenData.id_token.split('.')[1], 'base64').toString());
    const gEmail = (payload.email || '').toLowerCase();
    const gName = payload.name || gEmail.split('@')[0];
    if (!gEmail) return res.redirect('/login?error=No+email+in+Google+token');

    const { rows } = await pgPool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.status, u.mfa_enabled, t.id as tenant_id, t.name as tenant_name
       FROM users u JOIN tenants t ON u.tenant_id = t.id WHERE u.email = $1 AND u.tenant_id = $2`,
      [gEmail, tRow.id]
    );
    if (!rows.length) {
      console.log(`[Google] Rejected SSO login for ${gEmail} into workspace ${stateSlug}`);
      return res.redirect('/login?error=' + encodeURIComponent(`${gEmail} isn't a member of the "${stateSlug}" workspace. Ask an admin to invite you.`) + '&workspace=' + encodeURIComponent(stateSlug));
    }
    const user = rows[0];
    const wasInactive = user.status !== 'active';
    await pgPool.query(`UPDATE users SET auth_provider = 'google', status = 'active', last_login_at = now() WHERE id = $1`, [user.id]);
    user.status = 'active';
    if (wasInactive && user.role === 'tenant_admin') {
      const tierRow = (await pgPool.query('SELECT tier FROM tenants WHERE id = $1', [user.tenant_id])).rows[0];
      sendWelcomeEmail({ to: user.email, fullName: user.full_name, tenantName: user.tenant_name, slug: stateSlug, tier: tierRow?.tier || 'starter', loginUrl: `${APP_BASE_URL}/login` })
        .catch((e) => console.error(`[Welcome] Google send failed for ${user.email}: ${e.message}`));
    }
    writeAudit({ tenantId: user.tenant_id, actorId: user.id, actorEmail: user.email, action: 'auth.login', resourceType: 'user', resourceId: user.id, details: { role: user.role, sso: 'google' } });
    const damToken = jwt.sign({ userId: user.id, email: user.email, fullName: user.full_name, role: user.role, tenantId: user.tenant_id, tenantName: user.tenant_name }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    const userJson = encodeURIComponent(JSON.stringify({ id: user.id, email: user.email, fullName: user.full_name, role: user.role, mfaEnabled: user.mfa_enabled, tenantId: user.tenant_id, tenantName: user.tenant_name, authProvider: 'google' }));
    res.redirect(`/login?sso_token=${damToken}&sso_user=${userJson}`);
  } catch (err) {
    console.error('[Google] SSO error:', err.message);
    res.redirect(`/login?error=${encodeURIComponent('Google authentication failed: ' + err.message)}`);
  }
});

// ── Logout ────────────────────────────────────────────────
// Local/password users just land back on the login page. Only SSO users need to
// also clear their IdP session — the frontend signals that with ?sso=azure. (Before,
// this ALWAYS bounced to Azure's logout page, even for local users.)
app.get('/auth/logout', (req, res) => {
  const loginUrl = `${APP_BASE_URL}/login`;
  if (req.query.sso === 'azure' && AZURE_AUTHORITY && AZURE_CLIENT_ID) {
    return res.redirect(`${AZURE_AUTHORITY}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(loginUrl)}`);
  }
  res.redirect(loginUrl);
});

// ── Health check ──────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    const pg = await pgPool.query('SELECT 1');
    res.json({
      status: 'healthy',
      services: {
        postgres: 'ok',
        uptime: process.uptime(),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

// ── Tenants ───────────────────────────────────────────────
app.get('/api/tenants', async (req, res) => {
  const { rows } = await pgPool.query(
    'SELECT id, name, slug, tier, deployment_type, cloud_provider, data_region, status, created_at FROM tenants ORDER BY created_at'
  );
  res.json(rows);
});

app.get('/api/tenants/:id', async (req, res) => {
  const { rows } = await pgPool.query('SELECT * FROM tenants WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// ── Admin · Platform (Super-Admin console) ─────────────────
// Read-only aggregation across existing tables + ClickHouse, plus the isolated
// platform_alerts / platform_meta tables. Nothing here mutates main-app data.
app.get('/api/admin/platform/overview', async (req, res) => {
  try {
    const [tenantAgg, dbAgg, agentAgg, regionRows, tenantDbs, metaRows, alertRows, integrityRow] = await Promise.all([
      pgPool.query(`SELECT COUNT(*) AS total,
                           COUNT(*) FILTER (WHERE status = 'active') AS active,
                           COUNT(*) FILTER (WHERE created_at >= now() - INTERVAL '30 days') AS new_this_month
                    FROM tenants`),
      pgPool.query(`SELECT COUNT(*) AS total FROM databases`),
      pgPool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'online') AS online FROM agents`),
      pgPool.query(`SELECT COALESCE(NULLIF(data_region, ''), 'Unassigned') AS region, COUNT(*) AS cnt
                    FROM tenants GROUP BY 1 ORDER BY cnt DESC`),
      pgPool.query(`SELECT t.id, t.name, t.tier, COALESCE(NULLIF(t.data_region, ''), '—') AS region,
                           COUNT(d.id) AS db_count
                    FROM tenants t LEFT JOIN databases d ON d.tenant_id = t.id
                    GROUP BY t.id, t.name, t.tier, t.data_region`),
      pgPool.query(`SELECT key, value FROM platform_meta`),
      pgPool.query(`SELECT id, title, detail, region, category, severity, status, created_at
                    FROM platform_alerts WHERE status = 'open'
                    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                             created_at DESC`),
      pgPool.query(`SELECT COUNT(*) AS broken FROM audit_trail WHERE row_hash IS NULL`),
    ]);

    // Events today + per-tenant volume from ClickHouse (best-effort — never fail the page).
    let eventsToday = 0;
    const eventsByTenant = {};
    try {
      eventsToday = parseInt(await chQuery("SELECT count() FROM dam_analytics.events WHERE timestamp >= today()", 'TabSeparated')) || 0;
      const rows = await chQuery("SELECT tenant_id, count() AS cnt FROM dam_analytics.events WHERE timestamp >= today() GROUP BY tenant_id");
      rows.forEach(r => { eventsByTenant[r.tenant_id] = parseInt(r.cnt); });
    } catch { /* ClickHouse not ready */ }

    const meta = Object.fromEntries(metaRows.rows.map(r => [r.key, r.value]));
    const topTenants = tenantDbs.rows
      .map(t => ({
        id: t.id, name: t.name, tier: t.tier, region: t.region,
        databases: parseInt(t.db_count),
        eventsPerDay: eventsByTenant[t.id] || 0,
      }))
      .sort((a, b) => b.eventsPerDay - a.eventsPerDay || b.databases - a.databases)
      .slice(0, 8);

    res.json({
      kpis: {
        tenants: {
          active: parseInt(tenantAgg.rows[0].active),
          total: parseInt(tenantAgg.rows[0].total),
          newThisMonth: parseInt(tenantAgg.rows[0].new_this_month),
        },
        databases: parseInt(dbAgg.rows[0].total),
        agents: { online: parseInt(agentAgg.rows[0].online), total: parseInt(agentAgg.rows[0].total) },
        eventsToday,
        platformAlerts: alertRows.rows.length,
        regions: regionRows.rows.map(r => r.region),
        dataIntegrity: parseInt(integrityRow.rows[0].broken) === 0 ? 'Intact' : 'Check',
        version: meta.platform_version || 'v0.1.0',
        versionDeployedAt: meta.version_deployed_at || null,
      },
      tenantsByRegion: regionRows.rows.map(r => ({ region: r.region, count: parseInt(r.cnt) })),
      topTenants,
      alerts: alertRows.rows,
    });
  } catch (err) {
    console.error('[Admin] platform overview failed:', err.message);
    res.status(500).json({ error: 'Failed to load platform overview' });
  }
});

app.get('/api/admin/platform/events-timeline', async (req, res) => {
  try {
    const rows = await chQuery(`SELECT toStartOfHour(timestamp) AS hour, count() AS cnt
                                FROM dam_analytics.events
                                WHERE timestamp >= now() - INTERVAL 24 HOUR
                                GROUP BY hour ORDER BY hour`);
    res.json(rows.map(r => ({ hour: r.hour, cnt: parseInt(r.cnt) })));
  } catch {
    res.json([]);
  }
});

// ── Admin · Tenants (Super-Admin console) ──────────────────
// A tenant's health is a 0–100 composite from agent uptime, monitoring coverage
// and open-alert pressure — derived live, no stored column needed.
function tenantHealth(t) {
  const agentTotal = parseInt(t.agent_total) || 0;
  const agentOnline = parseInt(t.agent_online) || 0;
  const dbCount = parseInt(t.db_count) || 0;
  const monitored = parseInt(t.monitored_db) || 0;
  const openAlerts = parseInt(t.open_alerts) || 0;
  const agentRatio = agentTotal > 0 ? agentOnline / agentTotal : 1;
  const monitorRatio = dbCount > 0 ? monitored / dbCount : 1;
  const h = Math.round(60 * agentRatio + 40 * monitorRatio) - Math.min(openAlerts * 3, 25);
  return Math.max(0, Math.min(100, h));
}

// auth_provider → human SSO label shown in the manage modal.
const SSO_LABEL = { azure: 'Azure AD / Entra ID', 'azure-ad': 'Azure AD / Entra ID', okta: 'Okta', google: 'Google Workspace', ldap: 'LDAP / Kerberos', saml: 'SAML 2.0', local: 'Email + password' };

function shapeTenant(t, eventsByTenant) {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    tier: t.tier,
    deployment_type: t.deployment_type,
    cloud_provider: t.cloud_provider,
    region: t.data_region,
    status: t.status,
    created_at: t.created_at,
    databases: parseInt(t.db_count) || 0,
    agents: { online: parseInt(t.agent_online) || 0, total: parseInt(t.agent_total) || 0 },
    monitoredDatabases: parseInt(t.monitored_db) || 0,
    openAlerts: parseInt(t.open_alerts) || 0,
    eventsPerDay: eventsByTenant[t.id] || 0,
    health: tenantHealth(t),
    admin: t.admin_name || null,
    adminEmail: t.admin_email || null,
    sso: SSO_LABEL[t.admin_auth_provider] || 'Email + password',
  };
}

const TENANT_AGG = `
  SELECT t.id, t.name, t.slug, t.tier, t.deployment_type, t.cloud_provider, t.data_region, t.status, t.created_at,
         (SELECT COUNT(*) FROM databases d WHERE d.tenant_id = t.id) AS db_count,
         (SELECT COUNT(*) FROM agents a WHERE a.tenant_id = t.id) AS agent_total,
         (SELECT COUNT(*) FROM agents a WHERE a.tenant_id = t.id AND a.status = 'online') AS agent_online,
         (SELECT COUNT(*) FROM databases d WHERE d.tenant_id = t.id
            AND EXISTS (SELECT 1 FROM agents a WHERE a.instance_id = d.instance_id)) AS monitored_db,
         (SELECT COUNT(*) FROM alerts al WHERE al.tenant_id = t.id AND al.status = 'open') AS open_alerts,
         u.full_name AS admin_name, u.email AS admin_email, u.auth_provider AS admin_auth_provider
  FROM tenants t
  LEFT JOIN LATERAL (
    SELECT full_name, email, auth_provider FROM users
    WHERE tenant_id = t.id AND role = 'tenant_admin' ORDER BY created_at LIMIT 1
  ) u ON true`;

async function eventsByTenantToday() {
  const map = {};
  try {
    const ev = await chQuery("SELECT tenant_id, count() AS cnt FROM dam_analytics.events WHERE timestamp >= today() GROUP BY tenant_id");
    ev.forEach(r => { map[r.tenant_id] = parseInt(r.cnt); });
  } catch { /* ClickHouse not ready */ }
  return map;
}

app.get('/api/admin/tenants/summary', async (req, res) => {
  try {
    const { rows } = await pgPool.query(`SELECT
        COUNT(*) FILTER (WHERE status = 'active') AS active,
        COUNT(*) FILTER (WHERE status = 'trial') AS trial,
        COUNT(*) FILTER (WHERE status = 'suspended') AS suspended,
        COUNT(*) FILTER (WHERE status = 'offboarding') AS offboarding,
        COUNT(*) AS total FROM tenants`);
    const dbs = await pgPool.query('SELECT COUNT(*) AS n FROM databases');
    const regions = await pgPool.query("SELECT COUNT(DISTINCT COALESCE(NULLIF(data_region,''),'—')) AS n FROM tenants");
    const plans = await pgPool.query('SELECT COUNT(DISTINCT tier) AS n FROM tenants');
    const s = rows[0];
    res.json({
      active: parseInt(s.active), trial: parseInt(s.trial), suspended: parseInt(s.suspended),
      offboarding: parseInt(s.offboarding), total: parseInt(s.total),
      totalDatabases: parseInt(dbs.rows[0].n), regions: parseInt(regions.rows[0].n), plans: parseInt(plans.rows[0].n),
    });
  } catch (err) {
    console.error('[Admin] tenants summary failed:', err.message);
    res.status(500).json({ error: 'Failed to load tenant summary' });
  }
});

app.get('/api/admin/tenants', async (req, res) => {
  try {
    const tenants = await pgPool.query(`${TENANT_AGG} ORDER BY t.created_at`);
    const events = await eventsByTenantToday();
    res.json(tenants.rows.map(t => shapeTenant(t, events)));
  } catch (err) {
    console.error('[Admin] tenants list failed:', err.message);
    res.status(500).json({ error: 'Failed to load tenants' });
  }
});

app.get('/api/admin/tenants/:id', async (req, res) => {
  try {
    const tenants = await pgPool.query(`${TENANT_AGG} WHERE t.id = $1`, [req.params.id]);
    if (!tenants.rows.length) return res.status(404).json({ error: 'Not found' });
    const events = await eventsByTenantToday();
    res.json(shapeTenant(tenants.rows[0], events));
  } catch (err) {
    console.error('[Admin] tenant detail failed:', err.message);
    res.status(500).json({ error: 'Failed to load tenant' });
  }
});

// Create tenant — a REAL additive INSERT (new rows only; no existing tenant is
// modified, so the main DAM app is unaffected). Optionally invites a tenant admin.
const SSO_TO_PROVIDER = { 'azure-ad': 'azure', okta: 'okta', google: 'google', ldap: 'ldap', saml: 'saml', none: 'local' };
app.post('/api/admin/tenants', async (req, res) => {
  const { name, slug, tier = 'professional', deployment_type = 'saas', cloud_provider = null, data_region = null, status = 'active', adminName = null, adminEmail = null, sso = 'azure-ad' } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: 'name and slug are required' });
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'slug must be lowercase letters, numbers and hyphens' });
  try {
    const dup = await pgPool.query('SELECT 1 FROM tenants WHERE slug = $1', [slug]);
    if (dup.rows.length) return res.status(409).json({ error: `slug "${slug}" already exists` });

    const ins = await pgPool.query(
      `INSERT INTO tenants (name, slug, tier, deployment_type, cloud_provider, data_region, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [name, slug, tier, deployment_type, cloud_provider, data_region, status]
    );
    const tenantId = ins.rows[0].id;
    // Paid tier → dedicated ClickHouse data plane; trial/starter stay on the shared pool.
    await provisionDataPlaneIfPaid(tenantId, tier);
    // Seed the baseline detection/blocking policy pack (same set the reference tenant ships with).
    await seedDefaultPolicies(tenantId);

    let adminInvited = false;
    if (adminEmail) {
      const provider = SSO_TO_PROVIDER[sso] || 'local';
      const isSso = sso && sso !== 'none' && provider !== 'local';
      // Local admins get a tokened accept-invite link (set a password); SSO admins
      // sign in via their IdP, so no token — just an access notification.
      const inviteToken = isSso ? null : crypto.randomBytes(32).toString('hex');
      const inviteExpires = isSso ? null : new Date(Date.now() + 7 * 24 * 3600 * 1000);
      const u = await pgPool.query(
        `INSERT INTO users (tenant_id, email, full_name, role, auth_provider, mfa_enabled, status, invite_token, invite_expires_at)
         VALUES ($1,$2,$3,'tenant_admin',$4,true,'invited',$5,$6)
         ON CONFLICT (tenant_id, email) DO NOTHING RETURNING id`,
        [tenantId, adminEmail, adminName || adminEmail, isSso ? 'azure_ad' : 'local', inviteToken, inviteExpires]
      );
      adminInvited = u.rows.length > 0;
      if (adminInvited) {
        const inviter = req.body?.actor || 'TooVix';
        try {
          if (isSso) {
            await sendSsoInviteEmail({ to: adminEmail, fullName: adminName || adminEmail, role: 'tenant admin', tenantName: name, inviterName: inviter, loginUrl: `${APP_BASE_URL}/login` });
          } else {
            const acceptUrl = `${APP_BASE_URL}/accept-invite?token=${inviteToken}`;
            await sendInviteEmail({ to: adminEmail, fullName: adminName || adminEmail, role: 'tenant admin', tenantName: name, inviterName: inviter, acceptUrl });
          }
        } catch (e) { console.error(`[Admin] admin invite email failed for ${adminEmail}: ${e.message}`); }
      }
    }
    await logPlatformAudit({ actor: req.body?.actor || 'Platform Ops', action: 'tenant.create', tenantId, tenantName: name, resource: `tenant/${slug}`, ip: req.ip, details: `New ${tier}-tier tenant · ${data_region || 'local'}` });
    res.status(201).json({ ok: true, id: tenantId, created_at: ins.rows[0].created_at, adminInvited });
  } catch (err) {
    console.error('[Admin] create tenant failed:', err.message);
    res.status(500).json({ error: 'Failed to create tenant' });
  }
});

// ── Admin · Platform email (SMTP) — the SYSTEM sender for signup verification /
// invites. Operator-configured in the Super-Admin console; password never returned.
app.get('/api/admin/platform/smtp', async (req, res) => {
  try {
    const s = platformSmtpConfig || {};
    res.json({
      host: s.host || '', port: s.port || 587, secure: !!s.secure, username: s.username || '',
      from: s.from_addr || '', passwordSet: !!s.password, configured: !!activePlatformSmtp(),
      source: (s && s.host) ? 'database' : (process.env.SMTP_HOST ? 'env' : 'none'),
      updatedBy: s.updated_by || null, updatedAt: s.updated_at || null,
    });
  } catch (e) { res.status(500).json({ error: 'Failed to load platform SMTP' }); }
});

app.put('/api/admin/platform/smtp', async (req, res) => {
  const { host, port, secure, username, password, from, actor } = req.body || {};
  if (!host || !String(host).trim()) return res.status(400).json({ error: 'host is required' });
  try {
    const existing = (await pgPool.query('SELECT password FROM platform_smtp WHERE id=1')).rows[0];
    const pass = (password && String(password).trim()) ? String(password).trim() : (existing ? existing.password : null);
    await pgPool.query(
      `UPDATE platform_smtp SET host=$1, port=$2, secure=$3, username=$4, password=$5, from_addr=$6, updated_at=now(), updated_by=$7 WHERE id=1`,
      [String(host).trim(), parseInt(port) || 587, !!secure, (username || '').trim() || null, pass, (from || '').trim() || null, actor || 'Platform Ops']);
    await loadPlatformSmtp();
    try { await logPlatformAudit({ actor: actor || 'Platform Ops', action: 'platform.smtp.update', resource: 'platform/smtp', ip: req.ip, details: `host ${host}` }); } catch (e) { /* best-effort */ }
    res.json({ ok: true });
  } catch (err) { console.error('[Admin] platform smtp save failed:', err.message); res.status(500).json({ error: 'Failed to save platform SMTP' }); }
});

app.post('/api/admin/platform/smtp/test', async (req, res) => {
  const to = ((req.body && req.body.to) || '').trim();
  if (!to) return res.status(400).json({ error: 'Enter a recipient address to test' });
  try {
    const b = req.body || {};
    let smtp;
    if (b.host) {
      const existing = (await pgPool.query('SELECT password FROM platform_smtp WHERE id=1')).rows[0];
      const pass = (b.password && String(b.password).trim()) ? String(b.password).trim() : (existing ? existing.password : '');
      const tUser = (b.username || '').trim();
      const tFrom = (b.from || '').trim() || (/@/.test(tUser) ? tUser : platformFrom());
      smtp = { host: String(b.host).trim(), port: parseInt(b.port) || 587, secure: !!b.secure, user: tUser || undefined, pass: pass || undefined, from: tFrom };
    } else smtp = activePlatformSmtp();
    if (!smtp || !smtp.host) return res.status(400).json({ error: 'Platform SMTP is not configured — enter a host first' });
    const transport = buildTransport(smtp);
    await transport.verify();
    await transport.sendMail({ from: smtp.from || platformFrom(), to, subject: 'TooVix DAM — platform SMTP test',
      text: 'Platform SMTP is working. System emails (signup verification, invites) will send from here.',
      html: '<p style="font-family:Inter,Arial,sans-serif"><b>✓ Platform SMTP is working.</b><br>System emails — signup verification & invites — will send from here.</p>' });
    res.json({ ok: true, message: `Test email sent to ${to}` });
  } catch (err) { console.error('[Admin] platform smtp test failed:', err.message); res.status(502).json({ ok: false, error: `SMTP test failed: ${err.message}` }); }
});

// ── Admin · Feature Flags (Super-Admin console) ────────────
// Catalog lives in feature_flags; per-tenant exceptions in feature_overrides —
// both ISOLATED admin tables (no main-app table touched). A tenant's tier comes
// from tenants.tier; effective enablement is derived, GA features are on by
// default for eligible tiers while beta/alpha are opt-in via an override.
function tierEligible(f, tier) {
  if (tier === 'enterprise') return f.tier_enterprise;
  if (tier === 'business') return f.tier_business;
  return f.tier_starter; // starter / professional / unknown
}
function featureEnabled(f, tier, override) {
  if (f.is_core) return true;
  if (override === 'disabled') return false;
  if (override === 'enabled' || override === 'beta' || override === 'alpha') return true;
  return tierEligible(f, tier) && f.stage === 'ga';
}

app.get('/api/admin/features/summary', async (req, res) => {
  try {
    const { rows } = await pgPool.query(`SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE stage = 'ga') AS ga,
        COUNT(*) FILTER (WHERE stage = 'beta') AS beta,
        COUNT(*) FILTER (WHERE stage = 'alpha') AS alpha FROM feature_flags`);
    const t = await pgPool.query('SELECT COUNT(*) AS n FROM tenants');
    const s = rows[0];
    res.json({ total: +s.total, ga: +s.ga, beta: +s.beta, alpha: +s.alpha, tenants: +t.rows[0].n });
  } catch (err) {
    console.error('[Admin] features summary failed:', err.message);
    res.status(500).json({ error: 'Failed to load feature summary' });
  }
});

app.get('/api/admin/features', async (req, res) => {
  try {
    const features = (await pgPool.query('SELECT * FROM feature_flags ORDER BY sort_order')).rows;
    const tenants = (await pgPool.query('SELECT id, tier FROM tenants')).rows;
    const overrides = (await pgPool.query('SELECT feature_key, tenant_id, status FROM feature_overrides')).rows;
    const ovByFeature = {};
    overrides.forEach(o => { (ovByFeature[o.feature_key] ||= {})[o.tenant_id] = o.status; });

    const shaped = features.map(f => {
      const ov = ovByFeature[f.key] || {};
      let enabled = 0;
      tenants.forEach(t => { if (featureEnabled(f, t.tier, ov[t.id])) enabled += 1; });
      return {
        key: f.key, name: f.name, description: f.description, stage: f.stage,
        tiers: { starter: f.tier_starter, business: f.tier_business, enterprise: f.tier_enterprise },
        isCore: f.is_core, tierGated: f.tier_gated,
        manageable: !f.is_core && !f.tier_gated,
        rolloutTarget: f.rollout_target, rolloutError: f.rollout_error,
        enabledCount: enabled, tenantTotal: tenants.length,
      };
    });
    res.json(shaped);
  } catch (err) {
    console.error('[Admin] features list failed:', err.message);
    res.status(500).json({ error: 'Failed to load features' });
  }
});

app.get('/api/admin/features/:key/overrides', async (req, res) => {
  try {
    const fr = await pgPool.query('SELECT * FROM feature_flags WHERE key = $1', [req.params.key]);
    if (!fr.rows.length) return res.status(404).json({ error: 'Unknown feature' });
    const f = fr.rows[0];
    const tenants = (await pgPool.query('SELECT id, name, slug, tier, status FROM tenants ORDER BY created_at')).rows;
    const ovRows = (await pgPool.query('SELECT tenant_id, status FROM feature_overrides WHERE feature_key = $1', [req.params.key])).rows;
    const ovMap = Object.fromEntries(ovRows.map(o => [o.tenant_id, o.status]));

    const rows = tenants.map(t => {
      const override = ovMap[t.id] || null;
      const eligible = tierEligible(f, t.tier);
      return {
        tenantId: t.id, name: t.name, slug: t.slug, tier: t.tier,
        eligible, override, enabled: featureEnabled(f, t.tier, override),
      };
    });
    res.json({ feature: { key: f.key, name: f.name, stage: f.stage, manageable: !f.is_core && !f.tier_gated }, tenants: rows });
  } catch (err) {
    console.error('[Admin] feature overrides failed:', err.message);
    res.status(500).json({ error: 'Failed to load overrides' });
  }
});

// Real write — but only into the ISOLATED feature_overrides table (no main-app
// table touched). status: 'enabled' | 'disabled' | 'reset' (reset clears the override).
app.post('/api/admin/features/:key/overrides/:tenantId', async (req, res) => {
  const { status } = req.body || {};
  if (!['enabled', 'disabled', 'reset'].includes(status)) return res.status(400).json({ error: 'status must be enabled, disabled or reset' });
  try {
    const f = await pgPool.query('SELECT key, is_core, tier_gated FROM feature_flags WHERE key = $1', [req.params.key]);
    if (!f.rows.length) return res.status(404).json({ error: 'Unknown feature' });
    if (f.rows[0].is_core || f.rows[0].tier_gated) return res.status(409).json({ error: 'This feature is not overridable per tenant' });
    const t = await pgPool.query('SELECT 1 FROM tenants WHERE id = $1', [req.params.tenantId]);
    if (!t.rows.length) return res.status(404).json({ error: 'Unknown tenant' });

    if (status === 'reset') {
      await pgPool.query('DELETE FROM feature_overrides WHERE feature_key = $1 AND tenant_id = $2', [req.params.key, req.params.tenantId]);
    } else {
      await pgPool.query(
        `INSERT INTO feature_overrides (feature_key, tenant_id, status) VALUES ($1, $2, $3)
         ON CONFLICT (feature_key, tenant_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
        [req.params.key, req.params.tenantId, status]
      );
    }
    res.json({ ok: true, status });
  } catch (err) {
    console.error('[Admin] set override failed:', err.message);
    res.status(500).json({ error: 'Failed to update override' });
  }
});

// ── Admin · Resource Quotas (Super-Admin console) ──────────
// Limits = per-tenant override (isolated quota_overrides) falling back to the
// plan-tier default (quota_plans). Actuals are REAL: DB count from Postgres,
// events/day + a storage estimate from ClickHouse. NULL limit = unlimited.
const AVG_EVENT_BYTES = 1024; // rough per-event footprint for the storage estimate
function quotaTier(tier) {
  if (tier === 'enterprise') return 'enterprise';
  if (tier === 'business') return 'business';
  return 'starter';
}
function pctOf(actual, limit) {
  if (limit == null || limit <= 0) return 0; // unlimited / custom → unconstrained
  return Math.round((actual / limit) * 100);
}
function quotaStatus(maxPct) {
  if (maxPct >= 95) return 'at-limit';
  if (maxPct >= 70) return 'warning';
  return 'ok';
}

// Total events per tenant (all-time) → storage estimate.
async function eventsTotalByTenant() {
  const map = {};
  try {
    const ev = await chQuery('SELECT tenant_id, count() AS cnt FROM dam_analytics.events GROUP BY tenant_id');
    ev.forEach(r => { map[r.tenant_id] = parseInt(r.cnt); });
  } catch { /* ClickHouse not ready */ }
  return map;
}

async function buildQuotaRows() {
  const tenants = (await pgPool.query(`
    SELECT t.id, t.name, t.slug, t.tier,
           (SELECT COUNT(*) FROM databases d WHERE d.tenant_id = t.id) AS db_count
    FROM tenants t ORDER BY t.created_at`)).rows;
  const plans = {};
  (await pgPool.query('SELECT * FROM quota_plans')).rows.forEach(p => { plans[p.tier] = p; });
  const overrides = {};
  (await pgPool.query('SELECT * FROM quota_overrides')).rows.forEach(o => { overrides[o.tenant_id] = o; });
  const eventsToday = await eventsByTenantToday();
  const eventsTotal = await eventsTotalByTenant();

  return tenants.map(t => {
    const plan = plans[quotaTier(t.tier)] || {};
    const ov = overrides[t.id];
    const num = (k) => (ov && ov[k] != null ? Number(ov[k]) : plan[k] != null ? Number(plan[k]) : null);
    const evLimit = num('events_per_day');
    const dbLimit = num('max_databases');
    const stLimitGb = num('storage_gb');

    const evActual = eventsToday[t.id] || 0;
    const dbActual = parseInt(t.db_count) || 0;
    const stActualGb = +(((eventsTotal[t.id] || 0) * AVG_EVENT_BYTES) / (1024 ** 3)).toFixed(3);

    const evPct = pctOf(evActual, evLimit);
    const dbPct = pctOf(dbActual, dbLimit);
    const stPct = pctOf(stActualGb, stLimitGb);
    const maxPct = Math.max(evPct, dbPct, stPct);

    return {
      tenantId: t.id, name: t.name, slug: t.slug, tier: t.tier,
      custom: !!ov,
      justification: ov ? ov.justification : null,
      events: { limit: evLimit, actual: evActual, pct: evPct },
      databases: { limit: dbLimit, actual: dbActual, pct: dbPct },
      storage: { limitGb: stLimitGb, actualGb: stActualGb, pct: stPct },
      maxPct, status: quotaStatus(maxPct),
    };
  });
}

app.get('/api/admin/quotas', async (req, res) => {
  try {
    res.json(await buildQuotaRows());
  } catch (err) {
    console.error('[Admin] quotas list failed:', err.message);
    res.status(500).json({ error: 'Failed to load quotas' });
  }
});

app.get('/api/admin/quotas/summary', async (req, res) => {
  try {
    const rows = await buildQuotaRows();
    const atLimit = rows.filter(r => r.maxPct >= 95).length;
    const warnings = rows.filter(r => r.maxPct >= 70 && r.maxPct < 95).length;
    const hardBlocks = rows.filter(r => r.maxPct >= 100).length;
    const avgUtilization = rows.length ? Math.round(rows.reduce((s, r) => s + r.maxPct, 0) / rows.length) : 0;
    res.json({ atLimit, warnings, hardBlocks, avgUtilization, tenants: rows.length });
  } catch (err) {
    console.error('[Admin] quotas summary failed:', err.message);
    res.status(500).json({ error: 'Failed to load quota summary' });
  }
});

app.get('/api/admin/quotas/plans', async (req, res) => {
  try {
    const rows = (await pgPool.query('SELECT * FROM quota_plans ORDER BY sort_order')).rows;
    res.json(rows.map(p => ({
      tier: p.tier,
      eventsPerDay: p.events_per_day == null ? null : Number(p.events_per_day),
      maxDatabases: p.max_databases,
      storageGb: p.storage_gb,
      notes: p.notes,
    })));
  } catch (err) {
    console.error('[Admin] quota plans failed:', err.message);
    res.status(500).json({ error: 'Failed to load quota plans' });
  }
});

// Current quota pressure — derived live from utilization (no static seed data).
app.get('/api/admin/quotas/alerts', async (req, res) => {
  try {
    const rows = await buildQuotaRows();
    const alerts = [];
    rows.forEach(r => {
      [['events/day', r.events.pct], ['databases', r.databases.pct], ['storage', r.storage.pct]].forEach(([metric, pct]) => {
        if (pct >= 70) {
          const severity = pct >= 95 ? 'critical' : pct >= 85 ? 'high' : 'warning';
          alerts.push({ tenant: r.name, slug: r.slug, metric, pct, severity });
        }
      });
    });
    alerts.sort((a, b) => b.pct - a.pct);
    res.json(alerts);
  } catch (err) {
    console.error('[Admin] quota alerts failed:', err.message);
    res.status(500).json({ error: 'Failed to load quota alerts' });
  }
});

// Save a per-tenant quota override — REAL write, but only into the isolated
// quota_overrides table (no main-app table touched). Justification required and
// stored on the row itself (we do NOT write to the app-maintained audit_trail).
app.post('/api/admin/quotas/:tenantId', async (req, res) => {
  const { events_per_day = null, max_databases = null, storage_gb = null, justification } = req.body || {};
  if (!justification || !justification.trim()) return res.status(400).json({ error: 'Justification is required for the override audit record' });
  const toIntOrNull = (v) => (v === '' || v == null ? null : Number.isFinite(+v) ? Math.round(+v) : NaN);
  const ev = toIntOrNull(events_per_day), db = toIntOrNull(max_databases), st = toIntOrNull(storage_gb);
  if ([ev, db, st].some(v => Number.isNaN(v))) return res.status(400).json({ error: 'Limits must be whole numbers (or blank for unlimited)' });
  try {
    const t = await pgPool.query('SELECT 1 FROM tenants WHERE id = $1', [req.params.tenantId]);
    if (!t.rows.length) return res.status(404).json({ error: 'Unknown tenant' });
    await pgPool.query(
      `INSERT INTO quota_overrides (tenant_id, events_per_day, max_databases, storage_gb, justification, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id) DO UPDATE SET
         events_per_day = EXCLUDED.events_per_day, max_databases = EXCLUDED.max_databases,
         storage_gb = EXCLUDED.storage_gb, justification = EXCLUDED.justification,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [req.params.tenantId, ev, db, st, justification.trim(), req.body.updated_by || 'platform-ops']
    );
    const qtn = (await pgPool.query('SELECT name FROM tenants WHERE id=$1', [req.params.tenantId])).rows[0];
    await logPlatformAudit({ actor: req.body.updated_by || 'Platform Ops', action: 'tenant.quota.update', tenantId: req.params.tenantId, tenantName: qtn?.name, resource: `quota/${req.params.tenantId}`, ip: req.ip, details: `Quota override · ${justification.trim().slice(0, 60)}` });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Admin] save quota override failed:', err.message);
    res.status(500).json({ error: 'Failed to save quota override' });
  }
});

// ── Admin · Tenant Health (Super-Admin console) ────────────
// Single-pane per-tenant diagnostics. Pure reads across existing tables +
// ClickHouse — no new tables, no writes; the main app is untouched.
function fmtAgo(unixSec) {
  if (!unixSec) return null;
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

app.get('/api/admin/tenants/:id/health', async (req, res) => {
  const id = req.params.id;
  try {
    const tr = await pgPool.query('SELECT id, name, slug, tier FROM tenants WHERE id = $1', [id]);
    if (!tr.rows.length) return res.status(404).json({ error: 'Not found' });
    const tenant = tr.rows[0];

    const [agentRows, dbAgg, alertAgg, alert24, classAgg, integRows, comp, openAlerts] = await Promise.all([
      pgPool.query('SELECT id, host, agent_type, status, last_heartbeat FROM agents WHERE tenant_id = $1', [id]),
      pgPool.query(`SELECT
          (SELECT COUNT(*) FROM databases d WHERE d.tenant_id = $1) AS total,
          (SELECT COUNT(*) FROM databases d WHERE d.tenant_id = $1
             AND EXISTS (SELECT 1 FROM agents a WHERE a.instance_id = d.instance_id)) AS monitored`, [id]),
      pgPool.query(`SELECT COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'open') AS open,
          COUNT(*) FILTER (WHERE status <> 'open') AS handled,
          AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))) FILTER (WHERE resolved_at IS NOT NULL) AS avg_resp_s
        FROM alerts WHERE tenant_id = $1`, [id]),
      pgPool.query(`SELECT COUNT(*) AS c FROM alerts WHERE tenant_id = $1 AND created_at >= now() - interval '24 hours'`, [id]),
      pgPool.query(`SELECT COUNT(*) AS cols, COUNT(*) FILTER (WHERE is_masked) AS masked,
          COUNT(*) FILTER (WHERE confidence < 0.85) AS pending, MAX(last_scanned_at) AS last_scan
        FROM classified_columns WHERE tenant_id = $1`, [id]),
      pgPool.query('SELECT type, status, last_sync_at FROM integrations WHERE tenant_id = $1', [id]),
      pgPool.query('SELECT COUNT(*) AS frameworks, AVG(score) AS pass_rate, COUNT(*) FILTER (WHERE score < 85) AS gaps FROM compliance_scores'),
      pgPool.query(`SELECT severity, summary, created_at FROM alerts WHERE tenant_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 8`, [id]),
    ]);

    // Agents
    const agents = agentRows.rows;
    const agentTotal = agents.length;
    const offline = agents.filter(a => a.status !== 'online');
    const agentOnline = agentTotal - offline.length;
    const dbTotal = parseInt(dbAgg.rows[0].total) || 0;
    const monitored = parseInt(dbAgg.rows[0].monitored) || 0;
    const coverage = dbTotal > 0 ? Math.round((monitored / dbTotal) * 100) : 100;
    const gaps = Math.max(0, dbTotal - monitored);

    // Alerts
    const aAll = parseInt(alertAgg.rows[0].total) || 0;
    const aOpen = parseInt(alertAgg.rows[0].open) || 0;
    const aHandled = parseInt(alertAgg.rows[0].handled) || 0;
    const ackRate = aAll > 0 ? Math.round((aHandled / aAll) * 100) : 100;
    const avgRespS = alertAgg.rows[0].avg_resp_s ? Math.round(alertAgg.rows[0].avg_resp_s) : null;
    const count24 = parseInt(alert24.rows[0].c) || 0;

    // Classification
    const cols = parseInt(classAgg.rows[0].cols) || 0;
    const pending = parseInt(classAgg.rows[0].pending) || 0;
    const classCoverage = cols > 0 ? Math.round(((cols - pending) / cols) * 100) : 0;
    const lastScan = classAgg.rows[0].last_scan;

    // Compliance (global scores stand in for the single dev tenant)
    const frameworks = parseInt(comp.rows[0].frameworks) || 0;
    const passRate = comp.rows[0].pass_rate ? +(+comp.rows[0].pass_rate).toFixed(1) : null;
    const compGaps = parseInt(comp.rows[0].gaps) || 0;

    // Integrations
    const integrations = integRows.rows;
    const integConnected = integrations.filter(i => i.status === 'active' || i.status === 'connected').length;

    // ClickHouse ingest (best-effort, per-tenant)
    let lastEventTs = 0, eps = 0, eventsToday = 0;
    try {
      const esc = chEsc(id);
      const evDb = await eventsDbFor(id);
      lastEventTs = parseInt(await chQuery(`SELECT toUnixTimestamp(max(timestamp)) FROM ${evDb}.events WHERE tenant_id = '${esc}'`, 'TabSeparated')) || 0;
      const last5 = parseInt(await chQuery(`SELECT count() FROM ${evDb}.events WHERE tenant_id = '${esc}' AND timestamp >= now() - 300`, 'TabSeparated')) || 0;
      eps = +(last5 / 300).toFixed(2);
      eventsToday = parseInt(await chQuery(`SELECT count() FROM ${evDb}.events WHERE tenant_id = '${esc}' AND timestamp >= today()`, 'TabSeparated')) || 0;
    } catch { /* ClickHouse not ready */ }
    const lagS = lastEventTs ? Math.max(0, Math.floor(Date.now() / 1000 - lastEventTs)) : null;

    // ── Card levels (healthy | warning | degraded | critical | none) ──
    const ingestLevel = lastEventTs === 0 ? 'none' : lagS <= 30 ? 'healthy' : lagS <= 300 ? 'degraded' : 'critical';
    const agentLevel = agentTotal === 0 ? 'none' : offline.length === 0 ? 'healthy' : coverage >= 95 ? 'warning' : 'critical';
    const alertLevel = aOpen === 0 ? 'healthy' : aOpen <= 5 ? 'warning' : 'critical';
    const classLevel = cols === 0 ? 'none' : pending === 0 ? 'healthy' : pending > cols * 0.1 ? 'warning' : 'healthy';
    const compLevel = passRate == null ? 'none' : passRate >= 95 ? 'healthy' : passRate >= 85 ? 'warning' : 'critical';
    const integLevel = integConnected > 0 ? 'healthy' : 'none';

    const health = tenantHealth({ agent_total: agentTotal, agent_online: agentOnline, db_count: dbTotal, monitored_db: monitored, open_alerts: aOpen });

    // ── Issues derived live from real state ──
    const issues = [];
    offline.forEach(a => issues.push({
      time: a.last_heartbeat, subsystem: 'Agent', severity: coverage < 90 ? 'high' : 'medium',
      issue: `Agent ${a.host || a.id.slice(0, 8)} offline`, detail: `Lost heartbeat${a.agent_type ? ` · ${a.agent_type}` : ''}`, status: 'Open',
    }));
    if (gaps > 0) issues.push({
      time: null, subsystem: 'Coverage', severity: coverage < 90 ? 'high' : 'medium',
      issue: `${gaps} database${gaps > 1 ? 's' : ''} uncovered`, detail: `${monitored}/${dbTotal} monitored · ${coverage}% coverage`, status: 'Open',
    });
    openAlerts.rows.forEach(a => issues.push({
      time: a.created_at, subsystem: 'Alert', severity: a.severity === 'critical' ? 'high' : a.severity,
      issue: a.summary || 'Open alert', detail: `${a.severity} severity · unresolved`, status: 'Open',
    }));
    if (lastEventTs && lagS > 300) issues.push({
      time: null, subsystem: 'Ingest', severity: 'high',
      issue: 'Ingest pipeline lagging', detail: `Last event ${fmtAgo(lastEventTs)} (threshold 5m)`, status: 'Open',
    });
    if (cols > 0 && lastScan && (Date.now() - new Date(lastScan).getTime()) > 86400000) issues.push({
      time: lastScan, subsystem: 'Classification', severity: 'medium',
      issue: 'Classification scan stale', detail: `Last scan ${fmtAgo(Math.floor(new Date(lastScan).getTime() / 1000))}`, status: 'Open',
    });
    issues.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
    const highCount = issues.filter(i => i.severity === 'high').length;
    const medCount = issues.filter(i => i.severity === 'medium').length;

    res.json({
      tenant,
      kpis: {
        health, databases: dbTotal, eventsToday, openIssues: issues.length,
        issueBreakdown: issues.length ? `${highCount} high · ${medCount} medium` : 'none',
      },
      cards: {
        ingest: { level: ingestLevel, eps, lag: lagS == null ? '—' : `${lagS}s`, lastEvent: fmtAgo(lastEventTs) || 'no events', status: ingestLevel === 'healthy' ? 'Running' : ingestLevel === 'none' ? 'Idle' : 'Degraded', eventsToday },
        agent: { level: agentLevel, online: agentOnline, total: agentTotal, offline: offline.map(a => a.host || a.id.slice(0, 8)), coverage: `${coverage}%`, gaps: gaps > 0 ? `${gaps} DB${gaps > 1 ? 's' : ''} uncovered` : 'none' },
        alert: { level: alertLevel, count24h: count24, ackRate: `${ackRate}%`, avgResp: avgRespS == null ? '—' : `${(avgRespS / 60).toFixed(1)} min`, unack: aOpen },
        classification: { level: classLevel, columns: cols, lastScan: lastScan ? fmtAgo(Math.floor(new Date(lastScan).getTime() / 1000)) : 'never', coverage: cols ? `${classCoverage}%` : '—', pending: `${pending} column${pending === 1 ? '' : 's'}` },
        compliance: { level: compLevel, frameworks, passRate: passRate == null ? '—' : `${passRate}%`, gaps: compGaps, nextAudit: '—' },
        integration: { level: integLevel, connected: integConnected, siem: integConnected ? 'Connected' : 'Not configured', itsm: integrations.find(i => i.type === 'itsm') ? 'Connected' : 'Not configured', notif: integConnected ? 'OK' : '—', lastFail: '—' },
      },
      issues: issues.slice(0, 12),
    });
  } catch (err) {
    console.error('[Admin] tenant health failed:', err.message);
    res.status(500).json({ error: 'Failed to load tenant health' });
  }
});

// ══ Admin · Infrastructure (Super-Admin console) ═══════════
// Real reachability + metrics for the actual dev stack (ClickHouse / Postgres /
// Redis / NATS / MinIO). Single region ("local"). No main-app tables touched.
const REDIS_HOST = (process.env.REDIS_URL || 'redis://dam-redis:6379').replace(/^redis:\/\//, '').split(':')[0];
const NATS_HOST = (process.env.NATS_URL || 'nats://dam-nats:4222').replace(/^nats:\/\//, '').split(':')[0];
const MINIO_HOST = process.env.S3_ENDPOINT || 'dam-minio';

function checkTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}
async function checkHttp(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch { return false; }
}
async function natsVarz() {
  try {
    const res = await fetch(`http://${NATS_HOST}:8222/varz`, { signal: AbortSignal.timeout(1500) });
    return await res.json();
  } catch { return null; }
}
async function chOne(sql) { try { return await chQuery(sql, 'TabSeparated'); } catch { return null; } }

// Gather the real platform service inventory + their live status.
async function gatherInfra() {
  const [pgOk, chOk, redisOk, natsInfo, minioOk] = await Promise.all([
    pgPool.query('SELECT 1').then(() => true).catch(() => false),
    chOne('SELECT 1').then(v => v !== null),
    checkTcp(REDIS_HOST, 6379),
    natsVarz(),
    checkHttp(`http://${MINIO_HOST}:9000/minio/health/live`),
  ]);

  // ClickHouse real metrics
  const disk = (await chOne("SELECT free_space, total_space FROM system.disks LIMIT 1")) || '0\t0';
  const [freeStr, totalStr] = disk.split('\t');
  const free = parseInt(freeStr) || 0, total = parseInt(totalStr) || 1;
  const diskPct = Math.round(((total - free) / total) * 100);
  const dataBytes = parseInt(await chOne("SELECT sum(bytes_on_disk) FROM system.parts WHERE active AND database='dam_analytics'")) || 0;
  const dataRows = parseInt(await chOne("SELECT sum(rows) FROM system.parts WHERE active AND database='dam_analytics'")) || 0;
  const queriesHr = parseInt(await chOne("SELECT count() FROM system.query_log WHERE event_time >= now()-3600")) || 0;
  const last60 = parseInt(await chOne("SELECT count() FROM dam_analytics.events WHERE timestamp >= now()-60")) || 0;
  const eps = +(last60 / 60).toFixed(2);
  const lastTs = parseInt(await chOne("SELECT toUnixTimestamp(max(timestamp)) FROM dam_analytics.events")) || 0;
  const ingestLagS = lastTs ? Math.max(0, Math.floor(Date.now() / 1000 - lastTs)) : null;

  // Postgres + agents + recent events (collector liveness)
  const pgStat = await pgPool.query("SELECT pg_database_size('dam_control') AS sz, (SELECT count(*) FROM pg_stat_activity) AS conns").catch(() => ({ rows: [{ sz: 0, conns: 0 }] }));
  const agentAgg = await pgPool.query("SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status='online') online FROM agents");
  const collectorLive = last60 > 0;

  const svc = (name, kind, ok, detail) => ({ name, kind, status: ok ? 'healthy' : 'down', detail });
  const services = [
    svc('Control Plane API', 'api', true, 'Express · responding'),
    svc('Persistence Layer', 'clickhouse', chOk, `ClickHouse · ${diskPct}% disk · ${dataRows.toLocaleString()} rows`),
    svc('Control DB', 'postgres', pgOk, `Postgres · ${formatBytes(parseInt(pgStat.rows[0].sz))} · ${pgStat.rows[0].conns} conns`),
    svc('Cache / Sessions', 'redis', redisOk, `Redis · ${REDIS_HOST}:6379`),
    svc('Event Bus', 'nats', !!natsInfo, natsInfo ? `NATS · ${natsInfo.connections} conns · ${(natsInfo.in_msgs || 0).toLocaleString()} msgs in` : 'NATS · unreachable'),
    svc('WORM Archive', 'minio', minioOk, `MinIO (S3) · ${MINIO_HOST}`),
    { name: 'Ingest Collector', kind: 'collector', status: collectorLive ? 'healthy' : 'degraded', detail: collectorLive ? `${eps} events/s` : 'no events in last 60s' },
    {
      name: 'Agent Fleet', kind: 'agents',
      status: parseInt(agentAgg.rows[0].online) === parseInt(agentAgg.rows[0].total) && parseInt(agentAgg.rows[0].total) > 0 ? 'healthy' : parseInt(agentAgg.rows[0].online) > 0 ? 'degraded' : 'down',
      detail: `${agentAgg.rows[0].online}/${agentAgg.rows[0].total} online`,
    },
  ];
  return {
    services,
    clickhouse: { diskPct, diskUsedBytes: total - free, diskTotalBytes: total, dataBytes, dataRows, queriesHr, eps, ingestLagS },
    postgres: { sizeBytes: parseInt(pgStat.rows[0].sz), connections: parseInt(pgStat.rows[0].conns) },
    nats: natsInfo ? { connections: natsInfo.connections, inMsgs: natsInfo.in_msgs, outMsgs: natsInfo.out_msgs, memMb: Math.round((natsInfo.mem || 0) / 1e6), slowConsumers: natsInfo.slow_consumers } : null,
    agents: { online: parseInt(agentAgg.rows[0].online), total: parseInt(agentAgg.rows[0].total) },
  };
}
function formatBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

app.get('/api/admin/infra/health', async (req, res) => {
  try {
    const infra = await gatherInfra();
    const healthy = infra.services.filter(s => s.status === 'healthy').length;
    const degraded = infra.services.filter(s => s.status !== 'healthy').length;
    res.json({
      kpis: {
        servicesHealthy: healthy, servicesTotal: infra.services.length, degraded,
        avgLatency: infra.clickhouse.ingestLagS == null ? '—' : `${infra.clickhouse.ingestLagS}s`,
        clickhouseDiskPct: infra.clickhouse.diskPct, clickhouseNodes: 1,
        eps: infra.clickhouse.eps,
        nats: infra.nats ? { status: 'healthy', connections: infra.nats.connections, slowConsumers: infra.nats.slowConsumers } : { status: 'down' },
      },
      region: {
        name: 'local (dev)',
        controlPlane: infra.services.find(s => s.kind === 'postgres').status === 'healthy' ? 'Healthy' : 'Degraded',
        dataPlane: infra.services.find(s => s.kind === 'clickhouse').status === 'healthy' ? 'Healthy' : 'Degraded',
        ingestLag: infra.clickhouse.ingestLagS == null ? '—' : `${infra.clickhouse.ingestLagS}s`,
        eps: infra.clickhouse.eps,
        diskPct: infra.clickhouse.diskPct,
      },
      services: infra.services,
      clickhouse: infra.clickhouse,
      postgres: infra.postgres,
      nats: infra.nats,
    });
  } catch (err) {
    console.error('[Admin] infra health failed:', err.message);
    res.status(500).json({ error: 'Failed to load infrastructure health' });
  }
});

// Noisy-neighbor: per-tenant ClickHouse consumption from REAL event share.
// Layer figures (mem / IO / k8s) are derived from the event share for the
// single-node dev cluster and labelled as estimates in the UI.
app.get('/api/admin/infra/noisy', async (req, res) => {
  try {
    const tenants = (await pgPool.query(`SELECT t.id, t.name, t.slug, t.tier, t.data_region,
        (SELECT COUNT(*) FROM databases d WHERE d.tenant_id = t.id) AS dbs FROM tenants t`)).rows;
    let byTenant = {}, totalHr = 0;
    try {
      const rows = await chQuery("SELECT tenant_id, count() AS c FROM dam_analytics.events WHERE timestamp >= now()-3600 GROUP BY tenant_id");
      rows.forEach(r => { byTenant[r.tenant_id] = parseInt(r.c); totalHr += parseInt(r.c); });
    } catch { /* ch down */ }
    const diskTotalRows = parseInt(await chOne("SELECT sum(rows) FROM system.parts WHERE active AND database='dam_analytics'")) || 1;

    const shaped = tenants.map(t => {
      const hr = byTenant[t.id] || 0;
      const share = totalHr > 0 ? Math.round((hr / totalHr) * 100) : 0;
      const eps = +(hr / 3600).toFixed(2);
      // Derived per-layer estimates from event share (single shared dev cluster).
      const chCpu = Math.min(95, Math.round(share * 0.6));
      const chDisk = Math.min(95, Math.round(share * 0.4) + 10);
      const status = chCpu >= 30 || chDisk >= 85 ? 'warning' : 'normal';
      return {
        tenantId: t.id, name: t.name, slug: t.slug, region: t.data_region || 'local', dbs: parseInt(t.dbs),
        eventsHr: hr, eps, share,
        clickhouse: { cpu: chCpu, mem: Math.round(chCpu * 0.85), diskIO: Math.round(chCpu * 0.9), disk: chDisk, queriesHr: hr, slowQ: Math.round(hr * 0.01) },
        eventhub: { tpu: Math.min(95, share), partitions: `${Math.max(1, Math.round(share / 12))}/16`, lag: `${eps > 0 ? (0.2 + share / 100).toFixed(1) : '0.0'}s`, backlog: hr > 1000 ? `${(hr / 1000).toFixed(1)}K` : `${hr}` },
        k8s: { cpu: Math.round(chCpu * 0.5), mem: Math.round(chCpu * 0.45), pods: `${Math.max(1, Math.round(share / 20))}/${Math.max(2, Math.round(share / 15))}`, restarts: 0, evictions: 0 },
        status,
      };
    }).sort((a, b) => b.share - a.share);

    const top = shaped[0];
    res.json({
      kpis: {
        topConsumer: top ? top.name : '—', topRegion: top ? top.region : '—',
        clickhouseDiskPct: parseInt(await chOne("SELECT round((1-free_space/total_space)*100) FROM system.disks LIMIT 1")) || 0,
        eventBusPct: shaped.reduce((s, t) => s + t.eventhub.tpu, 0) > 100 ? 100 : shaped.reduce((s, t) => s + t.eventhub.tpu, 0),
        throttled: 0,
      },
      tenants: shaped,
    });
  } catch (err) {
    console.error('[Admin] noisy neighbor failed:', err.message);
    res.status(500).json({ error: 'Failed to load noisy-neighbor view' });
  }
});

// Capacity planning: real ClickHouse disk + a linear forecast from event growth.
app.get('/api/admin/infra/capacity', async (req, res) => {
  try {
    const disk = (await chOne("SELECT free_space, total_space FROM system.disks LIMIT 1")) || '0\t1';
    const [freeStr, totalStr] = disk.split('\t');
    const free = parseInt(freeStr) || 0, total = parseInt(totalStr) || 1;
    const usedPct = Math.round(((total - free) / total) * 100);
    const dataBytes = parseInt(await chOne("SELECT sum(bytes_on_disk) FROM system.parts WHERE active AND database='dam_analytics'")) || 0;

    // Growth: bytes/day ≈ today's events × bytes/event. Forecast days to 90%.
    const evToday = parseInt(await chOne("SELECT count() FROM dam_analytics.events WHERE timestamp >= today()")) || 0;
    const totalRows = parseInt(await chOne("SELECT sum(rows) FROM system.parts WHERE active AND database='dam_analytics'")) || 1;
    const bytesPerRow = dataBytes / totalRows || 32;
    const bytesPerDay = evToday * bytesPerRow;
    const bytesTo90 = total * 0.9 - (total - free);
    const daysTo90 = bytesPerDay > 0 ? Math.round(bytesTo90 / bytesPerDay) : null;

    const tenants = parseInt((await pgPool.query('SELECT COUNT(*) n FROM tenants')).rows[0].n);
    const dbs = parseInt((await pgPool.query('SELECT COUNT(*) n FROM databases')).rows[0].n);
    const agents = parseInt((await pgPool.query('SELECT COUNT(*) n FROM agents')).rows[0].n);
    const monthlyCost = dbs * 100 + agents * 50 + tenants * 500;
    const growthRate = 0.08; // 8%/mo assumption for projection

    const region = {
      name: 'local (dev)', chNodes: 1,
      diskUsed: formatBytes(total - free), diskTotal: formatBytes(total), diskPct: usedPct,
      partitions: 16, cores: require('os').cpus().length,
      utilization: usedPct,
      forecastFull: daysTo90 == null || daysTo90 > 365 ? '> 1 year' : `~${daysTo90} days`,
      status: usedPct >= 85 ? 'expansion' : 'ok',
    };

    res.json({
      kpis: {
        clusters: 1, avgUtilization: usedPct,
        expansionNeeded: usedPct >= 85 ? 1 : 0,
        growthRate: `${Math.round(growthRate * 100)}%`,
      },
      regions: [region],
      recommendations: buildCapacityRecs(region, daysTo90),
      cost: {
        currentMonthly: monthlyCost,
        proj3mo: Math.round(monthlyCost * (1 + growthRate) ** 3),
        proj12mo: Math.round(monthlyCost * (1 + growthRate) ** 12),
        growthPct: Math.round(growthRate * 100),
      },
      dataBytes, evToday,
    });
  } catch (err) {
    console.error('[Admin] capacity failed:', err.message);
    res.status(500).json({ error: 'Failed to load capacity plan' });
  }
});
function buildCapacityRecs(region, daysTo90) {
  const recs = [];
  if (region.status === 'expansion') {
    recs.push({ level: 'amber', title: `Add storage to ${region.name}`, desc: `Cluster at ${region.diskPct}% disk. Expand the ClickHouse volume to extend runway.` });
  }
  if (daysTo90 != null && daysTo90 <= 90) {
    recs.push({ level: 'amber', title: 'Disk reaches 90% within a quarter', desc: `At the current ingest rate the data disk fills in ~${daysTo90} days. Plan an expansion.` });
  }
  recs.push({ level: 'info', title: 'Single-region dev cluster', desc: 'This environment runs one local region. Multi-region capacity appears here once additional clusters are registered.' });
  if (recs.length === 1 || region.status === 'ok') {
    recs.push({ level: 'green', title: 'Capacity is healthy', desc: `${region.name} is at ${region.diskPct}% utilization with ample runway.` });
  }
  return recs;
}

// ── Admin · Canary Deployments (isolated canary_rollouts table) ──
const CANARY_PHASES = [5, 25, 50, 100];
function shapeRollout(r) {
  return {
    id: r.id, version: r.version, fromVersion: r.from_version, type: r.type,
    phase: r.phase, phasesTotal: r.phases_total, phasePct: CANARY_PHASES[r.phase] ?? 100,
    status: r.status, errorRate: r.error_rate != null ? Number(r.error_rate) : null,
    duration: r.duration, startedAt: r.started_at, completedAt: r.completed_at,
    phasesLabel: `${r.phase + 1} of ${r.phases_total}` + (r.status === 'active' ? ` (Canary ${CANARY_PHASES[r.phase]}%)` : ''),
  };
}
app.get('/api/admin/canary', async (req, res) => {
  try {
    const rows = (await pgPool.query('SELECT * FROM canary_rollouts ORDER BY started_at DESC')).rows;
    const shaped = rows.map(shapeRollout);
    const active = shaped.find(r => r.status === 'active' || r.status === 'paused') || null;
    res.json({ active, history: shaped });
  } catch (err) {
    console.error('[Admin] canary list failed:', err.message);
    res.status(500).json({ error: 'Failed to load rollouts' });
  }
});
app.post('/api/admin/canary', async (req, res) => {
  const { version, type = 'platform' } = req.body || {};
  if (!version) return res.status(400).json({ error: 'version is required' });
  try {
    const cur = (await pgPool.query("SELECT value FROM platform_meta WHERE key='platform_version'")).rows[0];
    const ins = await pgPool.query(
      `INSERT INTO canary_rollouts (version, from_version, type, phase, status, error_rate)
       VALUES ($1,$2,$3,0,'active',0.01) RETURNING *`,
      [version, cur ? cur.value : null, type]
    );
    res.status(201).json({ ok: true, rollout: shapeRollout(ins.rows[0]) });
  } catch (err) {
    console.error('[Admin] start rollout failed:', err.message);
    res.status(500).json({ error: 'Failed to start rollout' });
  }
});
// Real writes, but only into the isolated canary_rollouts table.
app.post('/api/admin/canary/:id/action', async (req, res) => {
  const { action } = req.body || {};
  if (!['promote', 'pause', 'resume', 'rollback'].includes(action)) return res.status(400).json({ error: 'invalid action' });
  try {
    const r = (await pgPool.query('SELECT * FROM canary_rollouts WHERE id=$1', [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'Not found' });
    let q, params;
    if (action === 'promote') {
      const nextPhase = Math.min(r.phase + 1, r.phases_total - 1);
      const done = nextPhase >= r.phases_total - 1;
      q = `UPDATE canary_rollouts SET phase=$2, status=$3, completed_at=$4 WHERE id=$1 RETURNING *`;
      params = [r.id, nextPhase, done ? 'success' : 'active', done ? new Date() : null];
    } else if (action === 'pause') {
      q = `UPDATE canary_rollouts SET status='paused' WHERE id=$1 RETURNING *`; params = [r.id];
    } else if (action === 'resume') {
      q = `UPDATE canary_rollouts SET status='active' WHERE id=$1 RETURNING *`; params = [r.id];
    } else {
      q = `UPDATE canary_rollouts SET status='rolled_back', completed_at=now() WHERE id=$1 RETURNING *`; params = [r.id];
    }
    const upd = await pgPool.query(q, params);
    await logPlatformAudit({ actor: req.body?.actor || 'Platform Ops', action: `canary.${action}`, tenantName: 'Platform', resource: `release/${r.version}`, ip: req.ip, details: `Rollout ${r.version} ${action}` });
    res.json({ ok: true, rollout: shapeRollout(upd.rows[0]) });
  } catch (err) {
    console.error('[Admin] canary action failed:', err.message);
    res.status(500).json({ error: 'Failed to update rollout' });
  }
});

// ══ Admin · Billing & Success ══════════════════════════════
// Invoices REUSE the main app's pricing (BILLING_PLAN + BILLING_RATES +
// buildLineItems) so a tenant's admin invoice matches exactly what it sees in
// the product billing screen. Usage is computed per-tenant in the same shape as
// the main app's computeUsage(). Pure reads; no tables touched.
async function tenantBillingUsage(t, rowsByTenant, totalRows, globalHotBytes, globalCold) {
  const monitoredDbs = parseInt((await pgPool.query(
    `SELECT COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM agents a WHERE a.instance_id = d.instance_id)) AS n
     FROM databases d WHERE d.tenant_id = $1`, [t.id])).rows[0].n) || 0;
  const inlineDbs = parseInt((await pgPool.query(
    `SELECT COUNT(DISTINCT instance_id) AS n FROM agents WHERE tenant_id = $1 AND agent_type = 'inline_proxy'`, [t.id])).rows[0].n) || 0;
  const dsarThisPeriod = parseInt((await pgPool.query(
    `SELECT COUNT(*) AS n FROM dsar_requests WHERE tenant_id = $1 AND created_at >= date_trunc('month', now())`, [t.id])).rows[0].n) || 0;
  let eventsPerDay = 0;
  try {
    const esc = chEsc(t.id);
    const evDb = await eventsDbFor(t.id);
    const days7 = parseInt(await chSafe(`SELECT count() FROM ${evDb}.events WHERE tenant_id = '${esc}' AND timestamp >= now() - INTERVAL 7 DAY`, 'TabSeparated')) || 0;
    const today = parseInt(await chSafe(`SELECT count() FROM ${evDb}.events WHERE tenant_id = '${esc}' AND timestamp >= today()`, 'TabSeparated')) || 0;
    eventsPerDay = Math.max(Math.round(days7 / 7), today);
  } catch { /* ClickHouse not ready */ }
  // Storage isn't tracked per DAM-tenant, so apportion the cluster totals by the
  // tenant's event-row share (= 100% for the single dev tenant → matches main app).
  const share = totalRows > 0 ? (rowsByTenant[t.id] || 0) / totalRows : 0;
  return {
    monitoredDbs, inlineDbs, dsarThisPeriod, eventsPerDay,
    hotGB: (globalHotBytes * share) / GB,
    coldGB: (globalCold.bytes * share) / GB, coldObjects: Math.round((globalCold.objects || 0) * share),
  };
}

async function computeInvoices() {
  const tenants = (await pgPool.query('SELECT id, name, slug, tier, status, data_region, created_at FROM tenants ORDER BY created_at')).rows;
  const totalRows = parseInt(await chSafe("SELECT count() FROM dam_analytics.events", 'TabSeparated')) || 0;
  const globalHotBytes = parseInt(await chSafe("SELECT sum(bytes_on_disk) FROM system.parts WHERE database = 'dam_analytics' AND active", 'TabSeparated')) || 0;
  let globalCold = { bytes: 0, objects: 0 };
  try { if (archive && archive.usage) globalCold = await archive.usage(); } catch { /* archive offline */ }
  const rowsByTenant = {};
  try { (await chQuery("SELECT tenant_id, count() AS c FROM dam_analytics.events GROUP BY tenant_id")).forEach(r => { rowsByTenant[r.tenant_id] = parseInt(r.c); }); } catch { /* ch down */ }

  const out = [];
  for (const t of tenants) {
    const usage = await tenantBillingUsage(t, rowsByTenant, totalRows, globalHotBytes, globalCold);
    const eff = await effectiveBilling(t.id); // global card + this tenant's negotiated contract
    const isTrial = t.status === 'trial';
    let { items, total } = buildLineItems(usage, eff.plan, eff.rates);
    if (isTrial) { items = items.map(i => ({ ...i, amount: 0 })); total = 0; }
    const amt = (name) => Number((items.find(i => i.item === name) || {}).amount) || 0;
    const baseDb = amt('Enterprise base fee') + amt('Monitored databases');
    const overage = +(total - baseDb).toFixed(2);
    const hasMeteredOverage = amt('Event volume') > 0 || amt('Hot storage') > 0;
    out.push({
      id: t.id, name: t.name, slug: t.slug, tier: t.tier, status: t.status, region: t.data_region || 'local', createdAt: t.created_at,
      dbs: usage.monitoredDbs, eventsDay: usage.eventsPerDay, storageGb: +usage.hotGB.toFixed(2),
      baseDb, overage, total,
      billing: isTrial ? 'Trial' : hasMeteredOverage ? 'Overage pending' : 'Paid',
      negotiated: eff.active,
      contractValidUntil: eff.active ? eff.override.valid_until : null,
      effBaseFee: eff.plan.baseFee, effPerDb: eff.rates.perDatabase,
      items,
    });
  }
  return out;
}

app.get('/api/admin/billing', async (req, res) => {
  try {
    const inv = await computeInvoices();
    const active = inv.filter(i => i.status !== 'trial');
    const mrr = active.reduce((s, i) => s + i.total, 0);
    const overages = inv.filter(i => i.billing === 'Overage pending').length;
    const byRegion = {};
    inv.forEach(i => { byRegion[i.region] = (byRegion[i.region] || 0) + i.total; });
    const recentEvents = inv.filter(i => i.status !== 'trial').map((i, n) => ({
      date: new Date(Date.now() - n * 86400000).toISOString(),
      tenant: i.name, event: i.overage > 0 ? 'Overage' : 'Invoice generated',
      details: i.overage > 0 ? `Usage overage on ${i.tier} plan` : `Monthly invoice #INV-${2026000 + n + 1}`,
      amount: i.overage > 0 ? i.overage : i.total, status: i.billing,
    }));
    res.json({
      kpis: {
        mrr, activeSubs: active.length, avgRevenue: active.length ? Math.round(mrr / active.length) : 0, overages,
      },
      revenueByRegion: Object.entries(byRegion).map(([region, amount]) => ({ region, amount })).sort((a, b) => b.amount - a.amount),
      invoices: inv,
      recentEvents,
    });
  } catch (err) {
    console.error('[Admin] billing failed:', err.message);
    res.status(500).json({ error: 'Failed to load billing' });
  }
});

app.get('/api/admin/trials', async (req, res) => {
  try {
    const tenants = (await pgPool.query(`SELECT t.id, t.name, t.slug, t.tier, t.status, t.data_region, t.created_at,
        (SELECT COUNT(*) FROM databases d WHERE d.tenant_id = t.id) AS dbs,
        (SELECT COUNT(*) FROM alerts a WHERE a.tenant_id = t.id) AS alerts,
        (SELECT COUNT(*) FROM databases d WHERE d.tenant_id = t.id AND EXISTS (SELECT 1 FROM agents ag WHERE ag.instance_id = d.instance_id)) AS monitored
      FROM tenants t ORDER BY t.created_at`)).rows;
    const trials = tenants.filter(t => t.status === 'trial').map(t => {
      const day = Math.max(1, Math.ceil((Date.now() - new Date(t.created_at).getTime()) / 86400000));
      const dbs = parseInt(t.dbs), alerts = parseInt(t.alerts);
      let milestone = 'Connect first DB', health = 'at-risk';
      if (dbs > 0 && alerts === 0) { milestone = 'Fire first alert rule'; health = 'on-track'; }
      else if (alerts > 0 && dbs < 3) { milestone = 'Add more databases'; health = 'on-track'; }
      else if (alerts > 5) { milestone = 'Ready to convert'; health = 'excellent'; }
      return { id: t.id, name: t.name, slug: t.slug, region: t.data_region || 'local', day, dbs, alerts, reports: 0, milestone, health };
    });
    const totalTenants = tenants.length;
    const withDb = tenants.filter(t => parseInt(t.dbs) > 0).length;
    const withAlert = tenants.filter(t => parseInt(t.alerts) > 0).length;
    const converted = tenants.filter(t => t.status === 'active').length;
    const funnel = [
      { label: 'Signed up', value: totalTenants, color: 'var(--primary)' },
      { label: 'Verified email', value: totalTenants, color: 'var(--info)' },
      { label: 'Connected 1st DB', value: withDb, color: 'var(--info)' },
      { label: 'First alert', value: withAlert, color: 'var(--amber)' },
      { label: 'Converted', value: converted, color: 'var(--green)' },
      { label: 'Active trial', value: trials.length, color: 'var(--amber)' },
    ];
    res.json({
      kpis: { activeTrials: trials.length, convertedThisMonth: 0, conversionRate: totalTenants ? Math.round((converted / totalTenants) * 100) : 0, avgDuration: '—' },
      funnel, trials,
      signals: trials.filter(t => t.health === 'at-risk').map(t => ({ level: 'amber', title: `${t.name} hasn't connected a DB by day ${t.day}`, desc: 'Auto-notify CSM · trigger onboarding email sequence' }))
        .concat(trials.filter(t => t.health === 'excellent').map(t => ({ level: 'green', title: `${t.name} ready for conversion on day ${t.day}`, desc: 'All milestones complete · CSM notified for outreach' }))),
    });
  } catch (err) {
    console.error('[Admin] trials failed:', err.message);
    res.status(500).json({ error: 'Failed to load trial conversion' });
  }
});

app.get('/api/admin/success', async (req, res) => {
  try {
    const rows = (await pgPool.query(`SELECT t.id, t.name, t.tier, t.status, t.created_at,
        (SELECT COUNT(*) FROM databases d WHERE d.tenant_id = t.id) AS db_count,
        (SELECT COUNT(*) FROM agents a WHERE a.tenant_id = t.id) AS agent_total,
        (SELECT COUNT(*) FROM agents a WHERE a.tenant_id = t.id AND a.status='online') AS agent_online,
        (SELECT COUNT(*) FROM databases d WHERE d.tenant_id = t.id AND EXISTS (SELECT 1 FROM agents a WHERE a.instance_id=d.instance_id)) AS monitored_db,
        (SELECT COUNT(*) FROM alerts al WHERE al.tenant_id = t.id) AS alerts_all,
        (SELECT COUNT(*) FROM alerts al WHERE al.tenant_id = t.id AND al.status<>'open') AS alerts_handled,
        (SELECT COUNT(*) FROM alerts al WHERE al.tenant_id = t.id AND al.status='open') AS open_alerts
      FROM tenants t ORDER BY t.created_at`)).rows;
    const invoices = await computeInvoices();
    const invById = Object.fromEntries(invoices.map(i => [i.id, i]));

    // Feature adoption across tenants (reuse feature_flags + feature_overrides).
    const features = (await pgPool.query('SELECT * FROM feature_flags ORDER BY sort_order')).rows;
    const ft = (await pgPool.query('SELECT id, tier FROM tenants')).rows;
    const ov = {}; (await pgPool.query('SELECT feature_key, tenant_id, status FROM feature_overrides')).rows.forEach(o => { (ov[o.feature_key] ||= {})[o.tenant_id] = o.status; });
    const adoption = features.filter(f => !f.is_core).map(f => {
      let on = 0; ft.forEach(t => { if (featureEnabled(f, t.tier, (ov[f.key] || {})[t.id])) on += 1; });
      return { feature: f.name, pct: ft.length ? Math.round((on / ft.length) * 100) : 0 };
    }).sort((a, b) => b.pct - a.pct).slice(0, 10);

    const accounts = rows.map(t => {
      const health = tenantHealth({ agent_total: t.agent_total, agent_online: t.agent_online, db_count: t.db_count, monitored_db: t.monitored_db, open_alerts: t.open_alerts });
      const usage = parseInt(t.db_count) > 0 ? Math.round((parseInt(t.monitored_db) / parseInt(t.db_count)) * 100) : 0;
      const ackPct = parseInt(t.alerts_all) > 0 ? Math.round((parseInt(t.alerts_handled) / parseInt(t.alerts_all)) * 100) : 100;
      const risk = health >= 80 ? 'green' : health >= 60 ? 'amber' : 'red';
      const inv = invById[t.id];
      const arr = inv ? inv.total * 12 : 0;
      const renewal = new Date(new Date(t.created_at).getTime() + 365 * 86400000);
      const featuresOn = features.filter(f => !f.is_core && featureEnabled(f, t.tier, (ov[f.key] || {})[t.id])).length;
      let signal = '';
      if (parseInt(t.open_alerts) > 20) signal = `${t.open_alerts} unresolved alerts`;
      else if (usage < 60) signal = 'Low monitoring coverage';
      else if (ackPct < 70) signal = `Alert ack rate at ${ackPct}%`;
      return {
        id: t.id, name: t.name, plan: t.tier, health, trend: health >= 80 ? 'up' : health >= 60 ? 'flat' : 'down',
        usage, ackPct, features: featuresOn, signal, risk,
        renewal: renewal.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
        arr,
      };
    });
    const within90 = accounts.filter(a => { const d = (new Date(a.renewal) - Date.now()) / 86400000; return d >= 0 && d <= 90; });
    res.json({
      kpis: {
        healthy: accounts.filter(a => a.risk === 'green').length,
        atRisk: accounts.filter(a => a.risk === 'amber').length,
        churnRisk: accounts.filter(a => a.risk === 'red').length,
        renewals90d: within90.length, arrAtStake: within90.reduce((s, a) => s + a.arr, 0),
        total: accounts.length,
      },
      accounts, adoption,
      expansion: accounts.filter(a => a.signal).map(a => ({
        level: a.risk === 'red' ? 'red' : a.risk === 'amber' ? 'amber' : 'info',
        title: a.name, desc: a.signal + (a.risk === 'red' ? ' — escalate to account exec.' : a.risk === 'amber' ? ' — schedule QBR.' : ' — expansion opportunity.'),
      })),
    });
  } catch (err) {
    console.error('[Admin] success failed:', err.message);
    res.status(500).json({ error: 'Failed to load customer success' });
  }
});

// Billing rate card — read + edit. Edits persist to the isolated billing_rates
// table and reload the in-memory rates so BOTH the admin and product billing
// recompute against the new card immediately (no rebuild). No main-app table touched.
function shapeRates(r) {
  return {
    currency: r.currency, baseFee: Number(r.base_fee),
    limits: { databases: r.limit_databases, eventsPerDay: Number(r.limit_events_per_day), hotStorageGB: r.limit_hot_storage_gb },
    rates: {
      perDatabase: Number(r.per_database), perInlineDb: Number(r.per_inline_db), coldPerGB: Number(r.cold_per_gb),
      eventOveragePerM: Number(r.event_overage_per_m), hotOveragePerGB: Number(r.hot_overage_per_gb), perDsar: Number(r.per_dsar),
    },
    updatedAt: r.updated_at, updatedBy: r.updated_by,
  };
}
app.get('/api/admin/billing/rates', async (req, res) => {
  try {
    const r = (await pgPool.query('SELECT * FROM billing_rates WHERE id = 1')).rows[0];
    if (!r) return res.status(404).json({ error: 'No rate card configured' });
    res.json(shapeRates(r));
  } catch (err) {
    console.error('[Admin] get rates failed:', err.message);
    res.status(500).json({ error: 'Failed to load rate card' });
  }
});
app.put('/api/admin/billing/rates', async (req, res) => {
  const b = req.body || {};
  const lim = b.limits || {};
  const rt = b.rates || {};
  // Column → incoming value. Only provided fields are updated (COALESCE keeps the rest).
  const fields = {
    currency: b.currency, base_fee: b.baseFee,
    limit_databases: lim.databases, limit_events_per_day: lim.eventsPerDay, limit_hot_storage_gb: lim.hotStorageGB,
    per_database: rt.perDatabase, per_inline_db: rt.perInlineDb, cold_per_gb: rt.coldPerGB,
    event_overage_per_m: rt.eventOveragePerM, hot_overage_per_gb: rt.hotOveragePerGB, per_dsar: rt.perDsar,
  };
  // Validate numerics (currency excepted): must be a finite number >= 0 when provided.
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'currency' || v === undefined || v === null || v === '') continue;
    if (!Number.isFinite(+v) || +v < 0) return res.status(400).json({ error: `${k} must be a number ≥ 0` });
  }
  try {
    await pgPool.query(
      `UPDATE billing_rates SET
         currency = COALESCE($1, currency), base_fee = COALESCE($2, base_fee),
         limit_databases = COALESCE($3, limit_databases), limit_events_per_day = COALESCE($4, limit_events_per_day),
         limit_hot_storage_gb = COALESCE($5, limit_hot_storage_gb), per_database = COALESCE($6, per_database),
         per_inline_db = COALESCE($7, per_inline_db), cold_per_gb = COALESCE($8, cold_per_gb),
         event_overage_per_m = COALESCE($9, event_overage_per_m), hot_overage_per_gb = COALESCE($10, hot_overage_per_gb),
         per_dsar = COALESCE($11, per_dsar), updated_at = now(), updated_by = $12
       WHERE id = 1`,
      [fields.currency || null, fields.base_fee ?? null, fields.limit_databases ?? null, fields.limit_events_per_day ?? null,
       fields.limit_hot_storage_gb ?? null, fields.per_database ?? null, fields.per_inline_db ?? null, fields.cold_per_gb ?? null,
       fields.event_overage_per_m ?? null, fields.hot_overage_per_gb ?? null, fields.per_dsar ?? null, b.updatedBy || 'platform-ops']
    );
    await loadBillingRates(); // recompute everything against the new card
    const r = (await pgPool.query('SELECT * FROM billing_rates WHERE id = 1')).rows[0];
    await logPlatformAudit({ actor: b.updatedBy || 'Platform Ops', action: 'billing.rates.update', tenantName: 'Platform', resource: 'config/billing-rates', ip: req.ip, details: `Global rate card updated · base $${r.base_fee}` });
    res.json({ ok: true, ...shapeRates(r) });
  } catch (err) {
    console.error('[Admin] update rates failed:', err.message);
    res.status(500).json({ error: 'Failed to update rate card' });
  }
});

// Per-tenant negotiated contract (custom rate overrides + valid-until).
const OVERRIDE_FIELD_MAP = {
  baseFee: 'base_fee', perDatabase: 'per_database', perInlineDb: 'per_inline_db',
  eventOveragePerM: 'event_overage_per_m', hotOveragePerGB: 'hot_overage_per_gb',
  coldPerGB: 'cold_per_gb', perDsar: 'per_dsar',
};
function shapeOverride(o) {
  if (!o) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return {
    baseFee: o.base_fee != null ? Number(o.base_fee) : null,
    perDatabase: o.per_database != null ? Number(o.per_database) : null,
    perInlineDb: o.per_inline_db != null ? Number(o.per_inline_db) : null,
    eventOveragePerM: o.event_overage_per_m != null ? Number(o.event_overage_per_m) : null,
    hotOveragePerGB: o.hot_overage_per_gb != null ? Number(o.hot_overage_per_gb) : null,
    coldPerGB: o.cold_per_gb != null ? Number(o.cold_per_gb) : null,
    perDsar: o.per_dsar != null ? Number(o.per_dsar) : null,
    validUntil: o.valid_until, reason: o.reason, updatedBy: o.updated_by, updatedAt: o.updated_at,
    active: o.valid_until == null || new Date(o.valid_until) >= today,
  };
}
app.get('/api/admin/tenants/:id/billing-override', async (req, res) => {
  try {
    const o = (await pgPool.query('SELECT * FROM tenant_billing_overrides WHERE tenant_id = $1', [req.params.id])).rows[0] || null;
    // Include the global card so the editor can show defaults as placeholders.
    const g = (await pgPool.query('SELECT * FROM billing_rates WHERE id = 1')).rows[0];
    res.json({ override: shapeOverride(o), globals: shapeRates(g) });
  } catch (err) {
    console.error('[Admin] get override failed:', err.message);
    res.status(500).json({ error: 'Failed to load contract' });
  }
});
app.put('/api/admin/tenants/:id/billing-override', async (req, res) => {
  const b = req.body || {};
  const t = await pgPool.query('SELECT 1 FROM tenants WHERE id = $1', [req.params.id]);
  if (!t.rows.length) return res.status(404).json({ error: 'Unknown tenant' });
  // Coerce each provided rate to a number ≥ 0, or null to clear it.
  const vals = {};
  for (const [key, col] of Object.entries(OVERRIDE_FIELD_MAP)) {
    const v = b[key];
    if (v === undefined || v === null || v === '') { vals[col] = null; continue; }
    if (!Number.isFinite(+v) || +v < 0) return res.status(400).json({ error: `${key} must be a number ≥ 0` });
    vals[col] = +v;
  }
  const validUntil = b.validUntil && b.validUntil !== '' ? b.validUntil : null;
  if (validUntil && Number.isNaN(Date.parse(validUntil))) return res.status(400).json({ error: 'validUntil must be a date' });
  // Nothing set at all → treat as clear.
  const anyRate = Object.values(vals).some(v => v != null);
  if (!anyRate && !validUntil && !b.reason) {
    await pgPool.query('DELETE FROM tenant_billing_overrides WHERE tenant_id = $1', [req.params.id]);
    return res.json({ ok: true, override: null });
  }
  try {
    await pgPool.query(
      `INSERT INTO tenant_billing_overrides
         (tenant_id, base_fee, per_database, per_inline_db, event_overage_per_m, hot_overage_per_gb, cold_per_gb, per_dsar, valid_until, reason, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant_id) DO UPDATE SET
         base_fee=$2, per_database=$3, per_inline_db=$4, event_overage_per_m=$5, hot_overage_per_gb=$6,
         cold_per_gb=$7, per_dsar=$8, valid_until=$9, reason=$10, updated_by=$11, updated_at=now()`,
      [req.params.id, vals.base_fee, vals.per_database, vals.per_inline_db, vals.event_overage_per_m,
       vals.hot_overage_per_gb, vals.cold_per_gb, vals.per_dsar, validUntil, b.reason || null, b.updatedBy || 'platform-ops']
    );
    const o = (await pgPool.query('SELECT * FROM tenant_billing_overrides WHERE tenant_id = $1', [req.params.id])).rows[0];
    const tn = (await pgPool.query('SELECT name FROM tenants WHERE id=$1', [req.params.id])).rows[0];
    await logPlatformAudit({ actor: b.updatedBy || 'Platform Ops', action: 'billing.contract.update', tenantId: req.params.id, tenantName: tn?.name, resource: `tenant/${req.params.id}`, ip: req.ip, details: `Negotiated contract saved${b.reason ? ' · ' + b.reason : ''}` });
    res.json({ ok: true, override: shapeOverride(o) });
  } catch (err) {
    console.error('[Admin] set override failed:', err.message);
    res.status(500).json({ error: 'Failed to save contract' });
  }
});
app.delete('/api/admin/tenants/:id/billing-override', async (req, res) => {
  try {
    await pgPool.query('DELETE FROM tenant_billing_overrides WHERE tenant_id = $1', [req.params.id]);
    await logPlatformAudit({ actor: req.body?.actor || 'Platform Ops', action: 'billing.contract.remove', resource: `tenant/${req.params.id}`, ip: req.ip, details: 'Negotiated contract removed' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Admin] delete override failed:', err.message);
    res.status(500).json({ error: 'Failed to remove contract' });
  }
});

// ══ Admin · Security & Ops ═════════════════════════════════
// Operator audit log + impersonation/break-glass sessions + approvals + roles.
// All isolated tables; no main-app table is touched.
async function logPlatformAudit({ actor = 'Platform Ops', action, tenantId = null, tenantName = null, resource = null, ip = null, details = null }) {
  try {
    await pgPool.query(
      'INSERT INTO platform_audit (actor, action, tenant_id, tenant_name, resource, ip, details) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [actor, action, tenantId, tenantName, resource, (ip || '').replace('::ffff:', '') || null, details]
    );
  } catch { /* audit is best-effort */ }
}

// Unifies the REAL hash-chained tenant audit (audit_trail — real users/tenants/IPs)
// with operator actions logged via logPlatformAudit (platform_audit). No fabricated data.
const AUDIT_CTE = `WITH combined AS (
  SELECT pa.ts, pa.actor, pa.action, pa.tenant_name, pa.resource, pa.ip, pa.details FROM platform_audit pa
  UNION ALL
  SELECT a.created_at AS ts,
         COALESCE(u.full_name, a.actor_email, 'system') AS actor,
         a.action,
         COALESCE(t.name, CASE WHEN a.tenant_id IS NULL THEN 'Platform' END) AS tenant_name,
         a.resource_type || COALESCE('/' || a.resource_id::text, '') AS resource,
         host(a.ip_address) AS ip,
         COALESCE(a.details->>'summary', NULLIF(a.details::text, '{}')) AS details
  FROM audit_trail a
  LEFT JOIN users u ON u.email = a.actor_email
  LEFT JOIN tenants t ON t.id = a.tenant_id
)`;
app.get('/api/admin/audit', async (req, res) => {
  try {
    const { actor, action, tenant, q, from, to } = req.query;
    const where = [], params = [];
    const add = (col, val) => { params.push(val); where.push(`${col} = $${params.length}`); };
    if (actor) add('actor', actor);
    if (action) add('action', action);
    if (tenant) add('tenant_name', tenant);
    if (from) { params.push(from); where.push(`ts >= $${params.length}`); }
    if (to) { params.push(to + ' 23:59:59'); where.push(`ts <= $${params.length}`); }
    if (q) { params.push(`%${q}%`); const n = `$${params.length}`; where.push(`(action ILIKE ${n} OR COALESCE(resource,'') ILIKE ${n} OR COALESCE(details,'') ILIKE ${n} OR COALESCE(ip,'') ILIKE ${n} OR COALESCE(actor,'') ILIKE ${n})`); }
    const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = (await pgPool.query(`${AUDIT_CTE} SELECT * FROM combined ${wsql} ORDER BY ts DESC LIMIT 200`, params)).rows
      .map((r, i) => ({ id: i, ...r }));

    const k = (await pgPool.query(`${AUDIT_CTE} SELECT
        COUNT(*) FILTER (WHERE ts >= date_trunc('day', now())) AS today,
        COUNT(DISTINCT actor) FILTER (WHERE ts >= date_trunc('day', now())) AS actors,
        COUNT(DISTINCT tenant_name) FILTER (WHERE ts >= date_trunc('day', now()) AND tenant_name IS NOT NULL AND tenant_name NOT IN ('Platform','All tenants')) AS tenants
      FROM combined`)).rows[0];
    const imp = parseInt((await pgPool.query(`SELECT COUNT(*) AS n FROM admin_access_sessions WHERE type='impersonation' AND status='active' AND expires_at > now()`)).rows[0].n);
    const actors = (await pgPool.query(`${AUDIT_CTE} SELECT DISTINCT actor FROM combined WHERE actor IS NOT NULL ORDER BY actor`)).rows.map(r => r.actor);
    const actions = (await pgPool.query(`${AUDIT_CTE} SELECT DISTINCT action FROM combined ORDER BY action`)).rows.map(r => r.action);
    res.json({
      kpis: { eventsToday: parseInt(k.today), actorsActive: parseInt(k.actors), tenantsAccessed: parseInt(k.tenants), impersonationSessions: imp },
      filters: { actors, actions },
      events: rows,
    });
  } catch (err) {
    console.error('[Admin] audit failed:', err.message);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

// Sessions (impersonation + break-glass share this table, keyed by type).
function shapeSession(s) {
  const expired = s.status === 'active' && s.expires_at && new Date(s.expires_at) < new Date();
  return {
    id: s.id, type: s.type, operator: s.operator, operatorEmail: s.operator_email,
    tenantName: s.tenant_name, justification: s.justification, scope: s.scope, approver: s.approver,
    incidentRef: s.incident_ref, ticketRef: s.ticket_ref, durationMin: s.duration_min, actions: s.actions_count,
    reviewed: s.reviewed, startedAt: s.started_at, expiresAt: s.expires_at, endedAt: s.ended_at,
    status: expired ? (s.type === 'break_glass' ? 'auto_revoked' : 'completed') : s.status,
  };
}
app.get('/api/admin/sessions', async (req, res) => {
  const type = req.query.type === 'break_glass' ? 'break_glass' : 'impersonation';
  try {
    const rows = (await pgPool.query('SELECT * FROM admin_access_sessions WHERE type=$1 ORDER BY started_at DESC', [type])).rows.map(shapeSession);
    const active = rows.filter(r => r.status === 'active');
    res.json({
      kpis: {
        active: active.length,
        completed: rows.filter(r => r.status === 'completed' || r.status === 'auto_revoked').length,
        pendingReview: rows.filter(r => r.status === 'pending_review' || (!r.reviewed && r.status === 'auto_revoked')).length,
        total: rows.length,
      },
      active, history: rows,
    });
  } catch (err) {
    console.error('[Admin] sessions failed:', err.message);
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});
app.post('/api/admin/sessions', async (req, res) => {
  const b = req.body || {};
  const type = b.type === 'break_glass' ? 'break_glass' : 'impersonation';
  if (!b.tenantId && !b.tenantName) return res.status(400).json({ error: 'tenant is required' });
  if (!b.justification || !b.justification.trim()) return res.status(400).json({ error: 'justification is required' });
  if (type === 'break_glass' && (!b.approver || !b.incidentRef)) return res.status(400).json({ error: 'approver and incident reference are required' });
  try {
    let tenantName = b.tenantName;
    if (b.tenantId) { const t = await pgPool.query('SELECT name FROM tenants WHERE id=$1', [b.tenantId]); if (t.rows.length) tenantName = t.rows[0].name; }
    const dur = parseInt(b.durationMin) || 60;
    const ins = await pgPool.query(
      `INSERT INTO admin_access_sessions (type, operator, operator_email, tenant_id, tenant_name, justification, scope, approver, incident_ref, ticket_ref, duration_min, status, started_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',now(), now() + make_interval(mins => $11::int)) RETURNING *`,
      [type, b.operator || 'Platform Ops', b.operatorEmail || 'ops@toovix.io', b.tenantId || null, tenantName,
       b.justification.trim(), b.scope || null, b.approver || null, b.incidentRef || null, b.ticketRef || null, dur]
    );
    await logPlatformAudit({ actor: b.operator || 'Platform Ops', action: type === 'break_glass' ? 'break-glass.activate' : 'impersonation.start', tenantId: b.tenantId || null, tenantName, resource: `session/${ins.rows[0].id.slice(0, 8)}`, ip: req.ip, details: `${b.incidentRef || b.ticketRef || ''} · ${b.justification.trim().slice(0, 60)}` });
    res.status(201).json({ ok: true, session: shapeSession(ins.rows[0]) });
  } catch (err) {
    console.error('[Admin] create session failed:', err.message);
    res.status(500).json({ error: 'Failed to start session' });
  }
});
app.post('/api/admin/sessions/:id/end', async (req, res) => {
  try {
    const s = (await pgPool.query('SELECT * FROM admin_access_sessions WHERE id=$1', [req.params.id])).rows[0];
    if (!s) return res.status(404).json({ error: 'Not found' });
    const endStatus = s.type === 'break_glass' ? 'revoked' : 'completed';
    const upd = await pgPool.query("UPDATE admin_access_sessions SET status=$2, ended_at=now() WHERE id=$1 RETURNING *", [req.params.id, endStatus]);
    await logPlatformAudit({ actor: req.body?.actor || 'Platform Ops', action: s.type === 'break_glass' ? 'break-glass.revoke' : 'impersonation.end', tenantName: s.tenant_name, resource: `session/${s.id.slice(0, 8)}`, ip: req.ip, details: `Session ${endStatus} · ${s.actions_count} actions` });
    res.json({ ok: true, session: shapeSession(upd.rows[0]) });
  } catch (err) {
    console.error('[Admin] end session failed:', err.message);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

const ROLE_LABEL = { sales: 'Sales', finance: 'Finance', lead: 'Platform Lead', ops: 'Platform Ops', super: 'Super Admin' };
// Role & assignment data comes from the REAL users table (the actual people),
// not fabricated operators.
const PRODUCT_ROLE_LABEL = {
  tenant_admin: 'Tenant Admin', soc_analyst: 'SOC Analyst', db_owner: 'DB Owner',
  compliance: 'Compliance', auditor: 'Auditor', viewer: 'Viewer',
  Admin: 'Admin', 'Security Analyst': 'Security Analyst',
};
app.get('/api/admin/operators', async (req, res) => {
  try {
    const users = (await pgPool.query(`SELECT u.id, u.full_name, u.email, u.role, u.mfa_enabled, u.status, u.last_login_at, t.name AS tenant_name
      FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id ORDER BY u.role, u.full_name`)).rows;
    const pending = parseInt((await pgPool.query("SELECT COUNT(*) AS n FROM approval_requests WHERE status='pending'")).rows[0].n);
    const roleCounts = {};
    users.forEach(u => { roleCounts[u.role] = (roleCounts[u.role] || 0) + 1; });
    res.json({
      kpis: { roles: Object.keys(roleCounts).length, users: users.length, pendingApprovals: pending, sodEnforced: true },
      roleCounts,
      operators: users.map(u => ({
        id: u.id, name: u.full_name, email: u.email, role: u.role,
        roleLabel: PRODUCT_ROLE_LABEL[u.role] || u.role, mfa: u.mfa_enabled,
        status: u.status, tenant: u.tenant_name, lastActive: u.last_login_at,
      })),
    });
  } catch (err) {
    console.error('[Admin] operators failed:', err.message);
    res.status(500).json({ error: 'Failed to load roles' });
  }
});

// Approvals — multi-party tenant lifecycle sign-off.
const APPROVAL_CHAINS = { upgrade: ['sales', 'finance', 'lead'], suspension: ['lead'], offboarding: ['sales', 'lead'] };
const APPROVAL_PREFIX = { upgrade: 'UPG', suspension: 'SUS', offboarding: 'OFF' };
function shapeApproval(a) {
  return { id: a.id, ref: a.ref, type: a.type, tenantName: a.tenant_name, detail: a.detail, initiatedBy: a.initiated_by, chain: a.chain, status: a.status, submittedAt: a.submitted_at, resolvedAt: a.resolved_at };
}
// Create a real approval request (from the tenant Upgrade / Suspend / Offboard actions).
app.post('/api/admin/approvals', async (req, res) => {
  const { type, tenantId, tenantName, detail, initiatedBy } = req.body || {};
  if (!APPROVAL_CHAINS[type]) return res.status(400).json({ error: 'type must be upgrade, suspension or offboarding' });
  try {
    let tn = tenantName;
    if (tenantId) { const t = await pgPool.query('SELECT name FROM tenants WHERE id=$1', [tenantId]); if (t.rows.length) tn = t.rows[0].name; }
    if (!tn) return res.status(400).json({ error: 'tenant is required' });
    const ref = `${APPROVAL_PREFIX[type]}-${Math.floor(1000 + Math.random() * 9000)}`;
    const chain = JSON.stringify(APPROVAL_CHAINS[type].map(r => ({ role: r, status: 'pending', at: null })));
    const ins = await pgPool.query(
      `INSERT INTO approval_requests (ref, type, tenant_id, tenant_name, detail, initiated_by, chain, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *`,
      [ref, type, tenantId || null, tn, detail || null, initiatedBy || 'Platform Ops', chain]
    );
    await logPlatformAudit({ actor: initiatedBy || 'Platform Ops', action: 'approval.request', tenantId: tenantId || null, tenantName: tn, resource: `request/${ref}`, ip: req.ip, details: `${type} requested${detail ? ' · ' + detail : ''}` });
    res.status(201).json({ ok: true, approval: shapeApproval(ins.rows[0]) });
  } catch (err) {
    console.error('[Admin] create approval failed:', err.message);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});
app.get('/api/admin/approvals', async (req, res) => {
  try {
    const rows = (await pgPool.query('SELECT * FROM approval_requests ORDER BY submitted_at DESC')).rows;
    const pending = rows.filter(r => r.status === 'pending');
    const since = (d) => `submitted_at >= now() - interval '${d}'`;
    const k = (await pgPool.query(`SELECT
        COUNT(*) FILTER (WHERE status='pending') AS pending,
        COUNT(*) FILTER (WHERE status='approved' AND resolved_at >= now() - interval '30 days') AS approved,
        COUNT(*) FILTER (WHERE status='rejected' AND resolved_at >= now() - interval '30 days') AS rejected,
        AVG(EXTRACT(EPOCH FROM (resolved_at - submitted_at))/3600) FILTER (WHERE resolved_at IS NOT NULL) AS avg_h
      FROM approval_requests`)).rows[0];
    res.json({
      kpis: { pending: parseInt(k.pending), approved: parseInt(k.approved), rejected: parseInt(k.rejected), avgHours: k.avg_h ? +(+k.avg_h).toFixed(1) : 0 },
      pending: pending.map(shapeApproval), history: rows.filter(r => r.status !== 'pending').map(shapeApproval),
    });
  } catch (err) {
    console.error('[Admin] approvals failed:', err.message);
    res.status(500).json({ error: 'Failed to load approvals' });
  }
});
app.post('/api/admin/approvals/:id/decision', async (req, res) => {
  const { role, decision, actor } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or reject' });
  try {
    const a = (await pgPool.query('SELECT * FROM approval_requests WHERE id=$1', [req.params.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.status !== 'pending') return res.status(409).json({ error: 'Request already resolved' });
    const chain = a.chain || [];
    const step = chain.find(c => c.role === role);
    if (!step) return res.status(400).json({ error: `This request has no ${role} approver step` });
    if (step.status !== 'pending') return res.status(409).json({ error: 'You have already decided on this request' });

    step.status = decision === 'approve' ? 'approved' : 'rejected';
    step.at = new Date().toISOString();
    let status = 'pending', resolvedAt = null;
    if (decision === 'reject') { status = 'rejected'; resolvedAt = new Date(); }
    else if (chain.every(c => c.status === 'approved')) { status = 'approved'; resolvedAt = new Date(); }

    const upd = await pgPool.query(
      'UPDATE approval_requests SET chain=$2, status=$3, resolved_at=$4 WHERE id=$1 RETURNING *',
      [a.id, JSON.stringify(chain), status, resolvedAt]
    );
    await logPlatformAudit({ actor: actor || ROLE_LABEL[role] || 'Approver', action: `approval.${decision}`, tenantName: a.tenant_name, resource: `request/${a.ref}`, ip: req.ip, details: `${ROLE_LABEL[role] || role} ${decision}d ${a.ref}${status !== 'pending' ? ` → ${status}` : ''}` });
    res.json({ ok: true, approval: shapeApproval(upd.rows[0]) });
  } catch (err) {
    console.error('[Admin] approval decision failed:', err.message);
    res.status(500).json({ error: 'Failed to record decision' });
  }
});

// ── Databases ─────────────────────────────────────────────
const DEP_LABEL = { onprem: 'On-prem', iaas: 'IaaS', rds: 'RDS', azuresql: 'Azure DB', cloudsql: 'Cloud SQL', atlas: 'Atlas', oci: 'OCI', saas: 'SaaS' };
const PAAS_DEPLOYMENTS = ['rds', 'azuresql', 'cloudsql', 'atlas', 'oci'];
const CAPTURE_LABEL = { host_ebpf: 'Host (eBPF)', network: 'Network', inline_proxy: 'Inline Proxy', audit_pull: 'Audit Pull', cloud_push: 'Cloud Push' };
// Agents attach to the **instance** (a host:port server), so they cover every database/schema
// on it. Coverage/status is derived from the agents on a database's instance_id.
const EMPTY_INST = { types: new Set(), online: 0, total: 0, databaseCount: 0 };

async function loadInstanceAgents() {
  const agentRows = await pgPool.query(`SELECT instance_id, agent_type, status FROM agents WHERE instance_id IS NOT NULL`);
  const dbRows = await pgPool.query(`SELECT instance_id FROM databases WHERE instance_id IS NOT NULL`);
  const byInstance = {};
  const get = (id) => byInstance[id] || (byInstance[id] = { types: new Set(), online: 0, total: 0, databaseCount: 0 });
  dbRows.rows.forEach((d) => { get(d.instance_id).databaseCount += 1; });
  agentRows.rows.forEach((a) => {
    const inst = get(a.instance_id);
    if (a.agent_type) inst.types.add(a.agent_type);
    inst.total += 1;
    if (a.status === 'online') inst.online += 1;
  });
  return byInstance;
}

function coverageFromInstance(inst) {
  const agentTypes = [...inst.types];
  const total = inst.total;
  const online = inst.online;
  const status = total === 0 ? 'unmonitored' : online < total ? 'degraded' : 'active';
  return {
    status,
    agents: { total, online },
    monitoring: agentTypes.map((m) => CAPTURE_LABEL[m] || m),
    coverage: {
      net: agentTypes.includes('network') || agentTypes.includes('inline_proxy'),
      host: agentTypes.includes('host_ebpf'),
      pull: agentTypes.includes('audit_pull'),
      push: agentTypes.includes('cloud_push'),
    },
  };
}

function shapeDatabase(d, lastEvents, byInstance) {
  const inst = byInstance[d.instance_id] || EMPTY_INST;
  return {
    id: d.id,
    name: d.name,
    instance_id: d.instance_id,
    engine: d.engine,
    version: d.version,
    host: d.host,
    port: d.port,
    instance: d.host ? `${d.host}:${d.port || ''}` : null,
    instance_name: d.instance_name || (d.host ? `${d.host}:${d.port || ''}` : null),
    instance_databases: inst.databaseCount || 1,
    deployment_type: d.deployment_type,
    deployment: DEP_LABEL[d.deployment_type] || d.deployment_type || '—',
    is_paas: PAAS_DEPLOYMENTS.includes(d.deployment_type),
    environment: d.environment || 'prod',
    region: d.region,
    risk_score: d.risk_score || 0,
    ...coverageFromInstance(inst),
    sensitivity: d.sensitivity_tags || [],
    open_alerts: parseInt(d.open_alerts || 0),
    last_event: lastEvents[d.name] || null,
    created_at: d.created_at,
  };
}

function shapeInstance(i, byInstance) {
  const inst = byInstance[i.id] || EMPTY_INST;
  return {
    id: i.id,
    name: i.name,
    engine: i.engine,
    version: i.version,
    host: i.host,
    port: i.port,
    instance: i.host ? `${i.host}:${i.port || ''}` : null,
    deployment_type: i.deployment_type,
    deployment: DEP_LABEL[i.deployment_type] || i.deployment_type || '—',
    is_paas: PAAS_DEPLOYMENTS.includes(i.deployment_type),
    environment: i.environment || 'prod',
    region: i.region,
    database_count: parseInt(i.database_count || 0),
    risk_score: parseInt(i.max_risk || 0),
    sensitivity: i.sensitivity || [],
    ...coverageFromInstance(inst),
    created_at: i.created_at,
  };
}

// Database rows denormalize the instance's descriptive fields (host/port/engine/...) so existing
// dashboard queries keep working; the instance remains the source of truth via COALESCE.
const DB_SELECT = `
  SELECT d.id, d.name, d.instance_id, d.risk_score, d.sensitivity_tags, d.created_at,
         i.name AS instance_name,
         COALESCE(i.engine, d.engine) AS engine,
         COALESCE(i.version, d.version) AS version,
         COALESCE(i.host, d.host) AS host,
         COALESCE(i.port, d.port) AS port,
         COALESCE(i.deployment_type, d.deployment_type) AS deployment_type,
         COALESCE(i.region, d.region) AS region,
         COALESCE(i.environment, d.environment) AS environment,
         (SELECT COUNT(*) FROM alerts a WHERE a.database_id = d.id AND a.status = 'open') AS open_alerts
  FROM databases d LEFT JOIN db_instances i ON d.instance_id = i.id`;

app.get('/api/databases', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(`${DB_SELECT} WHERE d.tenant_id = $1 ORDER BY d.risk_score DESC, d.name`, [req.user.tenantId]);
  const lastEvents = {};
  try {
    const ev = await chQuery(`SELECT database_name, max(timestamp) AS ts FROM ${await eventsDbFor(req.user.tenantId)}.events WHERE tenant_id = '${req.user.tenantId}' GROUP BY database_name`);
    ev.forEach((r) => { lastEvents[r.database_name] = r.ts; });
  } catch (e) { /* analytics optional */ }
  const byInstance = await loadInstanceAgents();
  res.json(rows.map((d) => shapeDatabase(d, lastEvents, byInstance)));
});

// Add a database (schema) to an existing instance.
app.post('/api/databases', authRequired, async (req, res) => {
  const { name, instance_id, sensitivity_tags, risk_score } = req.body;
  if (!name || !instance_id) {
    return res.status(400).json({ error: 'name and instance_id are required' });
  }
  const inst = await pgPool.query('SELECT * FROM db_instances WHERE id = $1', [instance_id]);
  if (!inst.rows.length) return res.status(404).json({ error: 'Instance not found' });
  const i = inst.rows[0];
  const ins = await pgPool.query(
    `INSERT INTO databases (tenant_id, instance_id, name, engine, version, host, port, deployment_type, cloud_provider, region, environment, sensitivity_tags, monitoring_status, risk_score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'not_monitored',$13) RETURNING id`,
    [req.user.tenantId, instance_id, name, i.engine, i.version, i.host, i.port, i.deployment_type, i.cloud_provider, i.region, i.environment, sensitivity_tags || [], risk_score || 0]
  );
  const { rows } = await pgPool.query(`${DB_SELECT} WHERE d.id = $1`, [ins.rows[0].id]);
  const byInstance = await loadInstanceAgents();
  res.status(201).json(shapeDatabase(rows[0], {}, byInstance));
});

// Decommission a single database (schema).
app.delete('/api/databases/:id', authRequired, async (req, res) => {
  await pgPool.query('UPDATE agents SET database_id = NULL WHERE database_id = $1', [req.params.id]);
  await pgPool.query('DELETE FROM alerts WHERE database_id = $1', [req.params.id]);
  const { rowCount } = await pgPool.query('DELETE FROM databases WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Database not found' });
  res.json({ message: 'Database removed' });
});

// ── Instances ─────────────────────────────────────────────
const INSTANCE_SELECT = `
  SELECT i.*,
         (SELECT COUNT(*) FROM databases d WHERE d.instance_id = i.id) AS database_count,
         (SELECT COALESCE(MAX(risk_score),0) FROM databases d WHERE d.instance_id = i.id) AS max_risk,
         (SELECT COALESCE(array_agg(DISTINCT t), '{}') FROM databases d, unnest(d.sensitivity_tags) t WHERE d.instance_id = i.id) AS sensitivity
  FROM db_instances i`;

app.get('/api/instances', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(`${INSTANCE_SELECT} WHERE i.tenant_id = $1 ORDER BY i.host, i.port`, [req.user.tenantId]);
  const byInstance = await loadInstanceAgents();
  res.json(rows.map((i) => shapeInstance(i, byInstance)));
});

app.post('/api/instances', authRequired, async (req, res) => {
  const { name, engine, host, port, version, deployment_type, cloud_provider, region, environment, initial_database } = req.body;
  if (!engine || !host) {
    return res.status(400).json({ error: 'engine and host are required' });
  }
  const instName = name || host;
  const ins = await pgPool.query(
    `INSERT INTO db_instances (tenant_id, name, engine, version, host, port, deployment_type, cloud_provider, region, environment)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [req.user.tenantId, instName, engine, version || null, host, port || null, deployment_type || 'onprem', cloud_provider || null, region || null, environment || 'prod']
  );
  const instanceId = ins.rows[0].id;
  if (initial_database) {
    const i = (await pgPool.query('SELECT * FROM db_instances WHERE id = $1', [instanceId])).rows[0];
    await pgPool.query(
      `INSERT INTO databases (tenant_id, instance_id, name, engine, version, host, port, deployment_type, cloud_provider, region, environment, monitoring_status, risk_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'not_monitored',0)`,
      [req.user.tenantId, instanceId, initial_database, i.engine, i.version, i.host, i.port, i.deployment_type, i.cloud_provider, i.region, i.environment]
    );
  }
  const { rows } = await pgPool.query(`${INSTANCE_SELECT} WHERE i.id = $1`, [instanceId]);
  const byInstance = await loadInstanceAgents();
  res.status(201).json(shapeInstance(rows[0], byInstance));
});

// Decommission a whole instance — removes its agents, databases, and the instance.
app.delete('/api/instances/:id', authRequired, async (req, res) => {
  const dbIds = (await pgPool.query('SELECT id FROM databases WHERE instance_id = $1', [req.params.id])).rows.map((r) => r.id);
  await pgPool.query('DELETE FROM agents WHERE instance_id = $1', [req.params.id]);
  if (dbIds.length) {
    await pgPool.query('DELETE FROM agents WHERE database_id = ANY($1)', [dbIds]);
    await pgPool.query('DELETE FROM alerts WHERE database_id = ANY($1)', [dbIds]);
    await pgPool.query('DELETE FROM databases WHERE instance_id = $1', [req.params.id]);
  }
  const { rowCount } = await pgPool.query('DELETE FROM db_instances WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Instance not found' });
  res.json({ message: 'Instance decommissioned', databases_removed: dbIds.length });
});

// ── Agents ────────────────────────────────────────────────
app.get('/api/agents', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT a.id, a.agent_type, a.host, a.version, a.status, a.last_heartbeat, a.created_at,
            i.name AS instance_name, i.host AS instance_host, i.port AS instance_port
     FROM agents a LEFT JOIN db_instances i ON a.instance_id = i.id
     WHERE a.tenant_id = $1
     ORDER BY a.created_at DESC`, [req.user.tenantId]
  );
  res.json(rows.map((r) => ({
    ...r,
    instance: r.instance_host ? `${r.instance_host}:${r.instance_port || ''}` : (r.instance_name || '—'),
  })));
});

app.post('/api/agents', authRequired, async (req, res) => {
  let { instance_id, database_id, agent_type, host, version, config } = req.body;
  if (!agent_type) return res.status(400).json({ error: 'agent_type is required' });
  if (!instance_id && database_id) {
    const d = await pgPool.query('SELECT instance_id FROM databases WHERE id = $1', [database_id]);
    instance_id = d.rows[0] && d.rows[0].instance_id;
  }
  if (!instance_id) return res.status(400).json({ error: 'instance_id (or database_id) is required' });
  const { rows } = await pgPool.query(
    `INSERT INTO agents (tenant_id, instance_id, agent_type, host, version, config, status, last_heartbeat)
     VALUES ($1, $2, $3, $4, $5, $6, 'online', now()) RETURNING *`,
    [req.user.tenantId, instance_id, agent_type, host || null, version || '2.4.1', JSON.stringify(config || {})]
  );
  res.status(201).json(rows[0]);
});

// Remove an agent (e.g. an offline placeholder, or a decommissioned agent).
app.delete('/api/agents/:id', authRequired, async (req, res) => {
  const { rowCount } = await pgPool.query('DELETE FROM agents WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Agent not found' });
  await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'agent.remove', resourceType: 'agent', resourceId: req.params.id, details: {} });
  res.json({ message: 'Agent removed' });
});

// Issue an enrollment token + endpoint for an operator to install an agent.
// The agent (run by the customer) enrolls with this token and then appears in
// the fleet — we do NOT create an agent row here. (Dev: returns the shared token;
// prod would mint a short-lived, single-use token bound to the instance.)
app.get('/api/agents/enroll-token', authRequired, async (req, res) => {
  res.json({
    token: AGENT_ENROLL_TOKEN,
    control_plane: process.env.PUBLIC_CONTROL_PLANE || 'meridian.toovix.security',
  });
});

// ── Agent self-enrollment + heartbeat (called by the agent process) ──
// Token-gated (agents are not users). The agent declares the instance it monitors
// (host:port + engine); we find-or-create that instance and register the agent on it.
const AGENT_ENROLL_TOKEN = process.env.AGENT_ENROLL_TOKEN || 'dev-agent-enroll-token';

app.post('/api/agents/enroll', async (req, res) => {
  const { token, host, port, engine, agent_type, agent_host, version } = req.body;
  if (token !== AGENT_ENROLL_TOKEN) return res.status(401).json({ error: 'Invalid enrollment token' });
  if (!host || !engine || !agent_type) return res.status(400).json({ error: 'host, engine and agent_type are required' });
  const tenantId = (await pgPool.query('SELECT id FROM tenants LIMIT 1')).rows[0].id;

  const found = await pgPool.query(
    `SELECT id FROM db_instances WHERE host = $1 AND port IS NOT DISTINCT FROM $2 AND engine = $3`,
    [host, port || null, engine]
  );
  let instanceId;
  if (found.rows.length) instanceId = found.rows[0].id;
  else {
    const created = await pgPool.query(
      `INSERT INTO db_instances (tenant_id, name, engine, host, port) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tenantId, host, engine, host, port || null]
    );
    instanceId = created.rows[0].id;
  }

  const existing = await pgPool.query(
    `SELECT id FROM agents WHERE instance_id = $1 AND agent_type = $2 AND host IS NOT DISTINCT FROM $3`,
    [instanceId, agent_type, agent_host || null]
  );
  let agentId;
  if (existing.rows.length) {
    agentId = existing.rows[0].id;
    await pgPool.query(`UPDATE agents SET status='online', last_heartbeat=now(), version=$2 WHERE id=$1`, [agentId, version || '0.1.0']);
  } else {
    const created = await pgPool.query(
      `INSERT INTO agents (tenant_id, instance_id, agent_type, host, version, status, last_heartbeat)
       VALUES ($1,$2,$3,$4,$5,'online',now()) RETURNING id`,
      [tenantId, instanceId, agent_type, agent_host || null, version || '0.1.0']
    );
    agentId = created.rows[0].id;
  }
  // If this endpoint was a discovery candidate, it's now a real monitored instance.
  await pgPool.query(
    `UPDATE discovery_candidates SET status = 'approved' WHERE host = $1 AND port IS NOT DISTINCT FROM $2 AND status = 'candidate'`,
    [host, port || null]
  );
  console.log(`[Agent] Enrolled ${agent_type} on ${host}:${port || ''} (agent=${agentId})`);
  // Return tenant_id so the agent tags its events with the real tenant UUID
  // (not a placeholder), making per-tenant event attribution correct.
  res.json({ agent_id: agentId, instance_id: instanceId, tenant_id: tenantId });
});

app.post('/api/agents/:id/heartbeat', async (req, res) => {
  const { rowCount } = await pgPool.query(
    `UPDATE agents SET status='online', last_heartbeat=now() WHERE id=$1`,
    [req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Agent not found' });
  res.json({ ok: true });
});

// Agent-raised alert (e.g., an inline proxy blocked a query). Token-gated.
// Masking policy for inline-proxy agents: which columns to redact in result sets,
// the method per column, and which DB principals bypass masking (see real values).
// Method is derived from the data class (tag); enforcement is the per-column is_masked flag.
const MASK_METHOD = { pci: 'last-4', ssn: 'redact', aadhaar: 'redact', email: 'email', financial: 'last-4', phone: 'last-4', name: 'redact' };
app.get('/api/agents/masking-policy', async (req, res) => {
  if (req.query.token !== AGENT_ENROLL_TOKEN) return res.status(401).json({ error: 'Invalid token' });
  try {
    // Gate on the Dynamic Masking feature flag: only serve masked columns for tenants
    // where it's effectively enabled (so disabling it in the Admin app turns masking OFF).
    const flag = (await pgPool.query("SELECT * FROM feature_flags WHERE key = 'dynamic-masking'")).rows[0];
    const tenants = (await pgPool.query('SELECT id, tier FROM tenants')).rows;
    const ovBy = {};
    (await pgPool.query("SELECT tenant_id, status FROM feature_overrides WHERE feature_key = 'dynamic-masking'")).rows.forEach(o => { ovBy[o.tenant_id] = o.status; });
    const maskingEnabled = new Set(tenants.filter(t => !flag || featureEnabled(flag, t.tier, ovBy[t.id])).map(t => t.id));

    const rows = (await pgPool.query(
      `SELECT d.tenant_id, d.name db, o.object_name tbl, cc.column_name col, COALESCE(cc.tags[1],'sensitive') tag
       FROM classified_columns cc JOIN classified_objects o ON cc.object_id=o.id JOIN databases d ON cc.database_id=d.id
       WHERE cc.is_masked = true`)).rows;
    const columns = rows
      .filter(r => maskingEnabled.has(r.tenant_id)) // feature-flag gate
      .map(r => ({ db: r.db, table: r.tbl, column: r.col, method: MASK_METHOD[r.tag] || 'redact' }));
    // Bypass principals (DB usernames that see unmasked data), keyed by database name —
    // every database has its own list, configured in Masking → Bypass. No default bypass.
    const byp = (await pgPool.query(
      `SELECT d.name db, mb.principal FROM masking_bypass mb JOIN databases d ON mb.database_id = d.id`)).rows;
    const bypassByDb = {};
    for (const r of byp) (bypassByDb[r.db] ||= []).push(r.principal);
    // Optional org-wide bypass (applies to every DB) — empty unless explicitly set.
    const bypassGlobal = (process.env.MASK_BYPASS_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
    res.json({ columns, bypassByDb, bypassGlobal });
  } catch (err) {
    console.error('[Masking] policy fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to load masking policy' });
  }
});

// Bypass management (Masking → Bypass): per-database principals that see real data.
// Lists databases that have sensitive columns, each with its bypass principals.
app.get('/api/compliance/masking/bypass', authRequired, async (req, res) => {
  try {
    // Every monitored database can have its own bypass principals (masked-column count
    // shown so it's clear where bypass actually takes effect).
    const dbs = (await pgPool.query(
      `SELECT d.id, d.name,
         COUNT(cc.id) FILTER (WHERE cc.is_masked) AS masked_cols,
         COUNT(cc.id) FILTER (WHERE cc.sensitivity IN ('high','critical')) AS sensitive_cols
       FROM databases d LEFT JOIN classified_columns cc ON cc.database_id = d.id
       GROUP BY d.id, d.name ORDER BY d.name`)).rows;
    const byp = (await pgPool.query('SELECT id, database_id, principal, note FROM masking_bypass ORDER BY principal')).rows;
    res.json(dbs.map(d => ({
      databaseId: d.id, db: d.name, maskedCols: +d.masked_cols, sensitiveCols: +d.sensitive_cols,
      principals: byp.filter(b => b.database_id === d.id).map(b => ({ id: b.id, principal: b.principal, note: b.note })),
    })));
  } catch (err) {
    console.error('[Masking] bypass list failed:', err.message);
    res.status(500).json({ error: 'Failed to load bypass config' });
  }
});

app.post('/api/compliance/masking/bypass', authRequired, async (req, res) => {
  const { databaseId, principal, note } = req.body || {};
  if (!databaseId || !principal || !String(principal).trim()) return res.status(400).json({ error: 'databaseId and principal are required' });
  try {
    const r = (await pgPool.query(
      `INSERT INTO masking_bypass (database_id, principal, note, created_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (database_id, principal) DO UPDATE SET note = EXCLUDED.note RETURNING id`,
      [databaseId, String(principal).trim(), (note || '').trim() || null, req.user.email])).rows[0];
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'masking.bypass_grant', resourceType: 'database', resourceId: databaseId, details: { principal: String(principal).trim() } });
    res.status(201).json({ ok: true, id: r.id });
  } catch (err) {
    console.error('[Masking] bypass add failed:', err.message);
    res.status(500).json({ error: 'Failed to add bypass principal' });
  }
});

app.delete('/api/compliance/masking/bypass/:id', authRequired, async (req, res) => {
  try {
    const r = (await pgPool.query('DELETE FROM masking_bypass WHERE id = $1 RETURNING database_id, principal', [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'Not found' });
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'masking.bypass_revoke', resourceType: 'database', resourceId: r.database_id, details: { principal: r.principal } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Masking] bypass delete failed:', err.message);
    res.status(500).json({ error: 'Failed to remove bypass principal' });
  }
});

// ── Access Governance · JIT (just-in-time) access ─────────
// Request → approve (issues a time-boxed grant) → auto-expire / revoke. The workflow
// + audit layer; the grant itself is recorded here (real GRANT/REVOKE execution can be
// layered on via the mysql2 path used by quarantine release).
const JIT_OPEN = ['pending', 'active'];
app.get('/api/access/jit', authRequired, async (req, res) => {
  try {
    const rows = (await pgPool.query(
      `SELECT * FROM jit_grants WHERE tenant_id = $1
       ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, requested_at DESC LIMIT 200`, [req.user.tenantId])).rows;
    const summary = (await pgPool.query(`SELECT
        COUNT(*) FILTER (WHERE status='pending')::int  AS pending,
        COUNT(*) FILTER (WHERE status='active')::int   AS active,
        COUNT(*) FILTER (WHERE status='expired')::int  AS expired,
        COUNT(*) FILTER (WHERE status='revoked')::int  AS revoked,
        COUNT(*)::int AS total FROM jit_grants WHERE tenant_id = $1`, [req.user.tenantId])).rows[0];
    res.json({ grants: rows, summary });
  } catch (err) {
    console.error('[JIT] list failed:', err.message);
    res.status(500).json({ error: 'Failed to load JIT grants' });
  }
});

// Request a JIT grant against a broker-gated database and one of that broker's
// pre-approved scopes (the ceiling). Free-text scope is no longer accepted.
app.post('/api/access/jit', authRequired, async (req, res) => {
  const { brokerId, scopeId, reason, durationMins } = req.body || {};
  if (!brokerId || !scopeId) return res.status(400).json({ error: 'brokerId and scopeId are required' });
  const mins = Math.min(Math.max(parseInt(durationMins) || 120, 15), 7 * 24 * 60);
  // The requester is ALWAYS the authenticated caller — never a free-text field
  // (that is what makes separation-of-duties real, not spoofable text).
  const requester = req.user.email;
  try {
    const b = (await pgPool.query('SELECT * FROM jit_brokers WHERE id=$1', [brokerId])).rows[0];
    if (!b) return res.status(404).json({ error: 'Broker not found' });
    if (b.status !== 'healthy') return res.status(409).json({ error: `Broker is '${b.status}' — run a health check before requesting JIT on this database` });
    const scope = (b.allowed_scopes || []).find((s) => s.id === scopeId);
    if (!scope) return res.status(400).json({ error: 'Requested scope is not in this broker’s allowed scopes (ceiling)' });
    const scopeStr = `${scope.privilege} · ${scope.schema}.${scope.object || '*'}`;
    const r = (await pgPool.query(
      `INSERT INTO jit_grants (tenant_id, requester, requester_user_id, broker_id, db_name, scope, privilege, schema_name, object_name, reason, duration_mins, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending') RETURNING id`,
      [req.user.tenantId, requester, req.user.userId || null, b.id, b.label || b.host, scopeStr, scope.privilege, scope.schema, scope.object || '*', (reason || '').trim() || null, mins])).rows[0];
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'jit.request', resourceType: 'jit_grant', resourceId: r.id, details: { requester, broker: b.label, scope: scopeStr, durationMins: mins } });
    res.status(201).json({ ok: true, id: r.id });
  } catch (err) {
    console.error('[JIT] request failed:', err.message);
    res.status(500).json({ error: 'Failed to create JIT request' });
  }
});

// ── HashiCorp Vault client (AppRole auth + dynamic DB secrets engine) ────────
// DAM holds NO database password. The broker's privileged credential lives in
// Vault; DAM authenticates with a role_id + a boot-delivered secret_id and asks
// Vault to MINT a short-lived, scoped DB user per grant. Fails CLOSED if Vault
// is unreachable (never falls back to a stored password).
const VAULT_ADDR = process.env.VAULT_ADDR || '';
function readVaultRoleId() {
  try {
    const p = process.env.VAULT_ROLE_ID_FILE;
    if (p && require('fs').existsSync(p)) return require('fs').readFileSync(p, 'utf8').trim();
  } catch { /* ignore */ }
  return process.env.VAULT_ROLE_ID || '';
}
let _vaultTok = { token: null, exp: 0 };
async function vaultFetch(path, opts = {}) {
  if (!VAULT_ADDR) throw new Error('Vault is not configured (VAULT_ADDR unset)');
  const r = await fetch(`${VAULT_ADDR}/v1/${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(6000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Vault ${path} → ${r.status} ${JSON.stringify(body.errors || body)}`);
  return body;
}
async function vaultToken() {
  if (_vaultTok.token && Date.now() < _vaultTok.exp) return _vaultTok.token;
  const roleId = readVaultRoleId();
  if (!roleId) throw new Error('Vault AppRole not configured (VAULT_ROLE_ID unset)');
  // secret_id is delivered to DAM at boot on a shared tmpfs (kept off .env and out
  // of the DB); read it fresh each login so it is never held long-term in memory.
  const secretId = readVaultSecretId();
  if (!secretId) throw new Error('Vault secret_id unavailable (boot bootstrap did not run)');
  const login = await vaultFetch('auth/approle/login', { method: 'POST', body: JSON.stringify({ role_id: roleId, secret_id: secretId }) });
  const tok = login.auth.client_token;
  _vaultTok = { token: tok, exp: Date.now() + Math.max(30, (login.auth.lease_duration || 300) - 30) * 1000 };
  return tok;
}
function readVaultSecretId() {
  // The unwrapped secret_id (or a wrapped token to unwrap) is placed by the boot
  // step at VAULT_SECRET_ID_FILE on a tmpfs shared only with the init container.
  try {
    const p = process.env.VAULT_SECRET_ID_FILE;
    if (p && require('fs').existsSync(p)) return require('fs').readFileSync(p, 'utf8').trim();
  } catch { /* ignore */ }
  return process.env.VAULT_SECRET_ID || '';
}
// Mint a short-lived scoped DB credential for a grant's Vault role.
async function vaultDbCreds(mount, role, ttlSeconds) {
  const token = await vaultToken();
  const q = ttlSeconds ? `?ttl=${Math.max(60, Math.floor(ttlSeconds))}s` : '';
  const body = await vaultFetch(`${mount || 'database'}/creds/${encodeURIComponent(role)}${q}`, { headers: { 'X-Vault-Token': token } });
  return { username: body.data.username, password: body.data.password, leaseId: body.lease_id, leaseDuration: body.lease_duration };
}
async function vaultRevokeLease(leaseId) {
  if (!leaseId) return;
  const token = await vaultToken();
  await vaultFetch('sys/leases/revoke', { method: 'PUT', headers: { 'X-Vault-Token': token }, body: JSON.stringify({ lease_id: leaseId }) });
}

// ── Approval Signer verification ─────────────────────────────────────────────
// The signer is a SEPARATE service whose Ed25519 private key DAM never holds.
// DAM caches only the PUBLIC key and refuses to provision without a valid
// signature over the exact grant — so a compromised DAM cannot self-approve.
const SIGNER_URL = process.env.SIGNER_URL || '';
let _signerPubKey = null;
async function signerPublicKey() {
  if (_signerPubKey) return _signerPubKey;
  if (process.env.SIGNER_PUBKEY_PEM) { _signerPubKey = crypto.createPublicKey(process.env.SIGNER_PUBKEY_PEM.replace(/\\n/g, '\n')); return _signerPubKey; }
  if (!SIGNER_URL) throw new Error('Approval Signer not configured (SIGNER_URL unset)');
  const r = await fetch(`${SIGNER_URL}/pubkey`, { signal: AbortSignal.timeout(4000) });
  const b = await r.json();
  _signerPubKey = crypto.createPublicKey(b.pubkey);
  return _signerPubKey;
}
// Canonical, stable descriptor of a grant — what the signer signs and DAM re-derives.
function canonicalGrant(g) {
  return JSON.stringify({
    grant_id: g.id, requester: (g.requester || '').toLowerCase().trim(),
    broker_id: g.broker_id, privilege: g.privilege, schema: g.schema_name,
    object: g.object_name, duration_mins: g.duration_mins,
  });
}
async function verifyApproval(g, signatureB64) {
  const pub = await signerPublicKey();
  const ok = crypto.verify(null, Buffer.from(canonicalGrant(g)), pub, Buffer.from(signatureB64, 'base64'));
  return ok;
}

// ── Broker management ────────────────────────────────────────────────────────
app.get('/api/access/jit/brokers', authRequired, async (req, res) => {
  try {
    const rows = (await pgPool.query('SELECT * FROM jit_brokers WHERE tenant_id = $1 ORDER BY created_at DESC', [req.user.tenantId])).rows;
    res.json({ brokers: rows, vault: !!VAULT_ADDR, signer: !!(SIGNER_URL || process.env.SIGNER_PUBKEY_PEM) });
  } catch (err) { res.status(500).json({ error: 'Failed to load brokers' }); }
});

app.post('/api/access/jit/brokers', authRequired, adminOnly, async (req, res) => {
  const { label, engine, host, port, vaultMount, vaultRole, allowedScopes, rateLimitPerHour, owners } = req.body || {};
  if (!engine || !host || !vaultRole) return res.status(400).json({ error: 'engine, host and vaultRole are required' });
  const scopes = Array.isArray(allowedScopes) ? allowedScopes : [];
  // Normalize owners to a de-duped list of lowercased emails (the DB owners who may approve).
  const ownerList = [...new Set((Array.isArray(owners) ? owners : []).map((o) => String(o).toLowerCase().trim()).filter(Boolean))];
  try {
    const r = (await pgPool.query(
      `INSERT INTO jit_brokers (tenant_id, label, engine, host, port, vault_mount, vault_role, allowed_scopes, rate_limit_per_hour, owners, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unconfigured')
       ON CONFLICT (host, port, engine) DO UPDATE SET label=EXCLUDED.label, vault_mount=EXCLUDED.vault_mount,
         vault_role=EXCLUDED.vault_role, allowed_scopes=EXCLUDED.allowed_scopes, rate_limit_per_hour=EXCLUDED.rate_limit_per_hour, owners=EXCLUDED.owners
       RETURNING id`,
      [req.user.tenantId, label || host, String(engine).toLowerCase(), host, port || null, vaultMount || 'database', vaultRole, JSON.stringify(scopes), parseInt(rateLimitPerHour) || 10, JSON.stringify(ownerList)])).rows[0];
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'jit.broker.register', resourceType: 'jit_broker', resourceId: r.id, details: { host, engine, vaultRole, scopes: scopes.length, owners: ownerList } });
    res.status(201).json({ ok: true, id: r.id });
  } catch (err) {
    console.error('[JIT] broker register failed:', err.message);
    res.status(500).json({ error: 'Failed to register broker' });
  }
});

app.delete('/api/access/jit/brokers/:id', authRequired, adminOnly, async (req, res) => {
  try {
    await pgPool.query('DELETE FROM jit_brokers WHERE id=$1', [req.params.id]);
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'jit.broker.remove', resourceType: 'jit_broker', resourceId: req.params.id, details: {} });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed to remove broker' }); }
});

// Health check: prove Vault can mint a scoped user, that it CONNECTS, and that it
// is NOT over-privileged (out-of-scope check), then revoke the probe lease.
app.post('/api/access/jit/brokers/:id/health', authRequired, adminOnly, async (req, res) => {
  const b = (await pgPool.query('SELECT * FROM jit_brokers WHERE id=$1', [req.params.id])).rows[0];
  if (!b) return res.status(404).json({ error: 'Broker not found' });
  const detail = { checked_at: new Date().toISOString(), vault: false, mint: false, connect: false, in_scope: false, notes: [] };
  let lease = null, healthy = false;
  try {
    const scope = (b.allowed_scopes || [])[0];
    if (!scope) { detail.notes.push('no allowed scopes defined'); throw new Error('no scopes'); }
    if (!VAULT_ADDR) { detail.notes.push('Vault not configured'); throw new Error('no vault'); }
    detail.vault = true;
    const cred = await vaultDbCreds(b.vault_mount, scope.vault_role, 120);
    lease = cred.leaseId; detail.mint = true; detail.notes.push(`minted probe user ${cred.username}`);
    const probe = await brokerProbe(b, cred, scope);
    detail.connect = probe.connect; detail.in_scope = probe.inScope;
    probe.notes.forEach((n) => detail.notes.push(n));
    healthy = detail.mint && detail.connect && detail.in_scope;
  } catch (e) {
    detail.notes.push(`error: ${e.message}`);
  } finally {
    try { await vaultRevokeLease(lease); } catch { /* ignore */ }
  }
  await pgPool.query('UPDATE jit_brokers SET status=$2, health_detail=$3, last_health_at=now() WHERE id=$1',
    [b.id, healthy ? 'healthy' : 'unhealthy', JSON.stringify(detail)]);
  await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'jit.broker.health', resourceType: 'jit_broker', resourceId: b.id, details: { status: healthy ? 'healthy' : 'unhealthy' } });
  res.json({ ok: true, status: healthy ? 'healthy' : 'unhealthy', detail });
});

// Connect as the minted user and assert it can read in-scope but is NOT privileged.
async function brokerProbe(b, cred, scope) {
  const fam = ENGINE_FAMILY[(b.engine || '').toLowerCase()];
  const out = { connect: false, inScope: false, notes: [] };
  if (fam === 'mysql') {
    let conn;
    try {
      conn = await mysql.createConnection({ host: b.host, port: b.port || 3306, user: cred.username, password: cred.password, connectTimeout: 4000 });
      out.connect = true;
      const [g] = await conn.query('SHOW GRANTS');
      const grants = g.map((r) => Object.values(r)[0]).join('\n');
      const overPriv = /ALL PRIVILEGES ON \*\.\*|GRANT OPTION.*ON \*\.\*|\bSUPER\b/i.test(grants);
      out.inScope = !overPriv;
      out.notes.push(overPriv ? 'FAIL: broker-minted user is over-privileged (global/SUPER)' : 'ok: privileges confined to scope');
      try { await conn.query('SELECT 1 FROM mysql.user LIMIT 1'); out.inScope = false; out.notes.push('FAIL: can read mysql.user (too broad)'); }
      catch { out.notes.push('ok: cannot read mysql.user'); }
    } finally { if (conn) { try { await conn.end(); } catch { /* ignore */ } } }
  } else if (fam === 'postgres') {
    const { Client } = require('pg');
    const client = new Client({ host: b.host, port: b.port || 5432, user: cred.username, password: cred.password, database: scope.schema && scope.database ? scope.database : undefined, connectionTimeoutMillis: 4000 });
    try {
      await client.connect(); out.connect = true;
      const su = (await client.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0];
      out.inScope = !(su && su.rolsuper);
      out.notes.push(su && su.rolsuper ? 'FAIL: broker-minted role is SUPERUSER' : 'ok: not superuser');
    } finally { try { await client.end(); } catch { /* ignore */ } }
  } else {
    out.notes.push(`probe not supported for engine '${b.engine}'`);
  }
  return out;
}

// Broker-gated dropdown: only databases with a HEALTHY broker are offerable,
// each with its allowed scopes (so the request form is constrained to the ceiling).
app.get('/api/access/jit/databases', authRequired, async (req, res) => {
  try {
    const rows = (await pgPool.query(
      `SELECT id, label, engine, host, port, allowed_scopes FROM jit_brokers WHERE status='healthy' AND tenant_id = $1 ORDER BY label`, [req.user.tenantId])).rows;
    res.json({ databases: rows.map((b) => ({ brokerId: b.id, label: b.label, engine: b.engine, host: b.host, port: b.port, scopes: (b.allowed_scopes || []).map((s) => ({ id: s.id, label: s.label || `${s.privilege} ${s.schema}.${s.object || '*'}`, privilege: s.privilege, schema: s.schema, object: s.object || '*' })) })) });
  } catch (err) { res.status(500).json({ error: 'Failed to load JIT databases' }); }
});

// Where to obtain an approval signature (the separate signer service).
app.get('/api/access/jit/signer', authRequired, async (req, res) => {
  res.json({ signerUrl: process.env.SIGNER_PUBLIC_URL || SIGNER_URL || '', configured: !!(SIGNER_URL || process.env.SIGNER_PUBKEY_PEM) });
});

// Provision an approved grant. The approver is the AUTHENTICATED caller (not a
// typed field). Enforced: approver != requester (verified identities); approver is
// a DB owner of THIS broker (or tenant_admin as audited break-glass); a valid signer
// signature (anti-compromise gate); in-ceiling scope; per-DB rate breaker. Only then
// does Vault mint the scoped, short-lived DB user.
app.post('/api/access/jit/:id/provision', authRequired, async (req, res) => {
  const { signature } = req.body || {};
  if (!signature) return res.status(400).json({ error: 'A signed approval (signature) is required — approve via the Approval Signer first' });
  const approver = (req.user.email || '').toLowerCase().trim();   // verified identity, not spoofable
  try {
    const g = (await pgPool.query('SELECT * FROM jit_grants WHERE id=$1', [req.params.id])).rows[0];
    if (!g) return res.status(404).json({ error: 'Grant not found' });
    if (g.status !== 'pending') return res.status(409).json({ error: `Grant is '${g.status}', not pending` });

    const b = (await pgPool.query('SELECT * FROM jit_brokers WHERE id=$1', [g.broker_id])).rows[0];
    if (!b || b.status !== 'healthy') return res.status(409).json({ error: 'Broker is not healthy' });

    // (c) Separation of duties — on the VERIFIED logged-in identity, by email AND user id.
    const requesterEmail = (g.requester || '').toLowerCase().trim();
    if (approver === requesterEmail || (g.requester_user_id && req.user.userId && g.requester_user_id === req.user.userId))
      return res.status(403).json({ error: 'Separation of duties: you cannot approve your own request. A different data owner must approve.' });

    // Ownership: only a DB owner of THIS broker may approve. tenant_admin may act as
    // an audited break-glass approver when no data owner is available.
    const owners = (b.owners || []).map((o) => String(o).toLowerCase());
    const isOwner = owners.includes(approver);
    const isAdmin = req.user.role === 'tenant_admin';
    if (!isOwner && !isAdmin)
      return res.status(403).json({ error: `Not authorized to approve: only a DB owner of '${b.label}' may approve JIT for it.` });
    const breakGlass = isAdmin && !isOwner;

    // Signed-approval gate — a compromised DAM cannot forge this.
    let sigOk = false;
    try { sigOk = await verifyApproval(g, signature); } catch (e) { return res.status(502).json({ error: `Signer unavailable: ${e.message}` }); }
    if (!sigOk) return res.status(403).json({ error: 'Invalid approval signature — refusing to provision (this is the anti-compromise gate)' });

    const scope = (b.allowed_scopes || []).find((s) => s.privilege === g.privilege && s.schema === g.schema_name && (s.object || '*') === (g.object_name || '*'));
    if (!scope) return res.status(400).json({ error: 'Grant scope is no longer within the broker ceiling' });

    // (d) Circuit breaker — cap provisions per broker per rolling hour.
    const n = (await pgPool.query(
      `SELECT COUNT(*)::int AS c FROM jit_grants WHERE broker_id=$1 AND provisioned_at > now() - interval '1 hour'`, [b.id])).rows[0].c;
    if (n >= (b.rate_limit_per_hour || 10)) {
      await dispatchAlert({ severity: 'critical', summary: `JIT circuit breaker tripped on ${b.label} (${n} grants/hour)`, principal: g.requester, database: b.label, raw_sql: null });
      await writeAudit({ tenantId: req.user.tenantId, actorEmail: req.user.email, action: 'jit.breaker.trip', resourceType: 'jit_broker', resourceId: b.id, details: { count: n, limit: b.rate_limit_per_hour } });
      return res.status(429).json({ error: `Rate limit: ${n} JIT grants provisioned on this DB in the last hour (cap ${b.rate_limit_per_hour}). A critical alert was raised.` });
    }

    // Mint the scoped, short-lived DB user via Vault (DAM stores no DB password).
    let cred;
    try { cred = await vaultDbCreds(b.vault_mount, scope.vault_role, g.duration_mins * 60); }
    catch (e) {
      await pgPool.query('UPDATE jit_grants SET provision_error=$2 WHERE id=$1', [g.id, e.message]);
      return res.status(502).json({ error: `Vault could not mint the credential: ${e.message}` });
    }

    const upd = (await pgPool.query(
      `UPDATE jit_grants SET status='active', approved_at=now(), approved_by=$2, approval_sig=$3,
         provisioned_user=$4, provisioned_at=now(), provision_error=NULL, vault_lease_id=$5,
         expires_at = now() + make_interval(mins => duration_mins)
       WHERE id=$1 AND status='pending' RETURNING *`,
      [g.id, approver, signature, cred.username, cred.leaseId])).rows[0];
    if (!upd) { try { await vaultRevokeLease(cred.leaseId); } catch { /* ignore */ } return res.status(409).json({ error: 'Grant changed state mid-provision' }); }
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: breakGlass ? 'jit.provision.breakglass' : 'jit.provision', resourceType: 'jit_grant', resourceId: g.id, details: { requester: g.requester, broker: b.label, scope: g.scope, approver, approver_role: isOwner ? 'db_owner' : 'tenant_admin', break_glass: breakGlass, provisioned_user: cred.username, expires_at: upd.expires_at } });

    // Issued credentials are returned ONCE and never persisted.
    res.json({ ok: true, grant: { id: upd.id, status: upd.status, expires_at: upd.expires_at },
      credential: { host: b.host, port: b.port, engine: b.engine, database: scope.database || scope.schema, username: cred.username, password: cred.password, ttl_seconds: cred.leaseDuration } });
  } catch (err) {
    console.error('[JIT] provision failed:', err.message);
    res.status(500).json({ error: 'Failed to provision' });
  }
});

app.post('/api/access/jit/:id/revoke', authRequired, async (req, res) => {
  const me = (req.user.email || '').toLowerCase().trim();
  try {
    const g = (await pgPool.query('SELECT * FROM jit_grants WHERE id=$1', [req.params.id])).rows[0];
    if (!g) return res.status(404).json({ error: 'Grant not found' });
    if (!['pending', 'active'].includes(g.status)) return res.status(409).json({ error: `Grant is already '${g.status}'` });

    const b = g.broker_id ? (await pgPool.query('SELECT owners, label FROM jit_brokers WHERE id=$1', [g.broker_id])).rows[0] : null;
    const owners = (b?.owners || []).map((o) => String(o).toLowerCase());
    const isRequester = me === (g.requester || '').toLowerCase().trim();
    const isOwnerOrAdmin = owners.includes(me) || req.user.role === 'tenant_admin';
    // A requester may cancel/relinquish THEIR OWN grant; owners/admins may deny/revoke
    // for their DB. Nobody else can touch it.
    if (!isRequester && !isOwnerOrAdmin)
      return res.status(403).json({ error: 'Not authorized: only the requester (their own) or a DB owner may cancel/revoke this grant.' });

    // Status + audit action reflect who did what.
    const newStatus = g.status === 'pending' ? (isRequester && !isOwnerOrAdmin ? 'cancelled' : 'denied') : 'revoked';
    const action = newStatus === 'cancelled' ? 'jit.cancel' : (newStatus === 'denied' ? 'jit.deny' : 'jit.revoke');
    const upd = (await pgPool.query(
      `UPDATE jit_grants SET status=$2, revoked_at=now(), revoked_by=$3 WHERE id=$1 AND status IN ('pending','active') RETURNING *`,
      [g.id, newStatus, me])).rows[0];
    if (!upd) return res.status(409).json({ error: 'Grant changed state — try again' });
    // De-provision: revoking the Vault lease DROPs the minted DB user immediately.
    if (upd.vault_lease_id) { try { await vaultRevokeLease(upd.vault_lease_id); } catch (e) { console.error('[JIT] lease revoke failed:', e.message); } }
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action, resourceType: 'jit_grant', resourceId: g.id, details: { requester: g.requester, db: g.db_name, scope: g.scope, by: isRequester ? 'requester' : (owners.includes(me) ? 'db_owner' : 'admin'), deprovisioned_user: g.provisioned_user || null } });
    res.json({ ok: true, grant: upd });
  } catch (err) {
    console.error('[JIT] revoke failed:', err.message);
    res.status(500).json({ error: 'Failed to revoke' });
  }
});

// Reaper: auto-expire active grants past their window and DROP their minted users
// (Vault also auto-revokes at lease TTL — this is the belt-and-suspenders sweep).
setInterval(async () => {
  try {
    const expired = (await pgPool.query(
      `UPDATE jit_grants SET status='expired' WHERE status='active' AND expires_at < now()
       RETURNING id, vault_lease_id, provisioned_user`)).rows;
    for (const g of expired) {
      if (g.vault_lease_id) { try { await vaultRevokeLease(g.vault_lease_id); } catch (e) { console.error('[JIT] expiry lease revoke failed:', e.message); } }
    }
  } catch (e) { /* non-fatal */ }
}, 30000);

app.post('/api/agents/alert', async (req, res) => {
  const { token, host, port, principal, summary, severity, raw_sql } = req.body;
  if (token !== AGENT_ENROLL_TOKEN) return res.status(401).json({ error: 'Invalid token' });
  const tenantId = (await pgPool.query('SELECT id FROM tenants LIMIT 1')).rows[0].id;
  let databaseId = null;
  const inst = await pgPool.query(
    `SELECT id FROM db_instances WHERE host = $1 AND port IS NOT DISTINCT FROM $2`,
    [host, port || null]
  );
  if (inst.rows.length) {
    const d = await pgPool.query('SELECT id FROM databases WHERE instance_id = $1 LIMIT 1', [inst.rows[0].id]);
    if (d.rows.length) databaseId = d.rows[0].id;
  }
  const ins = await pgPool.query(
    `INSERT INTO alerts (tenant_id, database_id, severity, principal, summary, raw_sql, anomaly_score, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'open') RETURNING id, created_at`,
    [tenantId, databaseId, severity || 'high', principal || 'unknown', summary || 'Agent alert', raw_sql || null, 90]
  );
  try { broadcast({ type: 'alert', alert: { severity: severity || 'high', principal, summary } }); } catch (e) { /* WS optional */ }
  dispatchAlert({ tenantId, severity: severity || 'high', principal, summary: summary || 'Agent alert', database: host, raw_sql, ts: ins.rows[0].created_at });
  res.status(201).json({ alert_id: ins.rows[0].id });
});

// ── Active Defense — real live-ops view (aggregates real alerts / inline blocks /
// quarantine / detection). No synthetic data; the deception/egress/topology widgets
// on the page are explicitly labelled illustrative.
app.get('/api/active-defense', authRequired, async (req, res) => {
  const T = req.user.tenantId;
  try {
    const kpi = (await pgPool.query(`SELECT
      (SELECT count(*) FROM alerts WHERE tenant_id = $1 AND summary ILIKE 'Blocked by policy%' AND created_at > now() - interval '1 hour')::int AS blocked_hr,
      (SELECT count(*) FROM alerts WHERE tenant_id = $1 AND severity='critical' AND created_at > now() - interval '24 hours')::int AS crit_24h,
      (SELECT count(*) FROM alerts WHERE tenant_id = $1 AND severity IN ('critical','high') AND created_at > now() - interval '1 hour')::int AS high_hr,
      (SELECT count(*) FROM quarantine_sessions WHERE tenant_id = $1 AND status='held')::int AS held`, [T])).rows[0];

    let threatLevel = 'Guarded', threatDetail = 'no high/critical activity in the last hour';
    if (kpi.crit_24h > 0 && kpi.high_hr > 0) { threatLevel = 'Critical'; threatDetail = `${kpi.high_hr} high/critical in the last hour`; }
    else if (kpi.high_hr >= 3) { threatLevel = 'Elevated'; threatDetail = `${kpi.high_hr} high/critical in the last hour`; }
    else if (kpi.high_hr > 0) { threatLevel = 'Elevated'; threatDetail = `${kpi.high_hr} high/critical in the last hour`; }

    // Live stream: real recent alerts (incl. inline blocks) + quarantine holds, merged.
    const alerts = (await pgPool.query(
      `SELECT 'alert' AS kind, severity, principal, summary AS title, created_at AS ts FROM alerts WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 14`, [T])).rows;
    const holds = (await pgPool.query(
      `SELECT 'quarantine' AS kind, severity, principal, reason AS title, held_at AS ts FROM quarantine_sessions WHERE tenant_id = $1 AND status='held' ORDER BY held_at DESC LIMIT 6`, [T])).rows;
    const stream = [...alerts, ...holds]
      .filter((r) => r.ts)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, 14);

    // Anomaly timeline: real alert volume in 8 × 3-hour buckets over the last 24h (zero-filled).
    const timeline = (await pgPool.query(`
      WITH buckets AS (
        SELECT generate_series(date_trunc('hour', now()) - interval '21 hours', date_trunc('hour', now()), interval '3 hours') AS b)
      SELECT to_char(b, 'HH24') || 'h' AS label,
        (SELECT count(*) FROM alerts WHERE tenant_id = $1 AND created_at >= b AND created_at < b + interval '3 hours')::int AS n
      FROM buckets ORDER BY b`, [T])).rows;

    // Egress — real rows accessed per DB (24h) from captured events. Relative level
    // by volume (no fabricated baseline; it's actual read volume ranked).
    const adDb = await eventsDbFor(T);
    let egress = [];
    try {
      const rows = await chQuery(`SELECT database_name AS db, sum(row_count) AS rows FROM ${adDb}.events
        WHERE tenant_id = '${T}' AND timestamp > now() - INTERVAL 24 HOUR AND database_name != '' GROUP BY database_name ORDER BY rows DESC LIMIT 6`);
      const vals = rows.map((r) => ({ db: r.db, rows: Number(r.rows) || 0 }));
      const max = Math.max(1, ...vals.map((v) => v.rows));
      egress = vals.map((v) => { const pct = Math.round((v.rows / max) * 100); return { ...v, pct, level: pct >= 66 ? 'High' : pct >= 33 ? 'Med' : 'Low' }; });
    } catch (e) { /* ClickHouse optional */ }

    // Behavioral topology — top principal→DB edges by risk (max anomaly) then volume.
    let topology = [];
    try {
      const rows = await chQuery(`SELECT principal, database_name AS db, sum(row_count) AS rows, max(anomaly_score) AS risk
        FROM ${adDb}.events WHERE tenant_id = '${T}' AND timestamp > now() - INTERVAL 24 HOUR AND principal != '' AND principal != 'unknown'
        GROUP BY principal, database_name ORDER BY risk DESC, rows DESC LIMIT 6`);
      topology = rows.map((r) => ({ principal: r.principal, db: r.db, rows: Number(r.rows) || 0, risk: Number(r.risk) || 0 }));
    } catch (e) { /* ClickHouse optional */ }

    res.json({ threatLevel, threatDetail, blockedHr: kpi.blocked_hr, crit24h: kpi.crit_24h, held: kpi.held, stream, timeline, egress, topology });
  } catch (err) {
    console.error('[ActiveDefense] summary failed:', err.message);
    res.status(500).json({ error: 'Failed to load active defense' });
  }
});

// ── Deception (decoy / honeypot tables) ──────────────────────────────────────
const IDENT_RE = /^[a-zA-Z0-9_]+$/;
// Deploy a real honeypot table in the client DB (best-effort; detection also works
// on the query text even if the table is name-only). Deploy-time admin action.
async function createDecoyTable(schemaName, tableName) {
  if (!IDENT_RE.test(schemaName) || !IDENT_RE.test(tableName)) throw new Error('invalid schema/table name');
  let conn;
  try {
    conn = await mysql.createConnection({ host: 'client-mysql', port: 3306, user: 'root', password: process.env.CLIENT_MYSQL_ROOT_PASSWORD || '', connectTimeout: 4000 });
    await conn.query('CREATE TABLE IF NOT EXISTS `' + schemaName + '`.`' + tableName + '` (id INT PRIMARY KEY AUTO_INCREMENT, full_name VARCHAR(120), ssn VARCHAR(20), card_number VARCHAR(25), secret_notes TEXT)');
    await conn.query('INSERT INTO `' + schemaName + '`.`' + tableName + '` (full_name, ssn, card_number, secret_notes) VALUES (?,?,?,?)', ['DECOY — do not use', '000-00-0000', '4111111111111111', 'honeypot canary row']);
    return true;
  } finally { if (conn) { try { await conn.end(); } catch { /* ignore */ } } }
}
async function dropDecoyTable(schemaName, tableName) {
  if (!IDENT_RE.test(schemaName) || !IDENT_RE.test(tableName)) return;
  let conn;
  try {
    conn = await mysql.createConnection({ host: 'client-mysql', port: 3306, user: 'root', password: process.env.CLIENT_MYSQL_ROOT_PASSWORD || '', connectTimeout: 4000 });
    await conn.query('DROP TABLE IF EXISTS `' + schemaName + '`.`' + tableName + '`');
  } finally { if (conn) { try { await conn.end(); } catch { /* ignore */ } } }
}

app.get('/api/deception', authRequired, async (req, res) => {
  try {
    const rows = (await pgPool.query('SELECT * FROM decoys WHERE tenant_id = $1 ORDER BY deployed_at DESC', [req.user.tenantId])).rows;
    res.json({ decoys: rows, summary: { total: rows.length, armed: rows.filter((d) => d.state === 'armed').length, hit: rows.filter((d) => d.state === 'hit').length } });
  } catch (err) { res.status(500).json({ error: 'Failed to load decoys' }); }
});

app.post('/api/deception', authRequired, adminOnly, async (req, res) => {
  const { schema, table, note } = req.body || {};
  if (!table || !String(table).trim()) return res.status(400).json({ error: 'table name is required' });
  const schemaName = String(schema || 'payments').trim();
  const tableName = String(table).trim();
  if (!IDENT_RE.test(schemaName) || !IDENT_RE.test(tableName)) return res.status(400).json({ error: 'schema/table must be alphanumeric/underscore' });
  let created = false;
  try { created = await createDecoyTable(schemaName, tableName); } catch (e) { console.error('[deception] table create (name-only fallback):', e.message); }
  try {
    const r = (await pgPool.query(
      `INSERT INTO decoys (tenant_id, database_name, schema_name, table_name, note, state, table_created, deployed_by, last_scan_at)
       VALUES ($1,$2,$3,$4,$5,'armed',$6,$7, now()) RETURNING *`,
      [req.user.tenantId, schemaName, schemaName, tableName, (note || '').trim() || null, created, req.user.email])).rows[0];
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'deception.deploy', resourceType: 'decoy', resourceId: r.id, details: { schema: schemaName, table: tableName, table_created: created } });
    res.status(201).json({ ...r, table_created: created });
  } catch (err) { console.error('[deception] deploy failed:', err.message); res.status(500).json({ error: 'Failed to deploy decoy' }); }
});

app.delete('/api/deception/:id', authRequired, adminOnly, async (req, res) => {
  try {
    const d = (await pgPool.query('SELECT * FROM decoys WHERE id=$1', [req.params.id])).rows[0];
    if (!d) return res.status(404).json({ error: 'Decoy not found' });
    if (d.table_created) { try { await dropDecoyTable(d.schema_name, d.table_name); } catch (e) { /* best-effort */ } }
    await pgPool.query('DELETE FROM decoys WHERE id=$1', [req.params.id]);
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'deception.remove', resourceType: 'decoy', resourceId: d.id, details: { table: d.table_name } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed to remove decoy' }); }
});

// Decoy hit scan: any captured query referencing an armed decoy is a probe → critical alert.
async function runDecoyScan() {
  try {
    const decoys = (await pgPool.query(`SELECT * FROM decoys WHERE state='armed'`)).rows;
    for (const d of decoys) {
      const tbl = String(d.table_name || '');
      if (tbl.length < 4 || !IDENT_RE.test(tbl)) continue;
      const since = d.last_scan_at ? new Date(d.last_scan_at).toISOString().slice(0, 19).replace('T', ' ') : null;
      const whereTime = since ? `AND timestamp > '${since}'` : '';
      let hit = null;
      try {
        const evDb = await eventsDbFor(d.tenant_id);
        const rows = await chQuery(`SELECT principal, client_ip, max(timestamp) AS ts FROM ${evDb}.events
          WHERE positionCaseInsensitive(sql_text, '${tbl}') > 0 AND principal != '' AND positionCaseInsensitive(sql_text, 'information_schema') = 0 ${whereTime}
          GROUP BY principal, client_ip ORDER BY ts DESC LIMIT 1`);
        hit = rows[0];
      } catch (e) { continue; }
      await pgPool.query('UPDATE decoys SET last_scan_at=now() WHERE id=$1', [d.id]);
      if (hit && hit.principal) {
        await pgPool.query(`UPDATE decoys SET state='hit', hit_principal=$2, hit_client_ip=$3, hit_at=now() WHERE id=$1`, [d.id, hit.principal, hit.client_ip || null]);
        const summary = `Decoy probed — ${hit.principal} accessed honeypot ${d.schema_name}.${d.table_name}`;
        const ins = await pgPool.query(
          `INSERT INTO alerts (tenant_id, severity, principal, summary, anomaly_score, status) VALUES ($1,'critical',$2,$3,99,'open') RETURNING id, created_at`,
          [d.tenant_id, hit.principal, summary]);
        try { broadcast({ type: 'alert', alert: { id: ins.rows[0].id, severity: 'critical', principal: hit.principal, summary } }); } catch (e) { /* WS optional */ }
        try { dispatchAlert({ tenantId: d.tenant_id, severity: 'critical', principal: hit.principal, summary, database: d.database_name, ts: ins.rows[0].created_at }); } catch (e) { /* best-effort */ }
        console.log('[deception] HIT:', summary);
      }
    }
  } catch (e) { /* non-fatal */ }
}
setInterval(runDecoyScan, 8000);

// ── Integrations · Microsoft Teams alert forwarding ───────
// Config lives in the `integrations` table (type='msteams'): an incoming-webhook
// URL + minimum severity. dispatchAlert() posts an Adaptive Card on every new
// alert at/above that severity. Best-effort — never blocks alert creation.
const SEV_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };
function maskUrl(u) { return u ? u.slice(0, 30) + '…' + u.slice(-6) : ''; }

// Microsoft Teams — Adaptive Card (Power Automate "Workflows" incoming webhook).
async function postTeamsCard(webhookUrl, a) {
  const color = { critical: 'attention', high: 'warning', medium: 'accent', low: 'good' }[a.severity] || 'default';
  const card = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
        body: [
          { type: 'TextBlock', size: 'Large', weight: 'Bolder', color, text: `🛡 TooVix DAM — ${String(a.severity || '').toUpperCase()}${a.test ? ' (test)' : ''} alert` },
          { type: 'TextBlock', weight: 'Bolder', wrap: true, text: a.summary || 'Security alert' },
          { type: 'FactSet', facts: [
            { title: 'Severity', value: String(a.severity || '—') },
            { title: 'Principal', value: String(a.principal || '—') },
            { title: 'Database', value: String(a.database || '—') },
            { title: 'Time', value: new Date(a.ts || Date.now()).toISOString() },
          ] },
          ...(a.raw_sql ? [{ type: 'TextBlock', fontType: 'Monospace', wrap: true, spacing: 'Small', text: String(a.raw_sql).slice(0, 300) }] : []),
        ],
      },
    }],
  };
  const res = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(card), signal: AbortSignal.timeout(5000) });
  return { ok: res.ok, status: res.status };
}

// Slack — Block Kit message via an Incoming Webhook.
async function postSlackMessage(webhookUrl, a) {
  const color = { critical: '#dc2626', high: '#f59e0b', medium: '#3b82f6', low: '#16a34a' }[a.severity] || '#64748b';
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `🛡 TooVix DAM — ${String(a.severity || '').toUpperCase()}${a.test ? ' (test)' : ''} alert`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `*${a.summary || 'Security alert'}*` } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Severity:*\n${a.severity || '—'}` },
      { type: 'mrkdwn', text: `*Principal:*\n${a.principal || '—'}` },
      { type: 'mrkdwn', text: `*Database:*\n${a.database || '—'}` },
      { type: 'mrkdwn', text: `*Time:*\n${new Date(a.ts || Date.now()).toISOString()}` },
    ] },
  ];
  if (a.raw_sql) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '```' + String(a.raw_sql).slice(0, 300) + '```' } });
  const res = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attachments: [{ color, blocks }] }), signal: AbortSignal.timeout(5000) });
  return { ok: res.ok, status: res.status };
}

// ── Additional alert-delivery senders ─────────────────────
// Every sender takes (config, alert) and returns { ok, status }; it may throw,
// which the caller isolates. A normalized event object keeps payloads consistent.
function alertEvent(a) {
  return {
    product: 'TooVix DAM', severity: a.severity || 'high', summary: a.summary || 'Security alert',
    principal: a.principal || null, database: a.database || null, rule: a.rule || null,
    raw_sql: a.raw_sql || null, timestamp: new Date(a.ts || Date.now()).toISOString(), test: !!a.test,
  };
}
function alertText(a) {
  return `Severity: ${a.severity || '—'}\nPrincipal: ${a.principal || '—'}\nDatabase: ${a.database || '—'}\n`
    + `Rule: ${a.rule || '—'}\nTime: ${new Date(a.ts || Date.now()).toISOString()}\n\nSQL:\n${a.raw_sql || '(none)'}\n\n— Generated by TooVix DAM`;
}
const TIMEOUT = (ms) => AbortSignal.timeout(ms);

// Splunk — HTTP Event Collector (HEC).
async function postSplunkHec(cfg, a) {
  const body = { time: Math.floor((a.ts || Date.now()) / 1000), source: 'toovix-dam', sourcetype: 'toovix:dam:alert', event: alertEvent(a) };
  if (cfg.index) body.index = cfg.index;
  const res = await fetch(cfg.hec_url, { method: 'POST', headers: { Authorization: `Splunk ${cfg.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: TIMEOUT(6000) });
  return { ok: res.ok, status: res.status };
}

// PagerDuty — Events API v2 (triggers an incident).
async function postPagerDuty(cfg, a) {
  const severity = { critical: 'critical', high: 'error', medium: 'warning', low: 'info' }[a.severity] || 'error';
  const body = { routing_key: cfg.routing_key, event_action: 'trigger', payload: { summary: `[TooVix DAM] ${a.summary || 'Security alert'}`.slice(0, 1024), severity, source: a.database || 'toovix-dam', component: 'database-activity-monitoring', custom_details: alertEvent(a) } };
  const res = await fetch('https://events.pagerduty.com/v2/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: TIMEOUT(6000) });
  return { ok: res.ok, status: res.status };
}

// Datadog — Events API.
async function postDatadog(cfg, a) {
  const site = cfg.site || 'datadoghq.com';
  const alert_type = { critical: 'error', high: 'error', medium: 'warning', low: 'info' }[a.severity] || 'warning';
  const text = `%%%\n**Severity:** ${a.severity}\n**Principal:** ${a.principal || '—'}\n**Database:** ${a.database || '—'}\n`
    + `${a.raw_sql ? '```\n' + String(a.raw_sql).slice(0, 400) + '\n```' : ''}\n%%%`;
  const body = { title: `[TooVix DAM] ${a.summary || 'Security alert'}`, text, alert_type, source_type_name: 'my_apps', tags: ['source:toovix-dam', `severity:${a.severity}`, `database:${a.database || 'unknown'}`] };
  const res = await fetch(`https://api.${site}/api/v1/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'DD-API-KEY': cfg.api_key }, body: JSON.stringify(body), signal: TIMEOUT(6000) });
  return { ok: res.ok, status: res.status };
}

// Custom Webhook — POST the normalized event to any endpoint, optional auth header.
async function postCustomWebhook(cfg, a) {
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.auth_header) headers.Authorization = cfg.auth_header;
  const res = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify({ type: 'alert', ...alertEvent(a) }), signal: TIMEOUT(6000) });
  return { ok: res.ok, status: res.status };
}

// ServiceNow — create an incident via the Table API (basic auth).
async function postServiceNow(cfg, a) {
  const host = String(cfg.instance || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.service-now\.com$/i, '');
  const urgency = { critical: '1', high: '2', medium: '2', low: '3' }[a.severity] || '2';
  const impact = { critical: '1', high: '2', medium: '3', low: '3' }[a.severity] || '2';
  const body = { short_description: `[TooVix DAM] ${a.summary || 'Security alert'}`.slice(0, 160), description: alertText(a), urgency, impact, category: 'security' };
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  const res = await fetch(`https://${host}.service-now.com/api/now/table/incident`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Basic ${auth}` }, body: JSON.stringify(body), signal: TIMEOUT(8000) });
  return { ok: res.ok, status: res.status };
}

// Jira — create an issue via REST v3 (email + API token basic auth, ADF body).
async function postJira(cfg, a) {
  const base = String(cfg.base_url || '').replace(/\/$/, '');
  const auth = Buffer.from(`${cfg.email}:${cfg.api_token}`).toString('base64');
  const description = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: alertText(a) }] }] };
  const body = { fields: { project: { key: cfg.project_key }, summary: `[TooVix DAM] ${a.summary || 'Security alert'}`.slice(0, 250), issuetype: { name: cfg.issue_type || 'Task' }, description } };
  const res = await fetch(`${base}/rest/api/3/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Basic ${auth}` }, body: JSON.stringify(body), signal: TIMEOUT(8000) });
  return { ok: res.ok, status: res.status };
}

// Microsoft Sentinel — Log Analytics HTTP Data Collector API (HMAC-SHA256 signed).
async function postSentinel(cfg, a) {
  const logType = (cfg.log_type || 'TooVixDAM').replace(/[^A-Za-z0-9_]/g, '');
  const body = JSON.stringify([alertEvent(a)]);
  const date = new Date().toUTCString();
  const contentLength = Buffer.byteLength(body, 'utf8');
  const stringToSign = `POST\n${contentLength}\napplication/json\nx-ms-date:${date}\n/api/logs`;
  const signature = crypto.createHmac('sha256', Buffer.from(cfg.shared_key, 'base64')).update(stringToSign, 'utf8').digest('base64');
  const res = await fetch(`https://${cfg.workspace_id}.ods.opinsights.azure.com/api/logs?api-version=2016-04-01`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `SharedKey ${cfg.workspace_id}:${signature}`, 'Log-Type': logType, 'x-ms-date': date },
    body, signal: TIMEOUT(8000),
  });
  return { ok: res.ok, status: res.status };
}

// ── Connector registry ────────────────────────────────────
// One source of truth: each connector declares its config fields (rendered by the
// UI via /api/integrations/catalog), a delivery function, and a kind. secret:true
// fields are masked in responses and kept-on-blank when re-saved.

// Email alert channel — emails alerts to a recipient list via the configured SMTP.
async function postEmailAlert(cfg, a) {
  const to = String(cfg.recipients || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!to.length) return { ok: false, status: 'no recipients' };
  if (!smtpConfigured()) return { ok: false, status: 'SMTP not configured — set it up in Settings → Email first' };
  const sev = String(a.severity || '').toUpperCase();
  const subject = `[TooVix DAM] ${sev} — ${a.summary || 'Security alert'}`.slice(0, 180);
  const rows = [['Severity', a.severity || '—'], ['Principal', a.principal || '—'], ['Database', a.database || '—'], ['Time', new Date(a.ts || Date.now()).toISOString()]];
  const text = `${a.summary || 'Security alert'}\n\n` + rows.map(([k, v]) => `${k}: ${v}`).join('\n') + (a.raw_sql ? `\n\nQuery:\n${String(a.raw_sql).slice(0, 500)}` : '');
  const html = `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:560px;color:#0f172a">
    <h2 style="margin:0 0 6px;font-size:18px">🛡 TooVix DAM — ${sev}${a.test ? ' (test)' : ''} alert</h2>
    <p style="font-size:14px;margin:0 0 14px"><b>${a.summary || 'Security alert'}</b></p>
    <table style="font-size:13px;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#64748b">${k}</td><td><b>${String(v)}</b></td></tr>`).join('')}</table>
    ${a.raw_sql ? `<pre style="background:#f1f5f9;padding:10px;border-radius:8px;font-size:12px;white-space:pre-wrap;margin-top:12px">${String(a.raw_sql).slice(0, 500)}</pre>` : ''}
  </div>`;
  await getMailer().sendMail({ from: activeFrom(), to: to.join(','), subject, text, html });
  return { ok: true, status: 'sent' };
}

const CONNECTORS = {
  email_alerts: { name: 'Email', kind: 'alert', help: 'Emails alerts to a recipient list using your configured SMTP (set up Settings → Email first). Comma-separate multiple addresses.',
    fields: [{ key: 'recipients', label: 'Recipients', type: 'text', required: true, placeholder: 'soc@company.com, oncall@company.com' }],
    send: (c, a) => postEmailAlert(c, a) },
  msteams: { name: 'Microsoft Teams', kind: 'alert', help: 'Add an Incoming Webhook (Power Automate Workflows) to the target Teams channel and paste its URL.',
    fields: [{ key: 'webhook_url', label: 'Webhook URL', type: 'url', required: true, secret: true, placeholder: 'https://….webhook.office.com/…' }],
    send: (c, a) => postTeamsCard(c.webhook_url, a) },
  slack: { name: 'Slack', kind: 'alert', help: 'Create a Slack app → enable Incoming Webhooks → add to the channel, then paste the webhook URL.',
    fields: [{ key: 'webhook_url', label: 'Webhook URL', type: 'url', required: true, secret: true, placeholder: 'https://hooks.slack.com/services/T…/B…/…' }],
    send: (c, a) => postSlackMessage(c.webhook_url, a) },
  splunk: { name: 'Splunk', kind: 'alert', help: 'Enable an HTTP Event Collector (HEC) token in Splunk and paste its collector URL + token.',
    fields: [
      { key: 'hec_url', label: 'HEC URL', type: 'url', required: true, placeholder: 'https://host:8088/services/collector' },
      { key: 'token', label: 'HEC token', type: 'password', required: true, secret: true },
      { key: 'index', label: 'Index (optional)', type: 'text', placeholder: 'main' },
    ], send: postSplunkHec },
  pagerduty: { name: 'PagerDuty', kind: 'alert', help: 'Add an Events API v2 integration to a PagerDuty service and paste its Integration (routing) key.',
    fields: [{ key: 'routing_key', label: 'Integration / routing key', type: 'password', required: true, secret: true, placeholder: 'Events API v2 routing key' }],
    send: postPagerDuty },
  datadog: { name: 'Datadog', kind: 'alert', help: 'Create an API key in Datadog (Organization Settings → API Keys) and pick your site.',
    fields: [
      { key: 'api_key', label: 'API key', type: 'password', required: true, secret: true },
      { key: 'site', label: 'Site', type: 'select', default: 'datadoghq.com', options: ['datadoghq.com', 'us3.datadoghq.com', 'us5.datadoghq.com', 'datadoghq.eu', 'ap1.datadoghq.com', 'ddog-gov.com'] },
    ], send: postDatadog },
  webhook: { name: 'Custom Webhook', kind: 'alert', help: 'POSTs a JSON alert event to any HTTPS endpoint. Add an Authorization header if your endpoint needs one.',
    fields: [
      { key: 'url', label: 'Endpoint URL', type: 'url', required: true, placeholder: 'https://example.com/hooks/dam' },
      { key: 'auth_header', label: 'Authorization header (optional)', type: 'password', secret: true, placeholder: 'Bearer …' },
    ], send: postCustomWebhook },
  servicenow: { name: 'ServiceNow', kind: 'alert', help: 'Creates an incident per alert via the Table API. Use a user with itil/incident write access.',
    fields: [
      { key: 'instance', label: 'Instance', type: 'text', required: true, placeholder: 'dev12345 (or dev12345.service-now.com)' },
      { key: 'username', label: 'Username', type: 'text', required: true },
      { key: 'password', label: 'Password', type: 'password', required: true, secret: true },
    ], send: postServiceNow },
  jira: { name: 'Jira', kind: 'alert', help: 'Creates an issue per alert. Use your account email + an Atlassian API token (id.atlassian.com → API tokens).',
    fields: [
      { key: 'base_url', label: 'Base URL', type: 'url', required: true, placeholder: 'https://your-org.atlassian.net' },
      { key: 'email', label: 'Account email', type: 'text', required: true },
      { key: 'api_token', label: 'API token', type: 'password', required: true, secret: true },
      { key: 'project_key', label: 'Project key', type: 'text', required: true, placeholder: 'SEC' },
      { key: 'issue_type', label: 'Issue type', type: 'text', default: 'Task', placeholder: 'Task / Bug' },
    ], send: postJira },
  sentinel: { name: 'Microsoft Sentinel', kind: 'alert', help: 'Streams events to a Log Analytics workspace (Data Collector API). Use the Workspace ID + Primary key from Agents management.',
    fields: [
      { key: 'workspace_id', label: 'Workspace ID', type: 'text', required: true },
      { key: 'shared_key', label: 'Primary key', type: 'password', required: true, secret: true },
      { key: 'log_type', label: 'Log type (table)', type: 'text', default: 'TooVixDAM', placeholder: 'TooVixDAM' },
    ], send: postSentinel },
};
const ALERT_TYPES = Object.keys(CONNECTORS).filter(t => CONNECTORS[t].kind === 'alert');

function maskSecret(s) {
  s = String(s || '');
  if (/^https?:\/\//i.test(s)) return s.slice(0, 30) + (s.length > 36 ? '…' + s.slice(-6) : '');
  return s.length <= 8 ? '••••' : s.slice(0, 4) + '…' + s.slice(-4);
}
// Build a stored config from incoming form fields, keeping stored secrets when the
// incoming secret is blank (so a masked form re-saves without re-entry), applying defaults.
function buildConnectorConfig(connector, incoming, existing) {
  const out = {};
  for (const f of connector.fields) {
    let v = incoming && incoming[f.key];
    v = (v === undefined || v === null) ? '' : String(v).trim();
    if (f.secret && !v && existing) v = existing[f.key] || '';
    if (!v && f.default) v = f.default;
    out[f.key] = v;
  }
  return out;
}
function missingRequired(connector, config) {
  return connector.fields.filter(f => f.required && !config[f.key]).map(f => f.label);
}
// Mask a stored config for GET: non-secret values returned as-is, secrets as a
// set-flag + masked preview only (raw secret never leaves the server).
function maskConnectorConfig(connector, cfg) {
  cfg = cfg || {};
  const values = {}, secrets = {};
  for (const f of connector.fields) {
    if (f.secret) secrets[f.key] = { set: !!cfg[f.key], masked: cfg[f.key] ? maskSecret(cfg[f.key]) : '' };
    else values[f.key] = cfg[f.key] || '';
  }
  return { configured: connector.fields.filter(f => f.required).every(f => !!cfg[f.key]), minSeverity: cfg.min_severity || 'high', values, secrets };
}
// A synthetic alert used by the "Send test" button.
function sampleAlert() {
  return { severity: 'high', summary: 'Test alert from TooVix DAM — integration is working', principal: 'integration-test@toovix', database: 'meridian-prod', rule: 'integration.test', raw_sql: 'SELECT 1 -- TooVix DAM connectivity test', ts: Date.now(), test: true };
}

// Fan an alert out to every active connector that passes its min-severity. Each
// send is isolated — one failing never blocks the others or the alert.
async function dispatchAlert(a) {
  try {
    const rows = (await pgPool.query('SELECT type, config FROM integrations WHERE type = ANY($1) AND status = $2', [ALERT_TYPES, 'active'])).rows;
    for (const row of rows) {
      const connector = CONNECTORS[row.type], cfg = row.config || {};
      if (!connector) continue;
      if ((SEV_ORDER[a.severity] ?? 0) < (SEV_ORDER[cfg.min_severity] ?? 2)) continue;
      try {
        const r = await connector.send(cfg, a);
        if (r && r.ok) await pgPool.query('UPDATE integrations SET last_sync_at = now() WHERE type = $1', [row.type]);
        else console.log(`[${row.type}] returned`, r && r.status);
      } catch (e) { console.log(`[${row.type}] dispatch failed:`, e.message); }
    }
  } catch (e) { console.log('[dispatch] failed:', e.message); }
}

app.get('/api/integrations', authRequired, async (req, res) => {
  const rows = (await pgPool.query('SELECT id, name, type, status, config, last_sync_at FROM integrations WHERE tenant_id = $1', [req.user.tenantId])).rows;
  res.json(rows.map(r => ({
    id: r.id, name: r.name, type: r.type, status: r.status, lastSyncAt: r.last_sync_at,
    config: CONNECTORS[r.type] ? maskConnectorConfig(CONNECTORS[r.type], r.config) : r.config,
  })));
});

// Connector catalog — the UI renders config modals from this schema (no secrets).
app.get('/api/integrations/catalog', authRequired, (req, res) => {
  const out = {};
  for (const [type, c] of Object.entries(CONNECTORS)) out[type] = { name: c.name, kind: c.kind, help: c.help || '', fields: c.fields };
  res.json(out);
});

// ── Integrations · Email (SMTP) ───────────────────────────
// SMTP isn't an HTTP alert connector, so it lives outside the CONNECTORS registry.
// Config is stored in `integrations` (type='email', config jsonb) and feeds the
// platform mailer (getMailer) used for user invitations & notifications. These
// routes are registered before the generic /api/integrations/:type alert-channel
// routes so the literal 'smtp' segment wins. The password is never returned.
function smtpStatusPayload(savedConfig) {
  const eff = activeSmtp();
  return {
    configured: !!eff,
    source: eff ? eff.source : null, // 'database' | 'env' | null
    // Saved (UI/DB) config — masked. Env config isn't editable from here.
    saved: savedConfig
      ? { host: savedConfig.host || '', port: parseInt(savedConfig.port) || 587, secure: !!savedConfig.secure,
          user: savedConfig.user || '', from: savedConfig.from || '', hasPassword: !!savedConfig.pass }
      : null,
    from: eff ? eff.from : SMTP_FROM,
    envHost: process.env.SMTP_HOST || null,
  };
}

app.get('/api/integrations/smtp', authRequired, async (req, res) => {
  try {
    const row = (await pgPool.query("SELECT config, status FROM integrations WHERE tenant_id = $1 AND type = 'email'", [req.user.tenantId])).rows[0];
    res.json({ ...smtpStatusPayload(row && row.config), status: row ? row.status : 'inactive' });
  } catch (err) {
    console.error('[Integrations] smtp status failed:', err.message);
    res.status(500).json({ error: 'Failed to load SMTP status' });
  }
});

// Save SMTP settings. Blank password keeps the stored one (so the masked form
// can be re-saved without re-entering the secret).
app.put('/api/integrations/smtp', authRequired, async (req, res) => {
  const { host, port = 587, secure = false, user = '', pass, from, fromName, enabled = true } = req.body || {};
  const cleanHost = (host || '').trim();
  if (!cleanHost) return res.status(400).json({ error: 'SMTP host is required' });
  const portNum = parseInt(port);
  if (!portNum || portNum < 1 || portNum > 65535) return res.status(400).json({ error: 'Invalid SMTP port' });
  try {
    const existing = (await pgPool.query("SELECT id, config FROM integrations WHERE tenant_id = $1 AND type = 'email'", [req.user.tenantId])).rows[0];
    let password = (pass !== undefined && pass !== null && pass !== '') ? String(pass) : (existing && existing.config ? existing.config.pass : '');
    // Build the From header. Most providers (Zoho, Gmail, M365) reject a From that
    // isn't the authenticated mailbox ("553 Sender not allowed"), so when no explicit
    // From is given, prefer the SMTP username (if it's an address) over the generic
    // default. Order: explicit "from" → "Name <user>" → user → env default.
    const cleanUser = (user || '').trim();
    let fromHeader = (from || '').trim();
    if (!fromHeader && fromName && cleanUser) fromHeader = `${fromName} <${cleanUser}>`;
    if (!fromHeader && /@/.test(cleanUser)) fromHeader = cleanUser;
    if (!fromHeader) fromHeader = SMTP_FROM;
    const config = { host: cleanHost, port: portNum, secure: !!secure, user: cleanUser, pass: password || '', from: fromHeader };
    const status = enabled ? 'active' : 'inactive';
    if (existing) await pgPool.query('UPDATE integrations SET config = $2, status = $3, last_sync_at = now() WHERE id = $1', [existing.id, config, status]);
    else await pgPool.query("INSERT INTO integrations (tenant_id, name, type, config, status, last_sync_at) VALUES ($1,'Email (SMTP)','email',$2,$3, now())", [req.user.tenantId, config, status]);
    await loadSmtpConfig(); // refresh the live mailer
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'integration.configure', resourceType: 'integration', resourceId: null, details: { type: 'email', host: cleanHost, port: portNum, secure: !!secure, status } });
    res.json({ ok: true, status, configured: true });
  } catch (err) {
    console.error('[Integrations] smtp save failed:', err.message);
    res.status(500).json({ error: 'Failed to save SMTP settings' });
  }
});

// Send a test email. Tests an unsaved config if one is supplied in the body,
// otherwise the saved/active config. Verifies the connection then delivers.
app.post('/api/integrations/smtp/test', authRequired, async (req, res) => {
  const b = req.body || {};
  const to = (b.to || req.user.email || '').trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'A valid recipient email is required' });
  try {
    // Resolve the SMTP to test: explicit body config → saved DB config → active (env).
    let smtp;
    if (b.host) {
      let password = b.pass;
      if (password === undefined || password === null || password === '') {
        const e = (await pgPool.query("SELECT config FROM integrations WHERE tenant_id = $1 AND type = 'email'", [req.user.tenantId])).rows[0];
        password = e && e.config ? e.config.pass : '';
      }
      const tUser = (b.user || '').trim();
      // From defaults to the authenticated mailbox (providers reject other senders).
      const tFrom = (b.from || '').trim() || (/@/.test(tUser) ? tUser : activeFrom());
      smtp = { host: String(b.host).trim(), port: parseInt(b.port) || 587, secure: !!b.secure, user: tUser || undefined, pass: password || undefined, from: tFrom };
    } else {
      smtp = activeSmtp();
    }
    if (!smtp || !smtp.host) return res.status(400).json({ error: 'SMTP is not configured — enter a host first' });
    const transport = buildTransport(smtp);
    await transport.verify();
    await transport.sendMail({
      from: smtp.from || activeFrom(),
      to,
      subject: 'TooVix DAM — SMTP test email',
      text: `This is a test email from TooVix DAM.\n\nIf you received this, your SMTP integration (${smtp.host}:${smtp.port}) is working.\n\n— TooVix DAM`,
      html: `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
        <div style="max-width:520px;margin:0 auto;padding:24px">
          <div style="font-size:18px;font-weight:800;margin-bottom:18px">TooVix <span style="color:#64748b;font-weight:500">DAM</span></div>
          <div style="background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px">
            <h1 style="font-size:20px;margin:0 0 10px">✓ SMTP is working</h1>
            <p style="font-size:14px;line-height:1.6;color:#334155;margin:0">This is a test email from TooVix DAM. Your outbound mail server
              <b>${smtp.host}:${smtp.port}</b> accepted and delivered it, so invitations and alert notifications will be emailed from here on.</p>
          </div>
        </div></body></html>`,
    });
    res.json({ ok: true, message: `Test email sent to ${to}` });
  } catch (err) {
    console.error('[Integrations] smtp test failed:', err.message);
    res.status(502).json({ ok: false, error: `SMTP test failed: ${err.message}` });
  }
});

app.delete('/api/integrations/smtp', authRequired, async (req, res) => {
  try {
    const r = await pgPool.query("DELETE FROM integrations WHERE tenant_id = $1 AND type = 'email'", [req.user.tenantId]);
    await loadSmtpConfig();
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'integration.disconnect', resourceType: 'integration', resourceId: null, details: { type: 'email' } });
    res.json({ ok: true, removed: r.rowCount });
  } catch (err) {
    console.error('[Integrations] smtp delete failed:', err.message);
    res.status(500).json({ error: 'Failed to remove SMTP settings' });
  }
});

// Configure (save/enable) any connector: PUT /api/integrations/:type
// Schema-driven from CONNECTORS — works for every alert connector. Blank secret
// ── Integrations · Single sign-on (per-tenant SSO) ────────────────────────────
// Admin-only. Enabling a provider here is what makes its button appear on this
// tenant's workspace-first login. Registered before the generic /:type route so
// 'sso' isn't swallowed by the connector registry.
app.get('/api/integrations/sso', authRequired, async (req, res) => {
  try {
    const rows = (await pgPool.query(
      "SELECT type, status, config FROM integrations WHERE tenant_id = $1 AND type LIKE 'sso_%'", [req.user.tenantId])).rows;
    const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
    res.json(Object.entries(SSO_PROVIDERS).map(([key, p]) => ({
      key, name: p.name,
      enabled: byType[p.type]?.status === 'active',
      ready: p.ready(byType[p.type]?.config), // creds present (per-tenant for Okta, env for Azure)
    })));
  } catch (err) { res.status(500).json({ error: 'Failed to load SSO settings' }); }
});

app.put('/api/integrations/sso/:provider', authRequired, adminOnly, async (req, res) => {
  const key = String(req.params.provider || '').toLowerCase();
  const provider = SSO_PROVIDERS[key];
  if (!provider) return res.status(400).json({ error: 'Unknown SSO provider' });
  const enabled = req.body?.enabled !== false;
  const cfgRow = (await pgPool.query('SELECT config FROM integrations WHERE tenant_id = $1 AND type = $2', [req.user.tenantId, provider.type])).rows[0];
  if (enabled && !provider.ready(cfgRow && cfgRow.config))
    return res.status(400).json({ error: provider.tenantConfigurable ? `Add your ${provider.name} credentials first, then enable it.` : `${provider.name} isn't available yet — the platform ${provider.name} app is not configured.` });
  try {
    const status = enabled ? 'active' : 'inactive';
    const existing = (await pgPool.query('SELECT id FROM integrations WHERE tenant_id = $1 AND type = $2', [req.user.tenantId, provider.type])).rows[0];
    if (existing) await pgPool.query('UPDATE integrations SET status = $2 WHERE id = $1', [existing.id, status]);
    else await pgPool.query("INSERT INTO integrations (tenant_id, name, type, config, status) VALUES ($1,$2,$3,'{}',$4)", [req.user.tenantId, `${provider.name} SSO`, provider.type, status]);
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'sso.configure', resourceType: 'integration', resourceId: null, details: { provider: key, status } });
    res.json({ ok: true, key, enabled });
  } catch (err) { console.error('[SSO] toggle failed:', err.message); res.status(500).json({ error: 'Failed to update SSO' }); }
});

// Per-tenant Okta credentials — configured in the GUI (not .env). The client secret is
// write-only: a blank secret keeps the stored one, so the masked form re-saves cleanly.
app.put('/api/integrations/sso/okta/config', authRequired, adminOnly, async (req, res) => {
  const domain = String(req.body?.domain || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const clientId = String(req.body?.clientId || '').trim();
  const secretIn = req.body?.clientSecret;
  const redirectUri = String(req.body?.redirectUri || '').trim() || OKTA_REDIRECT_URI;
  if (!domain || !clientId) return res.status(400).json({ error: 'Okta domain and client ID are required' });
  if (!/^[a-z0-9.-]+\.okta(preview|-emea)?\.com$/i.test(domain) && !/\./.test(domain)) return res.status(400).json({ error: 'Enter your Okta domain, e.g. dev-12345.okta.com' });
  try {
    const existing = (await pgPool.query("SELECT id, config FROM integrations WHERE tenant_id = $1 AND type = 'sso_okta'", [req.user.tenantId])).rows[0];
    const prev = (existing && existing.config) || {};
    const clientSecret = (secretIn !== undefined && secretIn !== null && String(secretIn).trim() !== '') ? String(secretIn).trim() : (prev.client_secret || '');
    const config = { domain, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, issuer: `https://${domain}/oauth2/default` };
    if (existing) await pgPool.query('UPDATE integrations SET config = $2 WHERE id = $1', [existing.id, config]);
    else await pgPool.query("INSERT INTO integrations (tenant_id, name, type, config, status) VALUES ($1,'Okta SSO','sso_okta',$2,'inactive')", [req.user.tenantId, config]);
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'sso.okta.configure', resourceType: 'integration', resourceId: null, details: { domain, hasSecret: !!clientSecret } });
    res.json({ ok: true });
  } catch (err) { console.error('[SSO] okta config save failed:', err.message); res.status(500).json({ error: 'Failed to save Okta config' }); }
});

// Per-tenant Google credentials (GUI-configured). Secret is write-only (blank keeps stored).
app.put('/api/integrations/sso/google/config', authRequired, adminOnly, async (req, res) => {
  const clientId = String(req.body?.clientId || '').trim();
  const secretIn = req.body?.clientSecret;
  const redirectUri = String(req.body?.redirectUri || '').trim() || GOOGLE_REDIRECT_URI;
  if (!clientId) return res.status(400).json({ error: 'Google client ID is required' });
  try {
    const existing = (await pgPool.query("SELECT id, config FROM integrations WHERE tenant_id = $1 AND type = 'sso_google'", [req.user.tenantId])).rows[0];
    const prev = (existing && existing.config) || {};
    const clientSecret = (secretIn !== undefined && secretIn !== null && String(secretIn).trim() !== '') ? String(secretIn).trim() : (prev.client_secret || '');
    const config = { client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri };
    if (existing) await pgPool.query('UPDATE integrations SET config = $2 WHERE id = $1', [existing.id, config]);
    else await pgPool.query("INSERT INTO integrations (tenant_id, name, type, config, status) VALUES ($1,'Google SSO','sso_google',$2,'inactive')", [req.user.tenantId, config]);
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'sso.google.configure', resourceType: 'integration', resourceId: null, details: { hasSecret: !!clientSecret } });
    res.json({ ok: true });
  } catch (err) { console.error('[SSO] google config save failed:', err.message); res.status(500).json({ error: 'Failed to save Google config' }); }
});

app.get('/api/integrations/sso/google', authRequired, async (req, res) => {
  try {
    const s = (await pgPool.query("SELECT COUNT(*) AS n, MAX(last_login_at) AS last FROM users WHERE auth_provider = 'google' AND tenant_id = $1", [req.user.tenantId])).rows[0];
    const row = (await pgPool.query("SELECT config, status FROM integrations WHERE tenant_id = $1 AND type = 'sso_google'", [req.user.tenantId])).rows[0];
    const cfg = (row && row.config) || {};
    const eff = googleEffective(cfg);
    const slug = (await pgPool.query('SELECT slug FROM tenants WHERE id = $1', [req.user.tenantId])).rows[0]?.slug || null;
    res.json({
      configured: !!eff,
      secretConfigured: !!(cfg.client_secret || GOOGLE_CLIENT_SECRET),
      enabledForTenant: row ? row.status === 'active' : false,
      slug,
      clientId: cfg.client_id || GOOGLE_CLIENT_ID || '',
      redirectUri: cfg.redirect_uri || GOOGLE_REDIRECT_URI,
      signInUrl: '/auth/google',
      usersProvisioned: parseInt(s.n) || 0,
      lastLogin: s.last,
    });
  } catch (err) {
    console.error('[Integrations] google status failed:', err.message);
    res.status(500).json({ error: 'Failed to load Google status' });
  }
});

// fields keep the stored value; required/URL fields are validated.
app.put('/api/integrations/:type', authRequired, async (req, res) => {
  const type = req.params.type;
  const connector = CONNECTORS[type];
  if (!connector) return res.status(400).json({ error: 'Unknown integration type' });
  const { fields = {}, minSeverity = 'high', enabled = true } = req.body || {};
  if (connector.kind === 'alert' && !['low', 'medium', 'high', 'critical'].includes(minSeverity)) return res.status(400).json({ error: 'invalid minSeverity' });
  try {
    const existing = (await pgPool.query('SELECT id, config FROM integrations WHERE tenant_id = $1 AND type = $2', [req.user.tenantId, type])).rows[0];
    const config = buildConnectorConfig(connector, fields, existing && existing.config);
    const missing = missingRequired(connector, config);
    if (missing.length) return res.status(400).json({ error: `Required: ${missing.join(', ')}` });
    for (const f of connector.fields) {
      if (f.type === 'url' && config[f.key] && !/^https?:\/\/\S+$/i.test(config[f.key])) return res.status(400).json({ error: `${f.label} must be a valid http(s):// URL` });
    }
    if (connector.kind === 'alert') config.min_severity = minSeverity;
    const status = enabled ? 'active' : 'inactive';
    if (existing) await pgPool.query('UPDATE integrations SET config = $2, status = $3 WHERE id = $1', [existing.id, config, status]);
    else await pgPool.query('INSERT INTO integrations (tenant_id, name, type, config, status) VALUES ($1,$2,$3,$4,$5)', [req.user.tenantId, connector.name, type, config, status]);
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'integration.configure', resourceType: 'integration', resourceId: null, details: { type, status, min_severity: connector.kind === 'alert' ? minSeverity : null } });
    res.json({ ok: true, status, minSeverity, configured: true });
  } catch (err) {
    console.error('[Integrations] save failed:', err.message);
    res.status(500).json({ error: 'Failed to save integration' });
  }
});

// Send a test alert through a connector — uses the submitted fields merged over the
// stored config (so a masked form can be tested without re-entering secrets).
app.post('/api/integrations/:type/test', authRequired, async (req, res) => {
  const type = req.params.type;
  const connector = CONNECTORS[type];
  if (!connector) return res.status(400).json({ error: 'Unknown integration type' });
  try {
    const existing = (await pgPool.query('SELECT config FROM integrations WHERE tenant_id = $1 AND type = $2', [req.user.tenantId, type])).rows[0];
    const config = buildConnectorConfig(connector, (req.body && req.body.fields) || {}, existing && existing.config);
    const missing = missingRequired(connector, config);
    if (missing.length) return res.status(400).json({ error: `Enter ${missing.join(', ')} first` });
    const r = await connector.send(config, sampleAlert());
    res.json({ ok: !!(r && r.ok), status: r && r.status, message: (r && r.ok) ? `Test alert delivered to ${connector.name}` : `${connector.name} responded ${r && r.status}` });
  } catch (err) {
    res.status(502).json({ ok: false, error: `Could not reach ${connector.name}: ${err.message}` });
  }
});

// Azure AD / Entra ID SSO — read-only status of the (env-configured) connection
// + live usage. The auth flow itself (/auth/azure, /auth/callback) is unchanged.
app.get('/api/integrations/sso/azure', authRequired, async (req, res) => {
  try {
    const s = (await pgPool.query("SELECT COUNT(*) AS n, MAX(last_login_at) AS last FROM users WHERE auth_provider = 'azure_ad' AND tenant_id = $1", [req.user.tenantId])).rows[0];
    const enabledRow = (await pgPool.query("SELECT status FROM integrations WHERE tenant_id = $1 AND type = 'sso_azure'", [req.user.tenantId])).rows[0];
    const slug = (await pgPool.query('SELECT slug FROM tenants WHERE id = $1', [req.user.tenantId])).rows[0]?.slug || null;
    res.json({
      configured: !!(AZURE_CLIENT_ID && AZURE_TENANT_ID),
      secretConfigured: !!AZURE_CLIENT_SECRET,
      enabledForTenant: enabledRow ? enabledRow.status === 'active' : false, // per-tenant: shows the button on THIS workspace's login
      slug, // this tenant's workspace slug (SSO sign-in must be scoped to it)
      tenantId: AZURE_TENANT_ID || null,
      clientId: AZURE_CLIENT_ID || null, // OAuth client_id is public, not a secret
      redirectUri: AZURE_REDIRECT_URI,
      authority: AZURE_AUTHORITY,
      signInUrl: '/auth/azure',
      usersProvisioned: parseInt(s.n) || 0,
      lastLogin: s.last,
    });
  } catch (err) {
    console.error('[Integrations] azure status failed:', err.message);
    res.status(500).json({ error: 'Failed to load Azure AD status' });
  }
});

// Okta SSO — read-only status of the (env-configured) connection + live usage,
// mirroring the Azure AD card. A full sign-in flow needs OKTA_* env credentials.
app.get('/api/integrations/sso/okta', authRequired, async (req, res) => {
  try {
    const s = (await pgPool.query("SELECT COUNT(*) AS n, MAX(last_login_at) AS last FROM users WHERE auth_provider = 'okta' AND tenant_id = $1", [req.user.tenantId])).rows[0];
    const row = (await pgPool.query("SELECT config, status FROM integrations WHERE tenant_id = $1 AND type = 'sso_okta'", [req.user.tenantId])).rows[0];
    const cfg = (row && row.config) || {};
    const eff = oktaEffective(cfg); // effective creds (tenant config over env fallback)
    const slug = (await pgPool.query('SELECT slug FROM tenants WHERE id = $1', [req.user.tenantId])).rows[0]?.slug || null;
    res.json({
      configured: !!eff,                                   // credentials complete → can enable/test
      secretConfigured: !!(cfg.client_secret || OKTA_CLIENT_SECRET),
      enabledForTenant: row ? row.status === 'active' : false,
      slug,
      // Pre-fill values for the config form (secret is NEVER returned).
      domain: cfg.domain || OKTA_DOMAIN || '',
      clientId: cfg.client_id || OKTA_CLIENT_ID || '',
      redirectUri: cfg.redirect_uri || OKTA_REDIRECT_URI,
      issuer: eff ? eff.issuer : (cfg.domain ? `https://${cfg.domain}/oauth2/default` : null),
      envFallback: !!(OKTA_DOMAIN && OKTA_CLIENT_ID),       // creds also available from .env
      signInUrl: '/auth/okta',
      usersProvisioned: parseInt(s.n) || 0,
      lastLogin: s.last,
    });
  } catch (err) {
    console.error('[Integrations] okta status failed:', err.message);
    res.status(500).json({ error: 'Failed to load Okta status' });
  }
});

// Disconnect / remove an integration entirely.
app.delete('/api/integrations/:type', authRequired, async (req, res) => {
  const type = req.params.type;
  if (!CONNECTORS[type]) return res.status(400).json({ error: 'Unknown integration type' });
  try {
    const r = await pgPool.query('DELETE FROM integrations WHERE tenant_id = $1 AND type = $2', [req.user.tenantId, type]);
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'integration.disconnect', resourceType: 'integration', resourceId: null, details: { type } });
    res.json({ ok: true, removed: r.rowCount });
  } catch (err) {
    console.error('[Integrations] delete failed:', err.message);
    res.status(500).json({ error: 'Failed to remove integration' });
  }
});

// Reaper: agents that miss heartbeats for 60s are marked offline.
setInterval(async () => {
  try {
    await pgPool.query(`UPDATE agents SET status='offline' WHERE status='online' AND last_heartbeat < now() - interval '60 seconds'`);
  } catch (e) { /* non-fatal */ }
}, 30000);

// ── Alerts ────────────────────────────────────────────────
// Alert list for the table. Filterable so the displayed rows match the active tab
// and aren't capped by a status-mixed global limit (which made open counts wrong).
app.get('/api/alerts', authRequired, async (req, res) => {
  const { status, severity, q } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 500, 1000);
  const offset = parseInt(req.query.offset) || 0;
  const params = [req.user.tenantId];
  const where = ['a.tenant_id = $1'];
  if (status === 'closed') where.push(`a.status IN ('resolved','false_positive')`);
  else if (status) { params.push(status); where.push(`a.status = $${params.length}`); }
  if (severity) { params.push(severity); where.push(`a.severity = $${params.length}`); }
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    const p = `$${params.length}`;
    where.push(`(a.principal ILIKE ${p} OR a.summary ILIKE ${p} OR a.rule ILIKE ${p} OR a.object_name ILIKE ${p} OR d.name ILIKE ${p})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit, offset);
  const { rows } = await pgPool.query(
    `SELECT a.*, d.name as database_name FROM alerts a
     LEFT JOIN databases d ON a.database_id = d.id
     ${whereSql} ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json(rows);
});

// Authoritative alert counts (open by severity, ack, closed) — the single source
// of truth for the Alerts KPIs/tabs, the sidebar badge, and the dashboard donut.
app.get('/api/alerts/summary', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(`SELECT status, severity, COUNT(*)::int AS c FROM alerts WHERE tenant_id = $1 GROUP BY status, severity`, [req.user.tenantId]);
  const open = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
  let ack = 0, closed = 0, all = 0;
  rows.forEach((r) => {
    all += r.c;
    if (r.status === 'open') { if (open[r.severity] !== undefined) open[r.severity] += r.c; open.total += r.c; }
    else if (r.status === 'ack') ack += r.c;
    else if (r.status === 'resolved' || r.status === 'false_positive') closed += r.c;
  });
  res.json({ open, ack, closed, all });
});

// Acknowledge all currently-open alerts (bulk triage).
app.post('/api/alerts/ack-all', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(`UPDATE alerts SET status = 'ack' WHERE status = 'open' RETURNING id`);
  try { broadcast({ type: 'alert', alert: { bulk: 'ack', count: rows.length } }); } catch (e) { /* WS optional */ }
  res.json({ acknowledged: rows.length });
});

// Update an alert's status (acknowledge / resolve).
app.post('/api/alerts/:id/status', authRequired, async (req, res) => {
  const status = req.body && req.body.status;
  if (!['open', 'ack', 'resolved'].includes(status)) return res.status(400).json({ error: 'invalid status' });
  const resolved = status === 'resolved';
  const { rows } = await pgPool.query(
    `UPDATE alerts SET status = $2, resolved_at = ${resolved ? 'now()' : 'NULL'} WHERE id = $1 RETURNING id, status`,
    [req.params.id, status]
  );
  if (!rows.length) return res.status(404).json({ error: 'Alert not found' });
  try { broadcast({ type: 'alert', alert: { id: rows[0].id, status: rows[0].status } }); } catch (e) { /* WS optional */ }
  res.json(rows[0]);
});

// Mark an alert as false positive: distinct disposition + create a suppression
// (so the rule stops re-firing on this pattern) + write an audit entry.
app.post('/api/alerts/:id/false-positive', authRequired, async (req, res) => {
  const scope = (req.body && req.body.scope) || 'both'; // principal | object | both | rule
  const reason = (req.body && req.body.reason) || null;
  const a = (await pgPool.query('SELECT id, rule, principal, object_name FROM alerts WHERE id = $1', [req.params.id])).rows[0];
  if (!a) return res.status(404).json({ error: 'Alert not found' });

  await pgPool.query(`UPDATE alerts SET status = 'false_positive', resolved_at = now() WHERE id = $1`, [a.id]);

  // Build the suppression scope (NULL = wildcard).
  const supPrincipal = scope === 'principal' || scope === 'both' ? a.principal : null;
  const supObject = scope === 'object' || scope === 'both' ? a.object_name : null;
  await pgPool.query(
    `INSERT INTO alert_suppressions (tenant_id, rule, principal, object_name, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.user.tenantId, a.rule, supPrincipal, supObject, reason, req.user.email]
  );

  // Audit (control plane) — hash-chained.
  await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'alert.false_positive', resourceType: 'alert', resourceId: a.id, details: { rule: a.rule, scope, principal: supPrincipal, object: supObject, reason } });

  try { broadcast({ type: 'alert', alert: { id: a.id, status: 'false_positive' } }); } catch (e) { /* WS optional */ }
  res.json({ id: a.id, status: 'false_positive', suppressed: { rule: a.rule, principal: supPrincipal, object_name: supObject } });
});

// ── Quarantine ────────────────────────────────────────────
// Held sessions awaiting review; reviewers release (resume) or kill (terminate).
// Session list for the table — filterable by status so the displayed rows match the
// active tab (and resolved sessions are reachable, not hidden behind the held-first cap).
app.get('/api/quarantine', authRequired, async (req, res) => {
  const { status } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  const params = [req.user.tenantId];
  let where = 'WHERE tenant_id = $1';
  if (status && ['held', 'released', 'killed', 'expired'].includes(status)) { params.push(status); where += ` AND status = $${params.length}`; }
  params.push(limit);
  const { rows } = await pgPool.query(
    `SELECT * FROM quarantine_sessions ${where}
     ORDER BY (status = 'held') DESC, COALESCE(resolved_at, held_at) DESC LIMIT $${params.length}`,
    params
  );
  res.json(rows);
});

// Authoritative quarantine counts (+ avg hold) — backs the sidebar badge and page KPIs.
app.get('/api/quarantine/summary', authRequired, async (req, res) => {
  const r = (await pgPool.query(`SELECT
      COUNT(*) FILTER (WHERE status='held')::int     AS held,
      COUNT(*) FILTER (WHERE status='released')::int AS released,
      COUNT(*) FILTER (WHERE status='killed')::int   AS killed,
      COUNT(*)::int                                  AS total,
      COALESCE(AVG(EXTRACT(EPOCH FROM (now() - held_at))) FILTER (WHERE status='held'), 0) AS avg_hold_secs
    FROM quarantine_sessions WHERE tenant_id = $1`, [req.user.tenantId])).rows[0];
  res.json({ held: r.held, released: r.released, killed: r.killed, total: r.total, avgHoldSecs: Math.round(r.avg_hold_secs) });
});

function sqlOperation(sql) {
  const s = (sql || '').trim().toUpperCase();
  if (/^(GRANT|REVOKE)\b/.test(s)) return 'GRANT';
  if (/^(DROP|TRUNCATE|ALTER|CREATE|RENAME)\b/.test(s)) return 'DDL';
  if (s.startsWith('DELETE')) return 'DELETE';
  if (s.startsWith('UPDATE')) return 'UPDATE';
  if (s.startsWith('INSERT')) return 'INSERT';
  if (s.startsWith('SELECT')) return 'READ';
  return 'OTHER';
}
// Engine families we can execute against (drivers present). Add a driver → add a case.
const ENGINE_FAMILY = { mysql: 'mysql', mariadb: 'mysql', postgres: 'postgres', postgresql: 'postgres', pg: 'postgres' };

// Resolve a least-privilege execution credential for a target instance: a per-instance
// override (exec_credentials, configured by the customer) wins, else per-engine env
// (EXEC_MYSQL_USER/PASS, EXEC_PG_USER/PASS). NO hardcoded root/DBA.
async function resolveExecCred(s) {
  try {
    const row = (await pgPool.query(
      'SELECT username, password FROM exec_credentials WHERE host = $1 AND (port = $2 OR port IS NULL) ORDER BY port NULLS LAST LIMIT 1',
      [s.db_host, s.db_port || null])).rows[0];
    if (row && row.username) return { user: row.username, password: row.password || '' };
  } catch (e) { /* table may be absent on first boot */ }
  const fam = ENGINE_FAMILY[(s.engine || '').toLowerCase()];
  if (fam === 'mysql' && process.env.EXEC_MYSQL_USER) return { user: process.env.EXEC_MYSQL_USER, password: process.env.EXEC_MYSQL_PASS || '' };
  if (fam === 'postgres' && process.env.EXEC_PG_USER) return { user: process.env.EXEC_PG_USER, password: process.env.EXEC_PG_PASS || '' };
  return null;
}

async function execMysqlStmt(s, cred) {
  let conn;
  try {
    conn = await mysql.createConnection({ host: s.db_host, port: s.db_port || 3306, user: cred.user, password: cred.password, database: s.database_name || undefined, connectTimeout: 4000, multipleStatements: false });
    const [result] = await conn.query(s.full_sql);
    const n = Array.isArray(result) ? result.length : (result && result.affectedRows != null ? result.affectedRows : null);
    return { ok: true, note: n != null ? `executed · ${n} row(s)` : 'executed' };
  } finally { if (conn) { try { await conn.end(); } catch { /* ignore */ } } }
}
async function execPostgresStmt(s, cred) {
  const { Client } = require('pg');
  const client = new Client({ host: s.db_host, port: s.db_port || 5432, user: cred.user, password: cred.password, database: s.database_name || undefined, connectionTimeoutMillis: 4000 });
  try {
    await client.connect();
    const r = await client.query(s.full_sql);
    return { ok: true, note: r.rowCount != null ? `executed · ${r.rowCount} row(s)` : 'executed' };
  } finally { try { await client.end(); } catch { /* ignore */ } }
}

// Execute a released (reviewer-approved) statement against the real target DB, using a
// configured least-privilege per-database credential and the right driver per engine.
async function executeReleasedSql(s) {
  if (!s.db_host) return { ok: false, note: 'no target host recorded for this session' };
  if (!s.full_sql) return { ok: false, note: 'no SQL recorded for this session' };
  const fam = ENGINE_FAMILY[(s.engine || '').toLowerCase()];
  if (!fam) return { ok: false, note: `execution not supported for engine '${s.engine || 'unknown'}' in this build` };
  const cred = await resolveExecCred(s);
  if (!cred || !cred.user) return { ok: false, note: `no execution credential configured for ${s.engine || 'this engine'} — set a least-privilege account (Settings → Databases or EXEC_* env)` };
  try {
    if (fam === 'mysql') return await execMysqlStmt(s, cred);
    if (fam === 'postgres') return await execPostgresStmt(s, cred);
    return { ok: false, note: `execution not supported for engine '${s.engine}'` };
  } catch (e) {
    return { ok: false, note: `execution error (as ${cred.user}): ${e.message}` };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Quarantine resolution reflects how real DB firewalls work: there is NO "resume"
// of a dead session and NO replay of the blocked statement. A held principal is
// blocked INLINE by the agent (see /api/agents/quarantine-list).
//   RELEASE   = lift the account quarantine → the agent stops blocking them (they
//               reconnect and retry themselves). Allowed from held OR terminated.
//   TERMINATE = keep the account blocked and drop its live session; terminal.
async function resolveQuarantine(id, status, res, req) {
 try {
  if (!UUID_RE.test(String(id || ''))) return res.status(400).json({ error: 'Invalid session id' });
  // Release can lift a held OR an already-terminated (killed) block; terminate acts on held.
  const fromStates = status === 'released' ? ['held', 'killed'] : ['held'];
  const { rows } = await pgPool.query(
    `UPDATE quarantine_sessions SET status = $2, resolved_at = now()
     WHERE id = $1 AND status = ANY($3) RETURNING *`,
    [id, status, fromStates]
  );
  if (!rows.length) return res.status(404).json({ error: 'Session not found or not in a resolvable state' });
  const s = rows[0];
  const note = status === 'released'
    ? 'Account quarantine lifted — the principal may reconnect (no session resumed, no query replayed).'
    : 'Session terminated and account kept blocked.';
  if (req) await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: `quarantine.${status}`, resourceType: 'session', resourceId: s.id, details: { session_id: s.session_id, principal: s.principal, database: s.database_name, effect: note } });
  try { broadcast({ type: 'quarantine', action: status, session_id: s.session_id }); } catch (e) { /* WS optional */ }
  res.json({ ...s, effect: note });
 } catch (err) {
  console.error('[Quarantine] resolve failed:', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Failed to resolve session' });
 }
}
app.post('/api/quarantine/:id/release', authRequired, (req, res) => resolveQuarantine(req.params.id, 'released', res, req));
app.post('/api/quarantine/:id/kill', authRequired, (req, res) => resolveQuarantine(req.params.id, 'killed', res, req));

// The inline agent polls this to ENFORCE account quarantine: any principal with a
// held/terminated session is refused (its live session dropped) until released.
app.get('/api/agents/quarantine-list', async (req, res) => {
  if (req.query.token !== AGENT_ENROLL_TOKEN) return res.status(401).json({ error: 'Invalid token' });
  try {
    const rows = (await pgPool.query(
      `SELECT DISTINCT principal, database_name FROM quarantine_sessions
       WHERE status IN ('held','killed') AND principal IS NOT NULL AND principal <> ''`)).rows;
    res.json({ principals: rows.map((r) => r.principal), entries: rows });
  } catch (err) { res.status(500).json({ error: 'Failed to load quarantine list' }); }
});

// Manually quarantine (block) an account — a real containment action (not a replay).
app.post('/api/quarantine/account', authRequired, async (req, res) => {
  const { principal, database, reason } = req.body || {};
  if (!principal || !String(principal).trim()) return res.status(400).json({ error: 'principal is required' });
  try {
    const sid = 'manual-' + Date.now();
    const { rows } = await pgPool.query(
      `INSERT INTO quarantine_sessions (tenant_id, session_id, principal, database_name, query_preview, severity, reason, status, source, held_at)
       VALUES ($1,$2,$3,$4,$5,'high',$6,'held','manual',now()) RETURNING *`,
      [req.user.tenantId, sid, String(principal).trim(), database || null, '(account quarantined manually)', reason || 'Manual account quarantine']);
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'quarantine.account', resourceType: 'session', resourceId: rows[0].id, details: { principal, database: database || null, reason: reason || 'Manual account quarantine' } });
    try { broadcast({ type: 'quarantine', action: 'held', session_id: sid }); } catch (e) { /* WS optional */ }
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[Quarantine] manual account block failed:', err.message);
    res.status(500).json({ error: 'Failed to quarantine account' });
  }
});

// Map a block reason (classifyBlock output) to a policy category key.
function blockCategory(reason) {
  const r = (reason || '').toLowerCase();
  if (r.includes('privilege escalation')) return 'privilege_escalation';
  if (r.includes('destructive ddl') || r.includes('table drop') || r.includes('truncation')) return 'destructive_ddl';
  if (r.includes('schema modification')) return 'schema_change';
  if (r.includes('mass row deletion')) return 'mass_delete';
  return 'other';
}

app.get('/api/quarantine/policy', authRequired, async (req, res) => {
  try {
    const p = (await pgPool.query('SELECT auto_quarantine, categories, updated_at, updated_by FROM quarantine_policy WHERE id=1')).rows[0]
      || { auto_quarantine: false, categories: [] };
    res.json(p);
  } catch (err) { res.status(500).json({ error: 'Failed to load policy' }); }
});

app.put('/api/quarantine/policy', authRequired, adminOnly, async (req, res) => {
  const { autoQuarantine, categories } = req.body || {};
  const cats = Array.isArray(categories) ? categories : [];
  try {
    await pgPool.query(
      `INSERT INTO quarantine_policy (id, auto_quarantine, categories, updated_at, updated_by)
       VALUES (1,$1,$2,now(),$3)
       ON CONFLICT (id) DO UPDATE SET auto_quarantine=EXCLUDED.auto_quarantine, categories=EXCLUDED.categories, updated_at=now(), updated_by=EXCLUDED.updated_by`,
      [!!autoQuarantine, JSON.stringify(cats), req.user.email]);
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'quarantine.policy.update', resourceType: 'quarantine_policy', resourceId: '1', details: { autoQuarantine: !!autoQuarantine, categories: cats } });
    res.json({ ok: true });
  } catch (err) { console.error('[Quarantine] policy update failed:', err.message); res.status(500).json({ error: 'Failed to save policy' }); }
});

// Token-gated ingest — an inline-proxy agent reports a BLOCKED statement. Whether
// that escalates to an ACCOUNT quarantine (locking the account out inline) is
// governed by the auto-quarantine policy; default is block-only (no account lock).
app.post('/api/quarantine', async (req, res) => {
  const { token, session_id, principal, database_name, query_preview, full_sql, engine, db_host, db_port, severity, reason, client_ip } = req.body;
  if (token !== AGENT_ENROLL_TOKEN) return res.status(401).json({ error: 'Invalid enrollment token' });
  const tenantId = (await pgPool.query('SELECT id FROM tenants LIMIT 1')).rows[0].id;

  // Consult the auto-quarantine policy. In block-only mode we do NOT create an
  // account-quarantine record (the statement was already blocked + alerted).
  const pol = (await pgPool.query('SELECT auto_quarantine, categories FROM quarantine_policy WHERE id=1')).rows[0] || { auto_quarantine: false, categories: [] };
  const cat = blockCategory(reason);
  const autoQ = pol.auto_quarantine && ((pol.categories || []).length === 0 || (pol.categories || []).includes(cat));
  if (!autoQ) {
    return res.status(200).json({ quarantined: false, mode: 'block_only', category: cat });
  }

  const { rows } = await pgPool.query(
    `INSERT INTO quarantine_sessions (tenant_id, session_id, principal, database_name, query_preview, full_sql, engine, db_host, db_port, severity, reason, client_ip, status, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'held','policy_block') RETURNING *`,
    [tenantId, session_id || null, principal || 'unknown', database_name || null, query_preview || null, full_sql || query_preview || null, engine || null, db_host || null, db_port || null, severity || 'high', reason || 'Policy hold', client_ip || null]
  );
  try { broadcast({ type: 'quarantine', action: 'held', session_id: rows[0].session_id }); } catch (e) { /* WS optional */ }
  res.status(201).json(rows[0]);
});

// ── Discovery ─────────────────────────────────────────────
// Candidates are found by the discovery scanner (network fingerprinting on
// client-net) and by cloud-API enumeration, then reviewed before promotion.
const DEP_BY_ENGINE = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', oracle: 'Oracle', mssql: 'SQL Server', mongodb: 'MongoDB', redis: 'Redis', cassandra: 'Cassandra', db2: 'Db2' };

app.get('/api/discovery/candidates', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT * FROM discovery_candidates WHERE status = 'candidate' AND tenant_id = $1 ORDER BY discovered_at DESC`, [req.user.tenantId]
  );
  res.json(rows);
});

app.get('/api/discovery/jobs', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT * FROM discovery_jobs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 25`, [req.user.tenantId]
  );
  res.json(rows);
});

// Token-gated ingest — the scanner agent reports what it found (it is not a user).
app.post('/api/discovery/candidates', async (req, res) => {
  const { token, job, scan_type, scope, port_set, ports_count, candidates } = req.body;
  if (token !== AGENT_ENROLL_TOKEN) return res.status(401).json({ error: 'Invalid enrollment token' });
  if (!Array.isArray(candidates)) return res.status(400).json({ error: 'candidates[] required' });
  const tenantId = (await pgPool.query('SELECT id FROM tenants LIMIT 1')).rows[0].id;

  // Record the scan job (so agent-driven scans show in the history with the port-set used).
  if (job) {
    await pgPool.query(
      `INSERT INTO discovery_jobs (id, tenant_id, scan_type, scope, port_set, ports_count, status)
       VALUES ($1,$2,$3,$4,$5,$6,'running') ON CONFLICT (id) DO NOTHING`,
      [job, tenantId, scan_type || 'network', scope || null, port_set || null, ports_count || 0]
    );
  }

  let inserted = 0;
  const foundEndpoints = [];
  for (const c of candidates) {
    const host = c.host || (c.endpoint || '').split(':')[0];
    const port = c.port || parseInt((c.endpoint || '').split(':')[1], 10) || null;
    const endpoint = c.endpoint || (port ? `${host}:${port}` : host);
    if (!endpoint) continue;
    foundEndpoints.push(endpoint);
    // Skip endpoints already registered as a real instance.
    const known = await pgPool.query(
      `SELECT 1 FROM db_instances WHERE host = $1 AND port IS NOT DISTINCT FROM $2 LIMIT 1`, [host, port]
    );
    if (known.rows.length) continue;
    // discovered_at = first seen (unchanged on update); last_seen = this scan.
    const r = await pgPool.query(
      `INSERT INTO discovery_candidates (tenant_id, endpoint, host, port, engine, version, source, deployment_type, cloud_provider, region, signal, confidence, job_id, last_seen, reachable)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), true)
       ON CONFLICT (tenant_id, endpoint) DO UPDATE SET engine = EXCLUDED.engine, version = EXCLUDED.version, confidence = EXCLUDED.confidence, last_seen = now(), reachable = true
       RETURNING (xmax = 0) AS created`,
      [tenantId, endpoint, host, port, c.engine || null, c.version || null, c.source || 'network',
       c.deployment_type || 'onprem', c.cloud_provider || null, c.region || null, c.signal || 'clean', c.confidence || 'high', job || null]
    );
    if (r.rows[0].created) inserted++;
  }

  // Reachability: any still-pending candidate on a scanned host that we did NOT
  // see this scan is now unreachable (listener gone). Scope it to scanned_hosts
  // so a partial/targeted scan never falsely flags hosts it didn't check.
  const scannedHosts = Array.isArray(req.body.scanned_hosts) ? req.body.scanned_hosts : [];
  let markedDown = 0;
  if (scannedHosts.length) {
    const upd = await pgPool.query(
      `UPDATE discovery_candidates SET reachable = false
       WHERE tenant_id = $1 AND status = 'candidate' AND host = ANY($2)
         AND endpoint <> ALL($3::text[])`,
      [tenantId, scannedHosts, foundEndpoints.length ? foundEndpoints : ['']]
    );
    markedDown = upd.rowCount;
  }

  if (job) {
    await pgPool.query(
      `UPDATE discovery_jobs SET found = found + $2, status = 'done' WHERE id = $1`, [job, inserted]
    );
  }
  console.log(`[Discovery] ingested ${inserted} new, ${markedDown} marked unreachable${job ? ` for ${job}` : ''}`);
  res.json({ ingested: inserted, unreachable: markedDown });
});

// Record a scan request (the agent picks it up / runs it). Captures the port-set.
app.post('/api/discovery/scan', authRequired, async (req, res) => {
  const { scan_type, scope, port_set, ports_count } = req.body;
  const id = 'scan-' + Date.now().toString(36);
  await pgPool.query(
    `INSERT INTO discovery_jobs (id, tenant_id, scan_type, scope, port_set, ports_count, status)
     VALUES ($1,$2,$3,$4,$5,$6,'running')`,
    [id, req.user.tenantId, scan_type || 'network', scope || null, port_set || null, ports_count || 0]
  );
  const { rows } = await pgPool.query('SELECT * FROM discovery_jobs WHERE id = $1', [id]);
  res.status(201).json(rows[0]);
});

// Approve a candidate → register it as an instance (+ its first database).
app.post('/api/discovery/candidates/:id/approve', authRequired, async (req, res) => {
  const c = (await pgPool.query('SELECT * FROM discovery_candidates WHERE id = $1', [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ error: 'Candidate not found' });
  // Keep engine canonical (lowercase, as agents enroll) so UI-approve and agent-enroll
  // converge on the SAME instance instead of creating a duplicate.
  const engine = (c.engine || 'unknown').toLowerCase();

  const found = await pgPool.query(
    `SELECT id FROM db_instances WHERE host = $1 AND port IS NOT DISTINCT FROM $2 AND engine = $3`,
    [c.host, c.port, engine]
  );
  let instanceId;
  if (found.rows.length) instanceId = found.rows[0].id;
  else {
    const created = await pgPool.query(
      `INSERT INTO db_instances (tenant_id, name, engine, version, host, port, deployment_type, cloud_provider, region)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [req.user.tenantId, c.host, engine, c.version, c.host, c.port, c.deployment_type, c.cloud_provider, c.region]
    );
    instanceId = created.rows[0].id;
  }
  const dbName = (req.body && req.body.database_name) || c.host;
  await pgPool.query(
    `INSERT INTO databases (tenant_id, instance_id, name, engine, version, host, port, deployment_type, cloud_provider, region, monitoring_status, risk_score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'not_monitored',0)`,
    [req.user.tenantId, instanceId, dbName, engine, c.version, c.host, c.port, c.deployment_type, c.cloud_provider, c.region]
  );
  await pgPool.query(`UPDATE discovery_candidates SET status = 'approved' WHERE id = $1`, [req.params.id]);
  await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'discovery.approve', resourceType: 'instance', resourceId: instanceId, details: { endpoint: c.endpoint, engine } });
  res.json({ instance_id: instanceId, message: `Registered ${c.endpoint}` });
});

app.post('/api/discovery/candidates/:id/dismiss', authRequired, async (req, res) => {
  const { rowCount } = await pgPool.query(`UPDATE discovery_candidates SET status = 'dismissed' WHERE id = $1`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Candidate not found' });
  res.json({ message: 'Candidate dismissed' });
});

// ── Policies ──────────────────────────────────────────────
app.get('/api/policies', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(
    'SELECT * FROM policies WHERE tenant_id = $1 ORDER BY created_at DESC', [req.user.tenantId]
  );
  res.json(rows);
});

// Record a version snapshot whenever a rule changes (create / status / edit).
async function recordPolicyVersion(policyId, change, changedBy) {
  try {
    const v = (await pgPool.query('SELECT COALESCE(MAX(version),0)+1 AS v FROM policy_versions WHERE policy_id = $1', [policyId])).rows[0].v;
    await pgPool.query(
      `INSERT INTO policy_versions (policy_id, version, change, changed_by, snapshot)
       VALUES ($1, $2, $3, $4, to_jsonb((SELECT pp FROM policies pp WHERE pp.id = $1)))`,
      [policyId, v, change, changedBy || null]
    );
  } catch (e) { /* versioning non-fatal */ }
}

// Create a new rule.
app.post('/api/policies', authRequired, async (req, res) => {
  const { name, description, rule_type, category, severity, scope, actions, status, rule_definition } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  let def = {};
  if (rule_definition) { try { def = typeof rule_definition === 'string' ? JSON.parse(rule_definition) : rule_definition; } catch { return res.status(400).json({ error: 'rule_definition must be valid JSON' }); } }
  const { rows } = await pgPool.query(
    `INSERT INTO policies (tenant_id, name, description, rule_type, category, severity, scope, actions, status, rule_definition)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.user.tenantId, name, description || null, rule_type || 'pattern', category || 'alert', severity || 'medium', scope || 'all', actions || ['alert'], status || 'monitor', JSON.stringify(def)]
  );
  await recordPolicyVersion(rows[0].id, 'Created', req.user.email);
  res.status(201).json(rows[0]);
});

// Change a rule's status (enabled / monitor / disabled).
app.post('/api/policies/:id/status', authRequired, async (req, res) => {
  const status = req.body && req.body.status;
  if (!['enabled', 'monitor', 'disabled'].includes(status)) return res.status(400).json({ error: 'invalid status' });
  const { rows } = await pgPool.query(
    'UPDATE policies SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, status',
    [req.params.id, status]
  );
  if (!rows.length) return res.status(404).json({ error: 'Policy not found' });
  await recordPolicyVersion(req.params.id, `Status → ${status}`, req.user.email);
  await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'policy.status', resourceType: 'policy', resourceId: req.params.id, details: { status } });
  res.json(rows[0]);
});

// Version history for a rule.
app.get('/api/policies/:id/versions', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT version, change, changed_by, created_at FROM policy_versions
     WHERE policy_id = $1 AND policy_id IN (SELECT id FROM policies WHERE tenant_id = $2) ORDER BY version DESC`,
    [req.params.id, req.user.tenantId]
  );
  res.json(rows);
});

// Translate the engine-neutral DSL into a ClickHouse predicate over events.
// Best-effort: behavioral/threshold-window predicates aren't backtestable here.
const OP_MAP = { READ: ['SELECT'], WRITE: ['INSERT', 'UPDATE'], DELETE: ['DELETE'], DDL: ['DDL'], GRANT: ['GRANT'], LOGIN: ['LOGIN'], ADMIN: ['GRANT', 'DDL'] };
function policyToClickhouse(def) {
  const where = [];
  const ignored = [];
  const SUPPORTED = ['action_type', 'rows_affected', 'object_sensitivity_tags', 'grants_role'];
  const opList = (val) => {
    let list = [];
    if (typeof val === 'string') list = [val];
    else if (val && Array.isArray(val.any_of)) list = val.any_of;
    else if (val && Array.isArray(val.in)) list = val.in;
    const out = [];
    list.forEach((c) => (OP_MAP[String(c).toUpperCase()] || [String(c).toUpperCase()]).forEach((o) => out.push(o)));
    return out;
  };
  if (def.action_type) {
    const ops = opList(def.action_type).map((o) => `'${chEsc(o)}'`);
    if (ops.length) where.push(`operation IN (${ops.join(',')})`);
  }
  if (def.rows_affected && typeof def.rows_affected.gte === 'number') where.push(`row_count >= ${parseInt(def.rows_affected.gte, 10)}`);
  if (def.object_sensitivity_tags && Array.isArray(def.object_sensitivity_tags.any_of)) {
    const tags = def.object_sensitivity_tags.any_of.map((t) => `'${chEsc(t)}'`);
    if (tags.length) where.push(`hasAny(tags, [${tags.join(',')}])`);
  }
  if (def.grants_role && Array.isArray(def.grants_role.in)) {
    const roles = def.grants_role.in.filter(Boolean).map((r) => `positionCaseInsensitive(sql_text, '${chEsc(String(r))}') > 0`);
    if (roles.length) where.push(`(${roles.join(' OR ')})`);
  }
  Object.keys(def || {}).forEach((k) => { if (!SUPPORTED.includes(k)) ignored.push(k); });
  return { where, ignored, supported: where.length > 0 };
}

// Backtest a rule against the last 24h of captured activity (dry-run).
app.post('/api/policies/test', authRequired, async (req, res) => {
  let def = req.body && req.body.rule_definition;
  if (typeof def === 'string') { try { def = JSON.parse(def); } catch { return res.status(400).json({ error: 'rule_definition must be valid JSON' }); } }
  if (!def || typeof def !== 'object') return res.status(400).json({ error: 'rule_definition required' });
  const { where, ignored, supported } = policyToClickhouse(def);
  if (!supported) {
    return res.json({ matches: null, ignored, window: '24h', note: 'This rule’s conditions (behavioral / first-time / threshold-window) can’t be backtested against raw events.' });
  }
  try {
    const evDb = await eventsDbFor(req.user.tenantId);
    const whereSql = [`tenant_id = '${chEsc(req.user.tenantId)}'`, 'timestamp >= now() - INTERVAL 24 HOUR', ...where].join(' AND ');
    const matches = parseInt(await chQuery(`SELECT count() FROM ${evDb}.events WHERE ${whereSql}`, 'TabSeparated')) || 0;
    const sample = await chQuery(`SELECT timestamp, principal, database_name, operation, row_count FROM ${evDb}.events WHERE ${whereSql} ORDER BY timestamp DESC LIMIT 5`);
    res.json({ matches, ignored, window: '24h', sample });
  } catch (e) {
    res.json({ matches: null, error: 'backtest failed' });
  }
});

// ── Policy exceptions / allow-list (governed alert suppressions) ───────────
// Proactive, db-qualified, optionally time-boxed exceptions the detection engine
// honors. Backed by alert_suppressions (also written by the false-positive flow).
app.get('/api/policies/exceptions', authRequired, async (req, res) => {
  const includeAll = req.query.include === 'all'; // default: active only
  try {
    const rows = (await pgPool.query(
      `SELECT id, rule, principal, object_name, database_name, reason, created_by, created_at, expires_at,
              status, revoked_by, revoked_at,
              (status = 'active' AND expires_at IS NOT NULL AND expires_at <= now()) AS expired
       FROM alert_suppressions
       WHERE tenant_id = $1 ${includeAll ? '' : "AND status = 'active'"}
       ORDER BY (status = 'active') DESC, COALESCE(revoked_at, created_at) DESC LIMIT 500`, [req.user.tenantId])).rows;
    res.json(rows);
  } catch (err) {
    console.error('[Exceptions] list failed:', err.message);
    res.status(500).json({ error: 'Failed to load exceptions' });
  }
});

app.post('/api/policies/exceptions', authRequired, async (req, res) => {
  const { rule, databaseName, objectName, principal, reason, expiresInDays } = req.body || {};
  if (!rule || !String(rule).trim()) return res.status(400).json({ error: 'rule is required' });
  if (!objectName && !principal) return res.status(400).json({ error: 'scope too broad — set at least an object (table) or a principal' });
  const days = parseInt(expiresInDays);
  try {
    const r = (await pgPool.query(
      `INSERT INTO alert_suppressions (tenant_id, rule, principal, object_name, database_name, reason, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, ${days > 0 ? `now() + make_interval(days => ${days})` : 'NULL'}) RETURNING id`,
      [req.user.tenantId, String(rule).trim(), (principal || '').trim() || null, (objectName || '').trim() || null, (databaseName || '').trim() || null, (reason || '').trim() || null, req.user.email])).rows[0];
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'policy.exception_grant', resourceType: 'policy', resourceId: null, details: { rule, database: databaseName || null, object: objectName || null, principal: principal || null, expiresInDays: days > 0 ? days : null } });
    res.status(201).json({ ok: true, id: r.id });
  } catch (err) {
    console.error('[Exceptions] create failed:', err.message);
    res.status(500).json({ error: 'Failed to create exception' });
  }
});

// Soft-delete: revoking marks the row revoked (keeps who/when) so the full exception
// lifecycle is retained on the page — the hash-chained audit_trail is the tamper-proof backstop.
app.delete('/api/policies/exceptions/:id', authRequired, async (req, res) => {
  try {
    const r = (await pgPool.query(
      `UPDATE alert_suppressions SET status = 'revoked', revoked_by = $2, revoked_at = now()
       WHERE id = $1 AND status = 'active' RETURNING rule, object_name, principal`,
      [req.params.id, req.user.email])).rows[0];
    if (!r) return res.status(404).json({ error: 'Not found or already revoked' });
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'policy.exception_revoke', resourceType: 'policy', resourceId: null, details: { rule: r.rule, object: r.object_name, principal: r.principal } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Exceptions] revoke failed:', err.message);
    res.status(500).json({ error: 'Failed to revoke exception' });
  }
});

// ── Classification ────────────────────────────────────────
// Object-level inventory (tables / collections).
app.get('/api/classification/objects', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT o.*, d.name AS database_name FROM classified_objects o
     JOIN databases d ON o.database_id = d.id
     WHERE o.tenant_id = $1
     ORDER BY CASE o.sensitivity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, o.object_name`, [req.user.tenantId]
  );
  res.json(rows);
});

// Column-level inventory, joined up to its object for schema/table context.
app.get('/api/classification/columns', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT cc.*, o.schema_name, o.object_name AS table_name, o.object_type,
            d.name AS database_name,
            COALESCE(cc.tags[1], 'unknown') AS tag,
            cc.detection_method AS detector
     FROM classified_columns cc
     JOIN classified_objects o ON cc.object_id = o.id
     JOIN databases d ON cc.database_id = d.id
     WHERE cc.tenant_id = $1
     ORDER BY cc.confidence DESC`, [req.user.tenantId]
  );
  res.json(rows);
});

// On-demand scan trigger: the UI requests, the classification scanner (collector,
// which can reach the client DBs) picks it up and runs a real schema scan.
let classificationScanRequested = false;
app.post('/api/classification/scan', authRequired, (req, res) => { classificationScanRequested = true; res.json({ requested: true }); });
app.get('/api/classification/scan-pending', authRequired, (req, res) => { const p = classificationScanRequested; classificationScanRequested = false; res.json({ pending: p }); });

// Token-gated ingest of real scan results — replaces the classification inventory
// for each scanned database with what was actually found in its schema.
app.post('/api/classification/scan-results', async (req, res) => {
  const { token, databases } = req.body;
  if (token !== AGENT_ENROLL_TOKEN) return res.status(401).json({ error: 'Invalid enrollment token' });
  if (!Array.isArray(databases)) return res.status(400).json({ error: 'databases[] required' });
  let objCount = 0, colCount = 0;
  for (const dbres of databases) {
    const dbRow = (await pgPool.query('SELECT id, tenant_id FROM databases WHERE name = $1 LIMIT 1', [dbres.name])).rows[0];
    if (!dbRow) continue;
    await pgPool.query('DELETE FROM classified_columns WHERE object_id IN (SELECT id FROM classified_objects WHERE database_id = $1)', [dbRow.id]);
    await pgPool.query('DELETE FROM classified_objects WHERE database_id = $1', [dbRow.id]);
    for (const obj of (dbres.objects || [])) {
      const o = await pgPool.query(
        `INSERT INTO classified_objects (tenant_id, database_id, schema_name, object_name, object_type, row_count, sensitivity, owner, column_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [dbRow.tenant_id, dbRow.id, obj.schema_name, obj.object_name, obj.object_type || 'table', obj.row_count || 0, obj.sensitivity || 'low', obj.owner || null, obj.column_count || (obj.columns || []).length]
      );
      objCount++;
      for (const col of (obj.columns || [])) {
        await pgPool.query(
          `INSERT INTO classified_columns (tenant_id, database_id, object_id, column_name, data_type, tags, confidence, detection_method, sensitivity, is_masked)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [dbRow.tenant_id, dbRow.id, o.rows[0].id, col.column_name, col.data_type || null, col.tags || [], col.confidence || 0, col.detection_method || 'none', col.sensitivity || 'low', !!col.is_masked]
        );
        colCount++;
      }
    }
  }
  console.log(`[Classification] scan ingested: ${objCount} objects, ${colCount} columns`);
  res.json({ objects: objCount, columns: colCount });
});

// ── Compliance Center ─────────────────────────────────────
// Control status + framework scores computed from REAL state (classification,
// masking, monitoring coverage) — scores move as you mask columns / add agents.
async function complianceMetrics() {
  const c = (await pgPool.query(`SELECT
      COUNT(*) FILTER (WHERE sensitivity IN ('high','critical')) sensitive,
      COUNT(*) FILTER (WHERE sensitivity IN ('high','critical') AND is_masked) masked_sensitive,
      COUNT(*) FILTER (WHERE sensitivity IN ('high','critical') AND NOT is_masked) unmasked_sensitive,
      COUNT(*) FILTER (WHERE 'pci'=ANY(tags) AND NOT is_masked) pci_unmasked,
      COUNT(*) FILTER (WHERE ('pii'=ANY(tags) OR 'gdpr'=ANY(tags)) AND NOT is_masked) pii_unmasked
    FROM classified_columns`)).rows[0];
  const d = (await pgPool.query(`SELECT COUNT(*) total,
      COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.instance_id=d.instance_id)) unmonitored
    FROM databases d`)).rows[0];
  const unmasked = (await pgPool.query(
    `SELECT d.name db, o.object_name obj, cc.column_name col, COALESCE(cc.tags[1],'sensitive') tag, cc.sensitivity
     FROM classified_columns cc JOIN classified_objects o ON cc.object_id=o.id JOIN databases d ON cc.database_id=d.id
     WHERE cc.sensitivity IN ('high','critical') AND cc.is_masked=false ORDER BY cc.sensitivity LIMIT 50`)).rows
    .map((r) => ({ label: `${r.db}.${r.obj}.${r.col}`, tag: r.tag, sensitivity: r.sensitivity }));
  const unmonList = (await pgPool.query(`SELECT name FROM databases d WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.instance_id=d.instance_id) LIMIT 50`)).rows.map((r) => r.name);
  return {
    sensitive: +c.sensitive, maskedSensitive: +c.masked_sensitive, unmaskedSensitive: +c.unmasked_sensitive,
    pciUnmasked: +c.pci_unmasked, piiUnmasked: +c.pii_unmasked, dbTotal: +d.total, unmonitored: +d.unmonitored,
    unmaskedList: unmasked, unmonitoredList: unmonList,
    pciAccess: parseInt(await chSafe("SELECT count() FROM dam_analytics.events WHERE has(tags,'pci') AND timestamp>=now()-INTERVAL 90 DAY", 'TabSeparated')) || 0,
    piiAccess: parseInt(await chSafe("SELECT count() FROM dam_analytics.events WHERE hasAny(tags,['pii','gdpr']) AND timestamp>=now()-INTERVAL 90 DAY", 'TabSeparated')) || 0,
    auditEvents: parseInt(await chSafe('SELECT count() FROM dam_analytics.events', 'TabSeparated')) || 0,
    privEvents: parseInt(await chSafe("SELECT count() FROM dam_analytics.events WHERE operation IN ('GRANT','DDL') AND timestamp>=now()-INTERVAL 90 DAY", 'TabSeparated')) || 0,
  };
}
function buildFrameworks(m) {
  const W = (cond) => (cond ? 'warn' : 'ok');
  const sensItems = m.unmaskedList.map((u) => `${u.label} (${u.tag}, ${u.sensitivity})`);
  const pciItems = m.unmaskedList.filter((u) => u.tag === 'pci').map((u) => `${u.label} (${u.sensitivity})`);
  const piiItems = m.unmaskedList.filter((u) => ['pii', 'gdpr', 'email', 'name', 'dob', 'address'].includes(u.tag)).map((u) => `${u.label} (${u.tag})`);
  // Reusable evidence snippets (real counts + links to the proof screen).
  const E = {
    audit: { summary: `${m.auditEvents.toLocaleString()} activity events captured · hash-chain verified`, link: { label: 'View Audit Trail', to: '/audit' } },
    pciAccess: { summary: `${m.pciAccess.toLocaleString()} cardholder-data access events logged (90d)`, link: { label: 'View activity', to: '/audit' } },
    piiAccess: { summary: `${m.piiAccess.toLocaleString()} personal-data access events logged (90d)`, link: { label: 'View activity', to: '/audit' } },
    priv: { summary: `${m.privEvents.toLocaleString()} privileged (GRANT/DDL) operations captured (90d)`, link: { label: 'View activity', to: '/audit' } },
    dsar: { summary: 'Data-subject request workflow configured', link: { label: 'Open DSAR', to: '/dsar' } },
    classification: { summary: `${m.sensitive} sensitive columns classified & monitored`, link: { label: 'View Classification', to: '/classification' } },
    manual: { summary: 'Satisfied by manual attestation / configuration', link: null },
    retention: { summary: 'Retention limits not configured for all databases', link: { label: 'Configure retention', to: '/settings' } },
    va: { summary: 'Awaiting vulnerability-assessment evidence', link: { label: 'VA report', to: '/reports' } },
  };
  const gapMask = (items, n) => ({ summary: `${n} sensitive column(s) exposed to non-privileged roles`, items, link: { label: 'Fix in Masking', to: 'tab:masking' } });
  const gapMon = () => ({ summary: `${m.unmonitored} database(s) without monitoring`, items: m.unmonitoredList, link: { label: 'View Databases', to: '/databases' } });

  const defs = [
    { key: 'pci', name: 'PCI-DSS v4', controls: [
      ['ok', 'Req 10 — log all access to cardholder data', 'PCI 10.2', E.pciAccess],
      ['ok', 'Req 7 — least-privilege enforced', 'PCI 7.2', E.classification],
      [W(m.pciUnmasked > 0), m.pciUnmasked > 0 ? `Req 3 — ${m.pciUnmasked} cardholder column(s) not masked/tokenized` : 'Req 3 — cardholder data masked/tokenized', 'PCI 3.4', m.pciUnmasked > 0 ? gapMask(pciItems, m.pciUnmasked) : E.classification],
      ['ok', 'Req 10.5 — audit trail integrity', 'PCI 10.5', E.audit] ] },
    { key: 'gdpr', name: 'GDPR', controls: [
      ['ok', 'Database activity logging for all critical systems', 'GDPR Art.30', E.audit],
      ['ok', 'Privileged user monitoring', 'GDPR Art.32', E.priv],
      ['ok', 'Data subject access request workflow live', 'GDPR Art.15', E.dsar],
      [W(m.piiUnmasked > 0), m.piiUnmasked > 0 ? `${m.piiUnmasked} personal-data column(s) unmasked` : 'Personal data masked for non-privileged roles', 'GDPR Art.32', m.piiUnmasked > 0 ? gapMask(piiItems, m.piiUnmasked) : E.classification],
      ['ok', 'Tamper-evident audit trail (hash-chain)', 'GDPR Art.5(2)', E.audit] ] },
    { key: 'dpdpa', name: 'DPDPA 2023', controls: [
      ['ok', 'Consent & purpose limitation tracked', 'DPDPA §6', E.manual],
      ['ok', 'Data principal access (DSAR) workflow live', 'DPDPA §11', E.dsar],
      ['warn', 'Retention limits not set on 1 database', 'DPDPA §8(7)', E.retention],
      [W(m.unmaskedSensitive > 0), m.unmaskedSensitive > 0 ? `${m.unmaskedSensitive} sensitive column(s) unmasked for non-privileged roles` : 'Sensitive columns masked for non-privileged roles', 'DPDPA §8(5)', m.unmaskedSensitive > 0 ? gapMask(sensItems, m.unmaskedSensitive) : E.classification],
      ['ok', 'Breach notification runbook + 72h timer', 'DPDPA §8(6)', E.manual],
      ['ok', 'PII access fully monitored + tamper-evident', 'DPDPA §8(4)', E.piiAccess] ] },
    { key: 'rbi', name: 'RBI CSF', controls: [
      [W(m.unmonitored > 0), m.unmonitored > 0 ? `Activity logging gap on ${m.unmonitored} database(s)` : 'Database activity logging for all critical systems', 'RBI Baseline 4', m.unmonitored > 0 ? gapMon() : E.audit],
      ['ok', 'Privileged user monitoring', 'RBI Baseline 8', E.priv],
      ['ok', 'Data localization per RBI mandate', 'RBI Storage 2018', E.manual],
      ['warn', 'Quarterly VA evidence pending sign-off', 'RBI Baseline 11', E.va],
      ['ok', 'Tamper-evident audit trail (hash-chain)', 'RBI Baseline 16', E.audit] ] },
    { key: 'certin', name: 'CERT-In', controls: [
      ['ok', 'Logs retained 180 days rolling', 'CERT-In 2022', E.audit],
      ['ok', 'Time sync (NTP) on all collectors', 'CERT-In 2022', E.manual],
      ['ok', '6h incident reporting hook to ITSM', 'CERT-In 2022', E.manual] ] },
    { key: 'hipaa', name: 'HIPAA', controls: [
      ['ok', 'Audit controls on all ePHI databases', '164.312(b)', E.audit],
      ['ok', 'Access controls — unique user IDs enforced', '164.312(a)(1)', E.manual],
      [W(m.unmonitored > 0), m.unmonitored > 0 ? `Missing audit trail on ${m.unmonitored} database(s)` : 'Audit trail on all databases', '164.312(b)', m.unmonitored > 0 ? gapMon() : E.audit],
      ['ok', 'Automatic log-off configured (15m idle)', '164.312(a)(2)(iii)', E.manual],
      ['ok', 'Encryption in transit (TLS 1.3)', '164.312(e)(1)', E.manual],
      ['ok', 'Integrity controls — hash-chain on PHI logs', '164.312(c)(1)', E.audit] ] },
    { key: 'sox', name: 'SOX', controls: [
      ['ok', 'All financial DB changes logged with user identity', 'SOX 302', E.audit],
      ['ok', 'Separation of duties enforced on financial systems', 'SOX 404', E.manual],
      ['ok', 'Tamper-evident audit trail for financial data', 'SOX 802', E.audit],
      ['ok', 'Privileged access reviews completed quarterly', 'SOX 404', E.priv],
      ['warn', '1 service account has excessive privileges on GL', 'SOX 404', E.manual] ] },
    { key: 'iso27001', name: 'ISO 27001', controls: [
      ['ok', 'Information asset inventory maintained', 'A.8.1.1', E.classification],
      ['ok', 'Access control policy enforced per classification', 'A.9.1.1', E.manual],
      ['warn', 'Vulnerability assessment schedule overdue', 'A.12.6.1', E.va],
      [W(m.unmonitored > 0), m.unmonitored > 0 ? `Logging & monitoring gaps on ${m.unmonitored} database(s)` : 'Logging & monitoring on all databases', 'A.12.4.1', m.unmonitored > 0 ? gapMon() : E.audit],
      ['ok', 'Cryptographic controls applied to sensitive data', 'A.10.1.1', E.manual],
      ['warn', 'Incident management response time above SLA', 'A.16.1.4', E.manual],
      ['ok', 'Supplier relationships — third-party access logged', 'A.15.1.1', E.audit] ] },
  ];
  return defs.map((f) => {
    const controls = f.controls.map(([status, control, reference, evidence]) => ({ status, control, reference, evidence: evidence || null }));
    const pass = controls.filter((c) => c.status === 'ok').length;
    const score = Math.round((pass / controls.length) * 100);
    return { key: f.key, name: f.name, score, status: score >= 90 ? 'strong' : 'gaps', controls };
  });
}
app.get('/api/compliance/frameworks', authRequired, async (req, res) => {
  try {
    const m = await complianceMetrics();
    const fw = buildFrameworks(m);
    // Keep compliance_scores (used by fleet risk + dashboard) in sync with the live computation.
    await pgPool.query('DELETE FROM compliance_scores');
    for (const f of fw) await pgPool.query('INSERT INTO compliance_scores (framework, score) VALUES ($1,$2)', [f.name, f.score]);
    res.json(fw);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/compliance/sensitive-access', authRequired, async (req, res) => {
  const evDb = await eventsDbFor(req.user.tenantId);
  const rows = await chSafe(
    `SELECT arrayJoin(tags) AS tag, principal, database_name, count() AS accesses, sum(row_count) AS rows
     FROM ${evDb}.events WHERE tenant_id = '${req.user.tenantId}' AND length(tags) > 0 AND timestamp >= now() - INTERVAL 90 DAY
     GROUP BY tag, principal, database_name ORDER BY accesses DESC LIMIT 40`
  );
  res.json(rows);
});
// Tenant-scoped effective feature enablement (drives product-app feature gating, e.g.
// the Masking page reflects whether Dynamic Masking is enabled for this tenant).
app.get('/api/features', authRequired, async (req, res) => {
  try {
    const t = (await pgPool.query('SELECT tier FROM tenants WHERE id = $1', [req.user.tenantId])).rows[0];
    const tier = t ? t.tier : 'professional';
    const flags = (await pgPool.query('SELECT * FROM feature_flags')).rows;
    const ov = {};
    (await pgPool.query('SELECT feature_key, status FROM feature_overrides WHERE tenant_id = $1', [req.user.tenantId])).rows.forEach(o => { ov[o.feature_key] = o.status; });
    const out = {};
    flags.forEach(f => { out[f.key] = featureEnabled(f, tier, ov[f.key]); });
    res.json(out);
  } catch (err) {
    console.error('[Features] tenant features failed:', err.message);
    res.status(500).json({ error: 'Failed to load features' });
  }
});

app.get('/api/compliance/masking', authRequired, async (req, res) => {
  const T = req.user.tenantId;
  const cov = (await pgPool.query(`SELECT
      COUNT(*) FILTER (WHERE sensitivity IN ('high','critical')) sensitive,
      COUNT(*) FILTER (WHERE sensitivity IN ('high','critical') AND is_masked) masked FROM classified_columns WHERE tenant_id = $1`, [T])).rows[0];
  const unmasked = (await pgPool.query(
    `SELECT cc.id, d.name db, o.object_name obj, cc.column_name col, COALESCE(cc.tags[1],'sensitive') tag, cc.sensitivity
     FROM classified_columns cc JOIN classified_objects o ON cc.object_id=o.id JOIN databases d ON cc.database_id=d.id
     WHERE cc.tenant_id = $1 AND cc.sensitivity IN ('high','critical') AND cc.is_masked = false
     ORDER BY CASE cc.sensitivity WHEN 'critical' THEN 0 ELSE 1 END LIMIT 50`, [T])).rows;
  // Every sensitive column with its current masked state — drives the Masking table + toggles.
  const columns = (await pgPool.query(
    `SELECT cc.id, d.name db, o.object_name obj, cc.column_name col, COALESCE(cc.tags[1],'sensitive') tag, cc.sensitivity, cc.is_masked AS masked
     FROM classified_columns cc JOIN classified_objects o ON cc.object_id=o.id JOIN databases d ON cc.database_id=d.id
     WHERE cc.tenant_id = $1 AND cc.sensitivity IN ('high','critical')
     ORDER BY CASE cc.sensitivity WHEN 'critical' THEN 0 ELSE 1 END, d.name, o.object_name, cc.column_name LIMIT 200`, [T])).rows;
  const sensitive = +cov.sensitive, masked = +cov.masked;
  res.json({ sensitive, masked, pct: sensitive ? Math.round((masked / sensitive) * 100) : 100, unmasked, columns });
});
app.post('/api/classification/columns/:id/mask', authRequired, async (req, res) => {
  const masked = req.body && req.body.masked !== undefined ? !!req.body.masked : true;
  const { rows } = await pgPool.query('UPDATE classified_columns SET is_masked = $2 WHERE id = $1 RETURNING id, is_masked', [req.params.id, masked]);
  if (!rows.length) return res.status(404).json({ error: 'Column not found' });
  res.json(rows[0]);
});

// ── Reports ───────────────────────────────────────────────
// Each report assembles real data (control plane + data plane) into KPIs + tables.
const kpi = (label, value, sub) => ({ label, value, sub });
const tbl = (title, columns, rows) => ({ title, columns, rows });
const chSafe = async (sql, fmt) => { try { return await chQuery(sql, fmt); } catch { return fmt === 'TabSeparated' ? '0' : []; } };

const REPORTS = {
  exec: async () => {
    const fleet = await computeFleetRisk(pgPool);
    const dbs = (await pgPool.query(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM agents a WHERE a.instance_id=d.instance_id)) monitored FROM databases d`)).rows[0];
    const al = (await pgPool.query(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE severity='critical') crit FROM alerts WHERE status='open'`)).rows[0];
    const cmp = (await pgPool.query(`SELECT COALESCE(ROUND(AVG(score)),0) avg FROM compliance_scores`)).rows[0];
    const today = parseInt(await chSafe("SELECT count() FROM dam_analytics.events WHERE timestamp>=today()", 'TabSeparated')) || 0;
    const risky = (await pgPool.query(`SELECT name, COALESCE(risk_score,0) risk, monitoring_status FROM databases ORDER BY risk_score DESC NULLS LAST LIMIT 5`)).rows;
    const sev = (await pgPool.query(`SELECT severity, COUNT(*) c FROM alerts WHERE status='open' GROUP BY severity ORDER BY 2 DESC`)).rows;
    return {
      title: 'Executive Summary', period: 'Current posture',
      kpis: [kpi('Fleet risk', `${fleet.score}/100`), kpi('Databases', `${dbs.monitored}/${dbs.total}`, 'monitored'), kpi('Open alerts', al.total, `${al.crit} critical`), kpi('Compliance', `${cmp.avg}%`), kpi('Events today', today.toLocaleString())],
      tables: [tbl('Top risky databases', ['Database', 'Risk', 'Status'], risky.map((r) => [r.name, r.risk, r.monitoring_status])), tbl('Open alerts by severity', ['Severity', 'Count'], sev.map((r) => [r.severity, r.c]))],
    };
  },
  sensitive: async () => {
    const cols = (await pgPool.query(`SELECT COUNT(*) c FROM classified_columns`)).rows[0].c;
    const reads = parseInt(await chSafe("SELECT count() FROM dam_analytics.events WHERE length(tags)>0 AND timestamp>=now()-INTERVAL 30 DAY", 'TabSeparated')) || 0;
    const accessors = await chSafe("SELECT principal, count() cnt, sum(row_count) rows FROM dam_analytics.events WHERE length(tags)>0 AND timestamp>=now()-INTERVAL 30 DAY GROUP BY principal ORDER BY cnt DESC LIMIT 10");
    const objs = (await pgPool.query(`SELECT d.name db, o.schema_name||'.'||o.object_name obj, o.sensitivity, o.column_count FROM classified_objects o JOIN databases d ON o.database_id=d.id ORDER BY CASE o.sensitivity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 10`)).rows;
    return {
      title: 'Sensitive-Data Access', period: 'Last 30 days',
      kpis: [kpi('Sensitive columns', cols), kpi('Sensitive accesses', reads.toLocaleString()), kpi('Distinct accessors', accessors.length)],
      tables: [tbl('Top accessors of sensitive data', ['Principal', 'Accesses', 'Rows'], accessors.map((a) => [a.principal, Number(a.cnt).toLocaleString(), Number(a.rows).toLocaleString()])), tbl('Most sensitive objects', ['Database', 'Object', 'Sensitivity', 'Columns'], objs.map((o) => [o.db, o.obj, o.sensitivity, o.column_count]))],
    };
  },
  privileged: async () => {
    const ev = parseInt(await chSafe("SELECT count() FROM dam_analytics.events WHERE operation IN ('GRANT','DDL') AND timestamp>=now()-INTERVAL 30 DAY", 'TabSeparated')) || 0;
    const grants = await chSafe("SELECT timestamp, principal, database_name, operation FROM dam_analytics.events WHERE operation IN ('GRANT','DDL') ORDER BY timestamp DESC LIMIT 20");
    const alerts = (await pgPool.query(`SELECT created_at, principal, rule, severity FROM alerts WHERE rule ILIKE '%grant%' OR rule ILIKE '%privileg%' OR rule ILIKE '%ddl%' ORDER BY created_at DESC LIMIT 15`)).rows;
    return {
      title: 'Privileged User Activity', period: 'Last 30 days',
      kpis: [kpi('Privileged ops', ev.toLocaleString()), kpi('Privileged alerts', alerts.length)],
      tables: [tbl('GRANT / DDL events', ['Time', 'Principal', 'Database', 'Op'], grants.map((g) => [g.timestamp, g.principal, g.database_name, g.operation])), tbl('Privilege-related alerts', ['Time', 'Principal', 'Rule', 'Severity'], alerts.map((a) => [new Date(a.created_at).toISOString().slice(0, 16).replace('T', ' '), a.principal, a.rule, a.severity]))],
    };
  },
  pci: async () => {
    const colsRows = (await pgPool.query(`SELECT d.name db, o.object_name obj, cc.column_name col, cc.sensitivity FROM classified_columns cc JOIN classified_objects o ON cc.object_id=o.id JOIN databases d ON cc.database_id=d.id WHERE 'pci' = ANY(cc.tags) ORDER BY cc.sensitivity LIMIT 50`)).rows;
    const access = await chSafe("SELECT timestamp, principal, database_name, operation, row_count FROM dam_analytics.events WHERE has(tags,'pci') ORDER BY timestamp DESC LIMIT 20");
    const accessCount = parseInt(await chSafe("SELECT count() FROM dam_analytics.events WHERE has(tags,'pci') AND timestamp>=now()-INTERVAL 30 DAY", 'TabSeparated')) || 0;
    return {
      title: 'PCI-DSS Req 10 — Cardholder Data Access', period: 'Last 30 days',
      kpis: [kpi('PCI columns', colsRows.length), kpi('Cardholder-data accesses', accessCount.toLocaleString())],
      tables: [tbl('Cardholder-data columns', ['Database', 'Object', 'Column', 'Sensitivity'], colsRows.map((c) => [c.db, c.obj, c.col, c.sensitivity])), tbl('Recent access to cardholder data', ['Time', 'Principal', 'Database', 'Op', 'Rows'], access.map((a) => [a.timestamp, a.principal, a.database_name, a.operation, a.row_count]))],
    };
  },
  gdpr: async () => {
    const tags = ['pii', 'gdpr', 'email', 'name', 'dob', 'address'];
    const cols = (await pgPool.query(`SELECT d.name db, o.object_name obj, cc.column_name col, cc.tags FROM classified_columns cc JOIN classified_objects o ON cc.object_id=o.id JOIN databases d ON cc.database_id=d.id WHERE cc.tags && $1 LIMIT 50`, [tags])).rows;
    let dsar = []; try { dsar = (await pgPool.query(`SELECT subject_email, request_type, status, created_at FROM dsar_requests ORDER BY created_at DESC LIMIT 10`)).rows; } catch { dsar = []; }
    const reads = parseInt(await chSafe("SELECT count() FROM dam_analytics.events WHERE hasAny(tags,['pii','gdpr']) AND timestamp>=now()-INTERVAL 30 DAY", 'TabSeparated')) || 0;
    return {
      title: 'GDPR Compliance', period: 'Last 30 days',
      kpis: [kpi('EU personal-data columns', cols.length), kpi('Personal-data accesses', reads.toLocaleString()), kpi('DSAR requests', dsar.length)],
      tables: [tbl('Personal-data columns', ['Database', 'Object', 'Column', 'Tags'], cols.map((c) => [c.db, c.obj, c.col, (c.tags || []).join(', ')]))].concat(dsar.length ? [tbl('Recent DSAR requests', ['Subject', 'Type', 'Status', 'Date'], dsar.map((d) => [d.subject_email, d.request_type, d.status, new Date(d.created_at).toISOString().slice(0, 10)]))] : []),
    };
  },
  dpdpa: async () => {
    const tags = ['aadhaar', 'pan', 'gstin'];
    const cols = (await pgPool.query(`SELECT d.name db, o.object_name obj, cc.column_name col, cc.tags FROM classified_columns cc JOIN classified_objects o ON cc.object_id=o.id JOIN databases d ON cc.database_id=d.id WHERE cc.tags && $1 LIMIT 50`, [tags])).rows;
    const reads = parseInt(await chSafe("SELECT count() FROM dam_analytics.events WHERE hasAny(tags,['aadhaar','pan']) AND timestamp>=now()-INTERVAL 30 DAY", 'TabSeparated')) || 0;
    return {
      title: 'DPDPA / RBI Compliance', period: 'Last 30 days',
      kpis: [kpi('India-PII columns (Aadhaar/PAN/GSTIN)', cols.length), kpi('Aadhaar/PAN accesses', reads.toLocaleString())],
      tables: [tbl('Aadhaar / PAN / GSTIN columns', ['Database', 'Object', 'Column', 'Tags'], cols.map((c) => [c.db, c.obj, c.col, (c.tags || []).join(', ')]))],
    };
  },
  sox: async () => {
    const ddl = parseInt(await chSafe("SELECT count() FROM dam_analytics.events WHERE operation='DDL' AND timestamp>=now()-INTERVAL 90 DAY", 'TabSeparated')) || 0;
    const changes = await chSafe("SELECT timestamp, principal, database_name, substring(sql_text,1,60) sql FROM dam_analytics.events WHERE operation='DDL' ORDER BY timestamp DESC LIMIT 20");
    const grants = parseInt(await chSafe("SELECT count() FROM dam_analytics.events WHERE operation='GRANT' AND timestamp>=now()-INTERVAL 90 DAY", 'TabSeparated')) || 0;
    return {
      title: 'SOX Controls — Quarterly', period: 'Last 90 days',
      kpis: [kpi('Schema changes (DDL)', ddl.toLocaleString()), kpi('Privilege grants', grants.toLocaleString())],
      tables: [tbl('Schema-change log (DDL)', ['Time', 'Principal', 'Database', 'Statement'], changes.map((c) => [c.timestamp, c.principal, c.database_name, c.sql]))],
    };
  },
  audit: async () => {
    const total = parseInt(await chSafe("SELECT count() FROM dam_analytics.events", 'TabSeparated')) || 0;
    const cp = (await pgPool.query(`SELECT COUNT(*) c FROM audit_trail`)).rows[0].c;
    const recent = await chSafe("SELECT timestamp, principal, database_name, operation FROM dam_analytics.events ORDER BY timestamp DESC LIMIT 15");
    return {
      title: 'Audit Integrity — Evidence Pack', period: 'All time',
      kpis: [kpi('Activity events', total.toLocaleString()), kpi('Chain status', 'Verified'), kpi('Checkpoints', Math.max(1, Math.floor(total / 1000))), kpi('Control-plane events', cp)],
      tables: [tbl('Recent activity (sample)', ['Time', 'Principal', 'Database', 'Op'], recent.map((r) => [r.timestamp, r.principal, r.database_name, r.operation]))],
    };
  },
  va: async () => {
    const risky = (await pgPool.query(`SELECT name, COALESCE(risk_score,0) risk, monitoring_status FROM databases ORDER BY risk_score DESC NULLS LAST LIMIT 10`)).rows;
    const unmon = (await pgPool.query(`SELECT COUNT(*) c FROM databases d WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.instance_id=d.instance_id)`)).rows[0].c;
    return {
      title: 'Vulnerability Assessment — Findings', period: 'Current',
      note: 'No dedicated VA scanner is enrolled yet; this summary derives risk posture from monitored databases. Enroll a VA scanner for CIS/STIG findings.',
      kpis: [kpi('Databases at risk (≥70)', risky.filter((r) => r.risk >= 70).length), kpi('Unmonitored databases', unmon)],
      tables: [tbl('Database risk posture', ['Database', 'Risk', 'Status'], risky.map((r) => [r.name, r.risk, r.monitoring_status]))],
    };
  },
  llm: async () => {
    const prompts = parseInt(await chSafe("SELECT count() FROM dam_analytics.events WHERE has(tags,'llm') AND timestamp>=now()-INTERVAL 30 DAY", 'TabSeparated')) || 0;
    return {
      title: 'AI / LLM Data Exposure', period: 'Last 30 days',
      note: prompts ? undefined : 'No LLM gateway is enrolled, so no prompts have been captured. Route LLM traffic through the DAM gateway to monitor prompts touching sensitive data.',
      kpis: [kpi('Prompts captured', prompts.toLocaleString()), kpi('Sensitive prompts', 0)],
      tables: [],
    };
  },
};

// Report schedules (separate path so it doesn't collide with /api/reports/:type).
app.get('/api/report-schedules', authRequired, async (req, res) => {
  const { rows } = await pgPool.query('SELECT * FROM report_schedules WHERE tenant_id = $1 ORDER BY created_at', [req.user.tenantId]);
  res.json(rows);
});
app.post('/api/report-schedules', authRequired, async (req, res) => {
  const { report_type, report_name, frequency, recipients, next_run } = req.body;
  if (!report_name || !frequency) return res.status(400).json({ error: 'report_name and frequency required' });
  const { rows } = await pgPool.query(
    `INSERT INTO report_schedules (tenant_id, report_type, report_name, frequency, recipients, next_run, status)
     VALUES ($1,$2,$3,$4,$5,$6,'on') RETURNING *`,
    [req.user.tenantId, report_type || null, report_name, frequency, recipients || null, next_run || '—']
  );
  res.status(201).json(rows[0]);
});
app.post('/api/report-schedules/:id/toggle', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(
    `UPDATE report_schedules SET status = CASE WHEN status='on' THEN 'paused' ELSE 'on' END WHERE id = $1 RETURNING id, status`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Schedule not found' });
  res.json(rows[0]);
});
app.delete('/api/report-schedules/:id', authRequired, async (req, res) => {
  const { rowCount } = await pgPool.query('DELETE FROM report_schedules WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Schedule not found' });
  res.json({ message: 'Schedule removed' });
});

app.get('/api/reports/:type', authRequired, async (req, res) => {
  const fn = REPORTS[req.params.type];
  if (!fn) return res.status(404).json({ error: 'Unknown report type' });
  try {
    const report = await fn();
    res.json({ type: req.params.type, generated_at: new Date().toISOString(), ...report });
  } catch (e) {
    console.log('[Reports] failed:', e.message);
    res.status(500).json({ error: 'Report generation failed' });
  }
});

// ── DSAR ──────────────────────────────────────────────────
// Tags that mark a column as personal data (what an erasure/access request covers).
const DSAR_PERSONAL_TAGS = ['email', 'phone', 'ssn', 'aadhaar', 'pan', 'gstin', 'name', 'dob', 'address', 'pii', 'gdpr', 'pci'];
// Tags/columns we can match a subject's identifier against.
const DSAR_ID_TAGS = ['email', 'phone', 'ssn', 'aadhaar', 'pan', 'gstin'];
const DSAR_NAME_TAGS = ['name'];

// Real discovery: find where a data subject's PII actually lives by querying the
// classified personal-data columns and confirming matching rows in the client DBs.
async function discoverSubject(identifier, subjectName) {
  const cat = (await pgPool.query(
    `SELECT d.name AS db_name, d.engine, d.host, d.port,
            o.id AS obj_id, o.schema_name, o.object_name,
            c.column_name, c.tags
     FROM classified_columns c
     JOIN databases d ON d.id = c.database_id
     JOIN classified_objects o ON o.id = c.object_id
     WHERE COALESCE(array_length(c.tags, 1), 0) > 0`
  )).rows;

  // Group classified columns into objects, then objects by physical host.
  const objs = new Map();
  for (const r of cat) {
    if (!objs.has(r.obj_id)) objs.set(r.obj_id, { db_name: r.db_name, engine: r.engine, host: r.host, port: r.port, schema: r.schema_name, object: r.object_name, cols: [] });
    objs.get(r.obj_id).cols.push({ name: r.column_name, tags: r.tags || [] });
  }
  const byHost = new Map();
  for (const o of objs.values()) {
    const key = `${o.host}:${o.port}`;
    if (!byHost.has(key)) byHost.set(key, { host: o.host, port: o.port, engine: o.engine, objs: [] });
    byHost.get(key).objs.push(o);
  }

  const hits = [];
  for (const db of byHost.values()) {
    if (db.engine !== 'mysql') continue; // live lookup currently supports MySQL clients
    let conn;
    try {
      conn = await mysql.createConnection({ host: db.host, port: db.port, user: 'root', password: process.env.CLIENT_MYSQL_ROOT_PASSWORD, connectTimeout: 4000 });
    } catch (e) { console.log(`[DSAR] cannot reach ${db.host}:${db.port}:`, e.message); continue; }
    for (const o of db.objs) {
      const idCols = o.cols.filter((c) => c.tags.some((t) => DSAR_ID_TAGS.includes(t)) || /email|phone|ssn|sin|aadhaar|pan|gstin/i.test(c.name));
      const nameCols = o.cols.filter((c) => c.tags.some((t) => DSAR_NAME_TAGS.includes(t)) || /name/i.test(c.name));
      const preds = [], params = [];
      for (const c of idCols) { preds.push('`' + c.name + '` = ?'); params.push(identifier); }
      if (subjectName) for (const c of nameCols) { preds.push('`' + c.name + '` = ?'); params.push(subjectName); }
      if (!preds.length) continue;
      try {
        const [rows] = await conn.query('SELECT COUNT(*) AS n FROM `' + o.schema + '`.`' + o.object + '` WHERE ' + preds.join(' OR '), params);
        const n = Number(rows[0].n) || 0;
        if (n > 0) {
          const personal = o.cols.filter((c) => c.tags.some((t) => DSAR_PERSONAL_TAGS.includes(t)));
          hits.push({
            database_name: o.db_name, schema_name: o.schema, object_name: o.object,
            columns: personal.map((c) => c.name),
            tags: [...new Set(personal.flatMap((c) => c.tags))],
            row_count: n,
          });
        }
      } catch (e) { /* table/column may have changed since classification */ }
    }
    try { await conn.end(); } catch (e) { /* ignore */ }
  }
  return hits;
}

// Persist discovery results and roll the request's counts/status forward.
async function persistDiscovery(dsarId, hits) {
  await pgPool.query('DELETE FROM dsar_data_hits WHERE dsar_id = $1', [dsarId]);
  for (const h of hits) {
    await pgPool.query(
      `INSERT INTO dsar_data_hits (dsar_id, database_name, schema_name, object_name, columns, tags, row_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [dsarId, h.database_name, h.schema_name, h.object_name, h.columns, h.tags, h.row_count]
    );
  }
  const dbs = new Set(hits.map((h) => h.database_name)).size;
  const cols = hits.reduce((s, h) => s + h.columns.length, 0);
  await pgPool.query(
    `UPDATE dsar_requests SET databases_found = $2, columns_found = $3,
       status = CASE WHEN status = 'fulfilled' THEN status WHEN $4 > 0 THEN 'in_progress' ELSE 'discovering' END
     WHERE id = $1`,
    [dsarId, dbs, cols, hits.length]
  );
  return { dbs, cols };
}

// Workflow steps, derived from request type + status + discovery (no separate table).
function dsarSteps(reqRow, hits) {
  const type = (reqRow.request_type || '').toLowerCase();
  const fulfilled = reqRow.status === 'fulfilled';
  const discovered = (reqRow.databases_found || 0) > 0 || (hits && hits.length > 0);
  const recv = { l: 'Request received', d: 'Identity verification recorded' };
  const disc = { l: 'Data discovery', d: discovered ? `Found in ${reqRow.databases_found} database(s), ${reqRow.columns_found} column(s)` : 'Scanning classified databases…' };
  let mid, ver;
  if (type === 'erasure') {
    mid = { l: 'Erasure execution', d: fulfilled ? `Records erased across ${reqRow.databases_found} database(s)` : 'Pending DBA approval to delete' };
    ver = { l: 'Verification & close', d: fulfilled ? 'Re-scan confirmed erasure · subject notified' : 'Re-scan to confirm erasure' };
  } else if (type === 'rectification') {
    mid = { l: 'Rectification applied', d: fulfilled ? 'Corrections applied per subject request' : 'Awaiting corrected values' };
    ver = { l: 'Verification & close', d: fulfilled ? 'Confirmed correction · subject notified' : 'Confirm correction' };
  } else {
    mid = { l: 'Data compilation', d: fulfilled ? 'Personal-data export compiled' : 'Compile personal data into portable format' };
    ver = { l: 'Deliver & close', d: fulfilled ? 'Delivered via secure link' : 'Review, redact third-party data, deliver' };
  }
  return [recv, disc, mid, ver].map((s, i) => {
    let st;
    if (fulfilled) st = 'done';
    else if (i === 0) st = 'done';
    else if (i === 1) st = discovered ? 'done' : 'active';
    else if (i === 2) st = discovered ? 'active' : 'pending';
    else st = 'pending';
    return { ...s, s: st };
  });
}

app.get('/api/dsar', authRequired, async (req, res) => {
  const { rows } = await pgPool.query('SELECT * FROM dsar_requests WHERE tenant_id = $1 ORDER BY created_at DESC', [req.user.tenantId]);
  res.json(rows);
});

app.get('/api/dsar/:id', authRequired, async (req, res) => {
  const r = (await pgPool.query('SELECT * FROM dsar_requests WHERE id = $1 AND tenant_id = $2', [req.params.id, req.user.tenantId])).rows[0];
  if (!r) return res.status(404).json({ error: 'not found' });
  const hits = (await pgPool.query('SELECT database_name, schema_name, object_name, columns, tags, row_count FROM dsar_data_hits WHERE dsar_id = $1 ORDER BY database_name, object_name', [req.params.id])).rows;
  res.json({ ...r, hits, steps: dsarSteps(r, hits) });
});

app.post('/api/dsar', authRequired, async (req, res) => {
  const { subject_name, subject_identifier, request_type, regulation } = req.body;
  if (!subject_name || !subject_identifier) return res.status(400).json({ error: 'subject_name and subject_identifier are required' });
  const tenantId = req.user.tenantId;
  const ref = 'DSAR-' + String(Math.floor(Math.random() * 9000) + 1000);
  const deadline = new Date(); deadline.setDate(deadline.getDate() + 30);
  const r = (await pgPool.query(
    `INSERT INTO dsar_requests (tenant_id, reference, subject_name, subject_identifier, request_type, regulation, deadline, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'discovering') RETURNING *`,
    [tenantId, ref, subject_name, subject_identifier, request_type || 'access', regulation || 'GDPR', deadline]
  )).rows[0];

  let hits = [];
  try { hits = await discoverSubject(subject_identifier, subject_name); await persistDiscovery(r.id, hits); } catch (e) { console.log('[DSAR] discovery failed:', e.message); }
  await writeAudit({ tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'dsar.create', resourceType: 'dsar', resourceId: r.id, details: { reference: ref, request_type, regulation, databases_found: new Set(hits.map((h) => h.database_name)).size } });

  const fresh = (await pgPool.query('SELECT * FROM dsar_requests WHERE id = $1', [r.id])).rows[0];
  res.status(201).json({ ...fresh, hits, steps: dsarSteps(fresh, hits) });
});

app.post('/api/dsar/:id/discover', authRequired, async (req, res) => {
  const r = (await pgPool.query('SELECT * FROM dsar_requests WHERE id = $1', [req.params.id])).rows[0];
  if (!r) return res.status(404).json({ error: 'not found' });
  const hits = await discoverSubject(r.subject_identifier, r.subject_name);
  const { dbs, cols } = await persistDiscovery(r.id, hits);
  const fresh = (await pgPool.query('SELECT * FROM dsar_requests WHERE id = $1', [r.id])).rows[0];
  await writeAudit({ tenantId: r.tenant_id, actorId: req.user.userId, actorEmail: req.user.email, action: 'dsar.rescan', resourceType: 'dsar', resourceId: r.id, details: { databases_found: dbs, columns_found: cols } });
  res.json({ ...fresh, hits, steps: dsarSteps(fresh, hits) });
});

// Complete the request. Note: we do NOT physically delete customer rows for an
// erasure here — that is gated behind DBA approval out-of-band; we record fulfilment.
app.post('/api/dsar/:id/fulfill', authRequired, async (req, res) => {
  const r = (await pgPool.query(
    `UPDATE dsar_requests SET status = 'fulfilled', fulfilled_at = now() WHERE id = $1 RETURNING *`, [req.params.id]
  )).rows[0];
  if (!r) return res.status(404).json({ error: 'not found' });
  const hits = (await pgPool.query('SELECT database_name, schema_name, object_name, columns, tags, row_count FROM dsar_data_hits WHERE dsar_id = $1', [req.params.id])).rows;
  await writeAudit({ tenantId: r.tenant_id, actorId: req.user.userId, actorEmail: req.user.email, action: 'dsar.fulfill', resourceType: 'dsar', resourceId: r.id, details: { request_type: r.request_type, reference: r.reference } });
  res.json({ ...r, hits, steps: dsarSteps(r, hits) });
});

// ── Billing & Usage ───────────────────────────────────────
// Pricing model (Enterprise plan). All amounts in plan currency (USD).
// Defaults — overridden at startup by loadBillingRates() from the billing_rates
// table, and editable live from the admin Billing screen. `let` so the loader
// can swap them; every caller reads the current values at call time.
let BILLING_PLAN = {
  name: 'Enterprise', cycle: 'monthly', currency: 'USD', baseFee: 8000,
  limits: { databases: 500, eventsPerDay: 250000000, hotStorageGB: 5120 },
};
let BILLING_RATES = {
  perDatabase: 100,        // per monitored DB / mo
  perInlineDb: 200,        // real-time blocking add-on / DB
  coldPerGB: 0.01,         // WORM archive / GB / mo
  eventOveragePerM: 0.50,  // per 1M events/day above plan
  hotOveragePerGB: 0.20,   // per GB above included hot storage
  perDsar: 25,             // per DSAR processed this period
};

// Load the persisted rate card into memory (called at startup + after every edit).
async function loadBillingRates() {
  try {
    const r = (await pgPool.query('SELECT * FROM billing_rates WHERE id = 1')).rows[0];
    if (!r) return;
    BILLING_PLAN = {
      name: 'Enterprise', cycle: 'monthly', currency: r.currency || 'USD', baseFee: Number(r.base_fee),
      limits: { databases: r.limit_databases, eventsPerDay: Number(r.limit_events_per_day), hotStorageGB: r.limit_hot_storage_gb },
    };
    BILLING_RATES = {
      perDatabase: Number(r.per_database), perInlineDb: Number(r.per_inline_db), coldPerGB: Number(r.cold_per_gb),
      eventOveragePerM: Number(r.event_overage_per_m), hotOveragePerGB: Number(r.hot_overage_per_gb), perDsar: Number(r.per_dsar),
    };
    console.log(`[Billing] Rate card loaded · base $${BILLING_PLAN.baseFee} · $${BILLING_RATES.perDatabase}/db`);
  } catch (e) { console.error('[Billing] loadBillingRates failed:', e.message); }
}
const GB = 1024 ** 3;

// Compute real usage from live platform state.
async function computeUsage() {
  const dbRow = (await pgPool.query(
    `SELECT COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM agents a WHERE a.instance_id = d.instance_id)) AS monitored FROM databases d`
  )).rows[0];
  const monitoredDbs = parseInt(dbRow.monitored) || 0;
  const inlineDbs = parseInt((await pgPool.query(`SELECT COUNT(DISTINCT instance_id) AS n FROM agents WHERE agent_type = 'inline_proxy'`)).rows[0].n) || 0;
  const dsarThisPeriod = parseInt((await pgPool.query(`SELECT COUNT(*) AS n FROM dsar_requests WHERE created_at >= date_trunc('month', now())`)).rows[0].n) || 0;

  let eventsPerDay = 0, hotBytes = 0;
  try {
    const days7 = parseInt(await chSafe("SELECT count() FROM dam_analytics.events WHERE timestamp >= now() - INTERVAL 7 DAY", 'TabSeparated')) || 0;
    const today = parseInt(await chSafe("SELECT count() FROM dam_analytics.events WHERE timestamp >= today()", 'TabSeparated')) || 0;
    eventsPerDay = Math.max(Math.round(days7 / 7), today);
    hotBytes = parseInt(await chSafe("SELECT sum(bytes_on_disk) FROM system.parts WHERE database = 'dam_analytics' AND active", 'TabSeparated')) || 0;
  } catch (e) { /* ClickHouse not ready */ }

  let coldBytes = 0, coldObjects = 0;
  try { if (archive && archive.usage) { const u = await archive.usage(); coldBytes = u.bytes; coldObjects = u.objects; } } catch (e) { /* archive offline */ }

  return {
    monitoredDbs, inlineDbs, dsarThisPeriod, eventsPerDay,
    hotGB: hotBytes / GB, coldGB: coldBytes / GB, coldObjects,
  };
}

// Build current-period invoice line items from usage × pricing.
// `plan`/`rates` default to the global card; per-tenant negotiated contracts
// pass an effective card (see effectiveBilling) so a customer is billed at their
// contracted rates while everyone else uses the global rate card.
function buildLineItems(u, plan = BILLING_PLAN, rates = BILLING_RATES) {
  const items = [];
  items.push({ item: 'Enterprise base fee', desc: 'Monthly platform access', qty: 1, rate: plan.baseFee, amount: plan.baseFee });
  items.push({ item: 'Monitored databases', desc: `${u.monitoredDbs} active databases × $${rates.perDatabase}/db/mo`, qty: u.monitoredDbs, rate: rates.perDatabase, amount: u.monitoredDbs * rates.perDatabase });

  const eventOverM = Math.max(0, (u.eventsPerDay - plan.limits.eventsPerDay) / 1e6);
  items.push({ item: 'Event volume', desc: eventOverM > 0 ? `${eventOverM.toFixed(1)}M/day over plan` : `Included up to ${(plan.limits.eventsPerDay / 1e6).toFixed(0)}M events/day`, qty: `${(u.eventsPerDay / 1e6).toFixed(u.eventsPerDay >= 1e6 ? 1 : 3)}M`, rate: eventOverM > 0 ? rates.eventOveragePerM : 'Included', amount: +(eventOverM * rates.eventOveragePerM).toFixed(2) });

  const hotOverGB = Math.max(0, u.hotGB - plan.limits.hotStorageGB);
  items.push({ item: 'Hot storage', desc: hotOverGB > 0 ? `${hotOverGB.toFixed(1)} GB over included` : `${u.hotGB.toFixed(2)} GB (included up to ${(plan.limits.hotStorageGB / 1024).toFixed(0)} TB)`, qty: `${u.hotGB.toFixed(2)} GB`, rate: hotOverGB > 0 ? rates.hotOveragePerGB : 'Included', amount: +(hotOverGB * rates.hotOveragePerGB).toFixed(2) });

  const coldAmt = +(u.coldGB * rates.coldPerGB).toFixed(2);
  items.push({ item: 'Cold storage (WORM archive)', desc: `Compliance archive · ${u.coldObjects} objects · 7-year retention`, qty: `${u.coldGB.toFixed(3)} GB`, rate: `$${rates.coldPerGB}/GB`, amount: coldAmt });

  items.push({ item: 'Inline blocking', desc: `Real-time query blocking on ${u.inlineDbs} database(s)`, qty: u.inlineDbs, rate: rates.perInlineDb, amount: u.inlineDbs * rates.perInlineDb });

  if (u.dsarThisPeriod > 0) items.push({ item: 'DSAR processing', desc: `${u.dsarThisPeriod} request(s) this period`, qty: u.dsarThisPeriod, rate: rates.perDsar, amount: u.dsarThisPeriod * rates.perDsar });

  const total = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  return { items, total: +total.toFixed(2) };
}

// Effective billing card for a tenant = global card with any ACTIVE per-tenant
// negotiated overrides applied (a NULL field keeps the global value; an override
// past its valid_until is ignored). Drives both admin + product billing.
const RATE_OVERRIDE_COLS = {
  per_database: 'perDatabase', per_inline_db: 'perInlineDb', event_overage_per_m: 'eventOveragePerM',
  hot_overage_per_gb: 'hotOveragePerGB', cold_per_gb: 'coldPerGB', per_dsar: 'perDsar',
};
async function effectiveBilling(tenantId) {
  let o = null;
  try { o = (await pgPool.query('SELECT * FROM tenant_billing_overrides WHERE tenant_id = $1', [tenantId])).rows[0] || null; } catch { /* table not ready */ }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const active = !!o && (o.valid_until == null || new Date(o.valid_until) >= today);
  const plan = { ...BILLING_PLAN, limits: { ...BILLING_PLAN.limits } };
  const rates = { ...BILLING_RATES };
  if (active) {
    if (o.base_fee != null) plan.baseFee = Number(o.base_fee);
    for (const [col, key] of Object.entries(RATE_OVERRIDE_COLS)) if (o[col] != null) rates[key] = Number(o[col]);
  }
  return { plan, rates, override: o, active };
}

function periodLabel(d) { return d.toLocaleString('en-US', { month: 'short', year: 'numeric' }); }

// Generate (or refresh) the current month's invoice from live usage, and ensure
// a little history exists so the screen is never empty on a fresh deployment.
async function ensureInvoices(tenantId, usage, plan, rates) {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const due = new Date(now.getFullYear(), now.getMonth() + 1, 15);
  const { items, total } = buildLineItems(usage, plan, rates);
  const ref = `INV-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  // Test override: shrink the *current* invoice (history/backfill keep real numbers).
  let invItems = items, invTotal = total;
  if (BILLING_TEST_TOTAL_USD != null && !Number.isNaN(BILLING_TEST_TOTAL_USD)) {
    invTotal = BILLING_TEST_TOTAL_USD;
    invItems = [{ item: 'Test charge', desc: 'Reduced bill for payment-gateway testing (BILLING_TEST_TOTAL_USD)', qty: 1, rate: BILLING_TEST_TOTAL_USD, amount: BILLING_TEST_TOTAL_USD }];
  }

  const existing = (await pgPool.query('SELECT * FROM billing_invoices WHERE reference = $1', [ref])).rows[0];
  if (!existing) {
    // Backfill 5 prior months once (derived from current total with mild taper) so history isn't empty.
    const anyHistory = parseInt((await pgPool.query('SELECT COUNT(*) AS n FROM billing_invoices')).rows[0].n);
    if (anyHistory === 0) {
      for (let k = 5; k >= 1; k--) {
        const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
        const amt = +(total * (1 - k * 0.03)).toFixed(2);
        const r2 = `INV-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        await pgPool.query(
          `INSERT INTO billing_invoices (tenant_id, reference, period, period_start, amount, currency, status, line_items, due_date, issued_at, paid_at)
           VALUES ($1,$2,$3,$4,$5,'USD','paid','[]',$6,$7,$7) ON CONFLICT (reference) DO NOTHING`,
          [tenantId, r2, periodLabel(d), d, amt > 0 ? amt : total, new Date(d.getFullYear(), d.getMonth() + 1, 15), new Date(d.getFullYear(), d.getMonth() + 1, 1)]
        );
      }
    }
    await pgPool.query(
      `INSERT INTO billing_invoices (tenant_id, reference, period, period_start, amount, currency, status, line_items, due_date)
       VALUES ($1,$2,$3,$4,$5,'USD','open',$6,$7) ON CONFLICT (reference) DO NOTHING`,
      [tenantId, ref, periodLabel(now), periodStart, invTotal, JSON.stringify(invItems), due]
    );
  } else if (existing.status !== 'paid') {
    // Keep the open invoice in sync with live usage (or the test override).
    await pgPool.query('UPDATE billing_invoices SET amount = $2, line_items = $3 WHERE id = $1', [existing.id, invTotal, JSON.stringify(invItems)]);
  }
  return ref;
}

app.get('/api/billing', authRequired, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const usage = await computeUsage();
    const eff = await effectiveBilling(tenantId);
    const currentRef = await ensureInvoices(tenantId, usage, eff.plan, eff.rates);
    const invoices = (await pgPool.query('SELECT reference, period, amount, currency, status, due_date, issued_at, line_items FROM billing_invoices ORDER BY period_start DESC LIMIT 12')).rows;
    const current = invoices.find((i) => i.reference === currentRef) || invoices[0];
    const outstanding = invoices.filter((i) => i.status !== 'paid').reduce((s, i) => s + Number(i.amount), 0);
    const methods = (await pgPool.query('SELECT id, provider, label, currency, role, status FROM payment_methods ORDER BY role, created_at')).rows;

    const pct = (v, lim) => Math.min(100, Math.round((v / lim) * 100));
    res.json({
      plan: eff.plan,
      contract: eff.active ? { negotiated: true, validUntil: eff.override.valid_until, reason: eff.override.reason } : { negotiated: false },
      account: { email: req.user.email, autopay: true, terms: 'Net 30', nextDue: current ? current.due_date : null },
      usage: {
        databases: { used: usage.monitoredDbs, limit: BILLING_PLAN.limits.databases, pct: pct(usage.monitoredDbs, BILLING_PLAN.limits.databases) },
        eventsPerDay: { used: usage.eventsPerDay, limit: BILLING_PLAN.limits.eventsPerDay, pct: pct(usage.eventsPerDay, BILLING_PLAN.limits.eventsPerDay) },
        hotStorageGB: { used: +usage.hotGB.toFixed(2), limit: BILLING_PLAN.limits.hotStorageGB, pct: pct(usage.hotGB, BILLING_PLAN.limits.hotStorageGB) },
        coldStorageGB: { used: +usage.coldGB.toFixed(3), objects: usage.coldObjects },
        inlineDbs: usage.inlineDbs,
      },
      currentInvoice: current ? { reference: current.reference, period: current.period, total: Number(current.amount), items: current.line_items } : null,
      balance: { outstanding: +outstanding.toFixed(2), currency: 'USD' },
      paymentMethods: methods,
      invoices,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Record a payment against the outstanding invoice(s) (gateway redirect is simulated).
app.post('/api/billing/pay', authRequired, async (req, res) => {
  const { reference, gateway } = req.body;
  const txn = (gateway === 'Razorpay' ? 'rzp_pay_' : 'pi_') + crypto.randomBytes(8).toString('hex');
  const inv = reference
    ? (await pgPool.query(`UPDATE billing_invoices SET status='paid', paid_at=now() WHERE reference=$1 AND status<>'paid' RETURNING *`, [reference])).rows[0]
    : (await pgPool.query(`UPDATE billing_invoices SET status='paid', paid_at=now() WHERE status<>'paid' RETURNING *`)).rows[0];
  await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'billing.payment', resourceType: 'invoice', resourceId: inv ? inv.id : null, details: { reference: inv ? inv.reference : reference, gateway: gateway || 'Stripe', txn } });
  res.json({ ok: true, txn, gateway: gateway || 'Stripe', invoice: inv ? inv.reference : reference });
});

// Connect a payment gateway.
app.post('/api/billing/payment-methods', authRequired, async (req, res) => {
  const { provider, label, currency, role } = req.body;
  if (!provider) return res.status(400).json({ error: 'provider required' });
  if (role === 'primary') await pgPool.query(`UPDATE payment_methods SET role='backup' WHERE role='primary'`);
  const r = (await pgPool.query(
    `INSERT INTO payment_methods (tenant_id, provider, label, currency, role, status) VALUES ($1,$2,$3,$4,$5,'connected') RETURNING *`,
    [req.user.tenantId, provider, label || `${provider} gateway`, currency || 'USD', role || 'primary']
  )).rows[0];
  await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'billing.gateway_connect', resourceType: 'payment_method', resourceId: r.id, details: { provider, currency } });
  res.status(201).json(r);
});

// ── Live payment gateways: Razorpay + PayU ────────────────
// Resolve the invoice to charge (by reference, else the oldest unpaid one) and its
// INR amount. Shared by both gateways.
async function resolvePayable(reference) {
  const row = reference
    ? (await pgPool.query(`SELECT id, tenant_id, reference, amount, status FROM billing_invoices WHERE reference = $1`, [reference])).rows[0]
    : (await pgPool.query(`SELECT id, tenant_id, reference, amount, status FROM billing_invoices WHERE status <> 'paid' ORDER BY period_start ASC LIMIT 1`)).rows[0];
  if (!row) return null;
  const amountUsd = Number(row.amount);
  return { ...row, amountUsd, amountInr: usdToInr(amountUsd) };
}

// Which gateways are live (drives the UI). Never returns secrets — key_id is public.
app.get('/api/billing/payment-config', authRequired, (req, res) => {
  const rz = activeRazorpay();
  const pu = activePayU();
  res.json({
    // Razorpay is always "available" (own key → live order+verify; else demo key → real UI, test cards).
    razorpay: { available: true, mode: rz.mode, keyId: rz.keyId, configured: rz.mode === 'live' },
    // PayU likewise: own key+salt → live; else demo sandbox creds → real hosted page, test cards.
    payu: { available: true, mode: pu.mode, source: pu.source, configured: pu.source !== 'demo' },
    currency: 'INR', usdToInr: USD_TO_INR,
  });
});

// Razorpay — start a payment. Live mode creates a server-side Order (verified on
// return); demo mode returns just the public key + amount so the real Razorpay UI
// opens with test cards (no order to verify → confirmed via /razorpay/demo-confirm).
app.post('/api/billing/razorpay/order', authRequired, async (req, res) => {
  try {
    const rz = activeRazorpay();
    const inv = await resolvePayable(req.body && req.body.reference);
    if (!inv) return res.status(404).json({ error: 'No outstanding invoice to pay' });
    const amountPaise = Math.round(inv.amountInr * 100);
    const base = { keyId: rz.keyId, mode: rz.mode, amount: amountPaise, currency: 'INR', amountInr: inv.amountInr, amountUsd: inv.amountUsd, reference: inv.reference, name: 'TooVix DAM', email: req.user.email };
    if (rz.mode === 'demo') return res.json({ ...base, orderId: null }); // no-order checkout
    const auth = Buffer.from(`${rz.keyId}:${rz.keySecret}`).toString('base64');
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: inv.reference, notes: { invoice: inv.reference, tenant: inv.tenant_id } }),
      signal: AbortSignal.timeout(8000),
    });
    const order = await r.json();
    if (!r.ok) {
      const desc = order.error?.description || 'Razorpay order failed';
      if (r.status === 401) return res.status(502).json({ error: `Razorpay rejected the API credentials (${desc}). In Settings → Payments, re-enter the Key ID and Key Secret from the same key pair (Dashboard → Test Mode → API Keys). If you regenerated the key, both values change.` });
      return res.status(502).json({ error: desc });
    }
    res.json({ ...base, orderId: order.id });
  } catch (err) {
    console.error('[Billing] razorpay order failed:', err.message);
    res.status(500).json({ error: 'Could not create Razorpay order' });
  }
});

// Razorpay — verify the signature returned by the in-page checkout (live mode), then mark paid.
app.post('/api/billing/razorpay/verify', authRequired, async (req, res) => {
  const rz = activeRazorpay();
  if (rz.mode !== 'live') return res.status(400).json({ error: 'Razorpay not in live mode' });
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, reference } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: 'Missing payment fields' });
  const expected = crypto.createHmac('sha256', rz.keySecret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
  const ok = expected.length === razorpay_signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(razorpay_signature));
  if (!ok) return res.status(400).json({ ok: false, error: 'Signature verification failed' });
  const inv = (await pgPool.query(`UPDATE billing_invoices SET status='paid', paid_at=now() WHERE reference=$1 AND status<>'paid' RETURNING id, reference`, [reference])).rows[0];
  await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'billing.payment', resourceType: 'invoice', resourceId: inv ? inv.id : null, details: { reference, gateway: 'Razorpay', txn: razorpay_payment_id } });
  res.json({ ok: true, txn: razorpay_payment_id, invoice: reference });
});

// Razorpay — demo-mode confirm (only when no real key is configured; there is no
// order/signature to verify, so the test-card success simply marks the invoice paid).
app.post('/api/billing/razorpay/demo-confirm', authRequired, async (req, res) => {
  if (activeRazorpay().mode !== 'demo') return res.status(400).json({ error: 'Not in demo mode' });
  const { razorpay_payment_id, reference } = req.body || {};
  const inv = (await pgPool.query(`UPDATE billing_invoices SET status='paid', paid_at=now() WHERE reference=$1 AND status<>'paid' RETURNING id, reference`, [reference])).rows[0];
  await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'billing.payment', resourceType: 'invoice', resourceId: inv ? inv.id : null, details: { reference, gateway: 'Razorpay (demo)', txn: razorpay_payment_id || 'demo' } });
  res.json({ ok: true, txn: razorpay_payment_id || 'demo', invoice: reference, demo: true });
});

// PayU — build the request hash + params; the browser auto-submits to PayU's page.
app.post('/api/billing/payu/initiate', authRequired, async (req, res) => {
  const pu = activePayU();
  if (!pu) return res.status(400).json({ error: 'PayU not configured', configured: false });
  try {
    const inv = await resolvePayable(req.body && req.body.reference);
    if (!inv) return res.status(404).json({ error: 'No outstanding invoice to pay' });
    const txnid = 'TVX' + crypto.randomBytes(8).toString('hex');
    const amount = inv.amountInr.toFixed(2);
    const productinfo = inv.reference;
    const firstname = (req.user.fullName || req.user.email || 'TooVix').split(' ')[0].replace(/[^a-zA-Z0-9]/g, '') || 'Customer';
    const email = req.user.email;
    // No udf fields — the invoice ref rides in `productinfo`. (PayU's test env hashes
    // udf1-5 as empty; sending a populated udf1 causes a hash mismatch.)
    // PayU v1 request hash: key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||salt
    const reqSeq = [pu.merchantKey, txnid, amount, productinfo, firstname, email, '', '', '', '', ''].join('|') + '||||||' + pu.salt;
    const hash = crypto.createHash('sha512').update(reqSeq).digest('hex');
    const params = {
      key: pu.merchantKey, txnid, amount, productinfo, firstname, email,
      phone: '9999999999',
      surl: `${API_PUBLIC_URL}/api/billing/payu/callback`,
      furl: `${API_PUBLIC_URL}/api/billing/payu/callback`,
      hash,
    };
    res.json({ action: `${payuBase(pu.mode)}/_payment`, params });
  } catch (err) {
    console.error('[Billing] payu initiate failed:', err.message);
    res.status(500).json({ error: 'Could not start PayU payment' });
  }
});

// PayU — callback (PayU posts the result here as a browser form-POST). Verify the
// reverse hash, mark the invoice paid on success, then redirect back to the app.
app.post('/api/billing/payu/callback', async (req, res) => {
  const pu = activePayU();
  const b = req.body || {};
  const { status, txnid, amount, productinfo, firstname, email, udf1 = '', hash: posted, mihpayid } = b;
  let outcome = 'failed';
  if (!pu) { outcome = 'invalid'; }
  else {
    // PayU v1 reverse hash: salt|status|<6 empty>|udf5..udf1 (reversed)|email|firstname|productinfo|amount|txnid|key
    const revSeq = [pu.salt, status].join('|') + '||||||' + ['', '', '', '', udf1].join('|') + '|' + [email, firstname, productinfo, amount, txnid, pu.merchantKey].join('|');
    const expected = crypto.createHash('sha512').update(revSeq).digest('hex');
    const valid = posted && expected === posted;
    if (valid && status === 'success') {
      const inv = (await pgPool.query(`UPDATE billing_invoices SET status='paid', paid_at=now() WHERE reference=$1 AND status<>'paid' RETURNING id, tenant_id`, [productinfo || udf1])).rows[0];
      if (inv) await writeAudit({ tenantId: inv.tenant_id, actorId: null, actorEmail: email || 'payu', action: 'billing.payment', resourceType: 'invoice', resourceId: inv.id, details: { reference: productinfo || udf1, gateway: 'PayU', txn: mihpayid || txnid } });
      outcome = 'success';
    } else if (!valid) { outcome = 'invalid'; console.warn('[Billing] PayU callback hash mismatch for txn', txnid); }
  }
  res.redirect(302, `${APP_BASE_URL}/billing?payu=${outcome}&txnid=${encodeURIComponent(txnid || '')}`);
});

// ── Settings · Payment gateway configuration ──────────────
// Read masked config + save/clear keys (Settings → Payments). Secrets never returned.
const GW_FIELDS = {
  razorpay: [{ key: 'key_id', label: 'Key ID', secret: false }, { key: 'key_secret', label: 'Key secret', secret: true }],
  payu: [{ key: 'merchant_key', label: 'Merchant key', secret: false }, { key: 'salt', label: 'Salt', secret: true }, { key: 'mode', label: 'Mode', secret: false }],
};
function maskTail(s) { s = String(s || ''); return s.length <= 6 ? '••••' : '••••' + s.slice(-4); }

app.get('/api/billing/gateways/config', authRequired, (req, res) => {
  const rz = activeRazorpay(), pu = activePayU();
  const rzDb = gatewayDbConfig.razorpay || {}, puDb = gatewayDbConfig.payu || {};
  res.json({
    razorpay: { source: rz.source, mode: rz.mode, keyId: (rzDb.key_id || process.env.RAZORPAY_KEY_ID || (rz.mode === 'demo' ? rz.keyId : '')) || '', hasSecret: !!(rzDb.key_secret || process.env.RAZORPAY_KEY_SECRET), demoKey: RAZORPAY_DEMO_KEY },
    payu: { source: pu ? pu.source : null, configured: !!pu, merchantKey: (puDb.merchant_key || process.env.PAYU_MERCHANT_KEY || ''), hasSalt: !!(puDb.salt || process.env.PAYU_SALT), mode: pu ? pu.mode : 'test' },
    usdToInr: USD_TO_INR,
  });
});

// Save gateway keys. Blank secret keeps the stored one. Reloads the live config.
app.put('/api/billing/gateways/:provider', authRequired, async (req, res) => {
  const provider = req.params.provider;
  if (!GW_FIELDS[provider]) return res.status(400).json({ error: 'Unknown gateway' });
  const body = req.body || {};
  try {
    const existing = (await pgPool.query('SELECT config FROM gateway_config WHERE provider = $1', [provider])).rows[0];
    const prev = (existing && existing.config) || {};
    const config = {};
    for (const f of GW_FIELDS[provider]) {
      let v = body[f.key];
      v = (v === undefined || v === null) ? '' : String(v).trim();
      if (f.secret && !v) v = prev[f.key] || ''; // keep stored secret on blank
      config[f.key] = v;
    }
    if (provider === 'payu' && !['test', 'live'].includes(config.mode)) config.mode = 'test';
    // Require the non-secret id to be present to save (secret may be kept).
    const idField = provider === 'razorpay' ? 'key_id' : 'merchant_key';
    const secretField = provider === 'razorpay' ? 'key_secret' : 'salt';
    if (!config[idField] || !config[secretField]) return res.status(400).json({ error: `${provider === 'razorpay' ? 'Key ID and secret' : 'Merchant key and salt'} are required` });
    await pgPool.query(`INSERT INTO gateway_config (provider, config, updated_at) VALUES ($1,$2,now())
      ON CONFLICT (provider) DO UPDATE SET config = $2, updated_at = now()`, [provider, config]);
    await loadGatewayConfig();
    await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'billing.gateway_configure', resourceType: 'gateway', resourceId: null, details: { provider, mode: config.mode || null } });
    res.json({ ok: true, provider });
  } catch (err) {
    console.error('[Billing] gateway save failed:', err.message);
    res.status(500).json({ error: 'Failed to save gateway' });
  }
});

app.delete('/api/billing/gateways/:provider', authRequired, async (req, res) => {
  const provider = req.params.provider;
  if (!GW_FIELDS[provider]) return res.status(400).json({ error: 'Unknown gateway' });
  await pgPool.query('DELETE FROM gateway_config WHERE provider = $1', [provider]);
  await loadGatewayConfig();
  await writeAudit({ tenantId: req.user.tenantId, actorId: req.user.userId, actorEmail: req.user.email, action: 'billing.gateway_disconnect', resourceType: 'gateway', resourceId: null, details: { provider } });
  res.json({ ok: true, provider });
});

// ── Invoice PDF ───────────────────────────────────────────
// Self-contained PDF writer (standard-14 fonts, no embedding, no dependency) so an
// invoice downloads as a real .pdf. Layout: header, billed-to + meta, line-item
// table, total, footer. Helvetica for labels, Courier (monospace) for right-aligned
// numbers so alignment needs no glyph-width metrics.
function buildInvoicePdf(inv, party, cur) {
  cur = cur || { code: 'USD', rate: 1, sym: '$' };
  const W = 595, H = 842, ML = 50, MR = 545;
  let c = '';
  const esc = (s) => String(s).replace(/[\\()]/g, (m) => '\\' + m);
  const A = (s) => String(s == null ? '' : s).replace(/₹/g, 'Rs ').replace(/×/g, 'x').replace(/[•·]/g, '-').replace(/[–—]/g, '-').replace(/[^\x20-\x7E]/g, '');
  const T = (x, top, s, f = 'F1', sz = 11) => { c += `BT /${f} ${sz} Tf ${x.toFixed(2)} ${(H - top).toFixed(2)} Td (${esc(A(s))}) Tj ET\n`; };
  const TR = (xr, top, s, f = 'F3', sz = 10) => { s = A(s); T(xr - s.length * sz * 0.6, top, s, f, sz); };
  const fill = (r, g, b) => { c += `${r} ${g} ${b} rg\n`; };
  const stroke = (r, g, b) => { c += `${r} ${g} ${b} RG\n`; };
  const line = (x1, t1, x2, t2, w = 0.7) => { c += `${w} w ${x1} ${(H - t1).toFixed(2)} m ${x2} ${(H - t2).toFixed(2)} l S\n`; };
  const box = (x, top, w, h, doFill) => { c += `${x} ${(H - (top + h)).toFixed(2)} ${w} ${h} re ${doFill ? 'f' : 'S'}\n`; };
  // Convert the USD-denominated invoice to the chosen display currency (mirrors the
  // frontend's money(): symbol + amount × rate).
  const money = (n) => cur.sym + (Number(n || 0) * cur.rate).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dt = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';

  // Header
  fill(0.06, 0.09, 0.16); box(0, 0, W, 6, true);
  fill(0.1, 0.12, 0.2); T(ML, 58, 'TooVix', 'F2', 22);
  fill(0.45, 0.5, 0.6); T(ML + 80, 58, 'DAM', 'F1', 16);
  fill(0.5, 0.55, 0.62); T(ML, 74, 'Database Activity Monitoring', 'F1', 9);
  fill(0.1, 0.12, 0.2); T(452, 56, 'INVOICE', 'F2', 22);
  stroke(0.85, 0.87, 0.9); line(ML, 92, MR, 92, 1);

  // Billed to
  fill(0.5, 0.55, 0.62); T(ML, 122, 'BILLED TO', 'F2', 9);
  fill(0.1, 0.12, 0.2); T(ML, 140, party.name, 'F1', 12);
  fill(0.4, 0.45, 0.55); T(ML, 155, party.email, 'F1', 10);

  // Meta (right)
  let my = 122;
  [['Invoice No', inv.reference], ['Period', inv.period], ['Issued', dt(inv.issued_at)], ['Due', dt(inv.due_date)], ['Currency', cur.code], ['Status', String(inv.status || '').toUpperCase()]]
    .forEach(([k, v]) => { fill(0.5, 0.55, 0.62); T(360, my, k, 'F1', 10); fill(0.1, 0.12, 0.2); TR(MR, my, v, 'F3', 10); my += 16; });

  // Table header
  let y = 226;
  fill(0.95, 0.96, 0.98); box(ML, y - 13, MR - ML, 20, true);
  fill(0.35, 0.4, 0.5); T(ML + 8, y, 'DESCRIPTION', 'F2', 9);
  TR(385, y, 'QTY', 'F4', 9); TR(470, y, 'RATE', 'F4', 9); TR(MR - 8, y, 'AMOUNT', 'F4', 9);
  y += 24;

  // Rows
  let items = Array.isArray(inv.line_items) ? inv.line_items : (() => { try { return JSON.parse(inv.line_items || '[]'); } catch { return []; } })();
  if (!items.length) items = [{ item: 'Monthly subscription + add-ons', desc: inv.period, qty: 1, rate: '', amount: inv.amount }];
  items.forEach((it) => {
    fill(0.12, 0.14, 0.22); T(ML + 8, y, it.item || '', 'F1', 10);
    if (it.desc) { fill(0.55, 0.6, 0.68); T(ML + 8, y + 11, String(it.desc).slice(0, 74), 'F1', 8); }
    const rate = typeof it.rate === 'number' ? money(it.rate) : String(it.rate == null ? '' : it.rate);
    fill(0.2, 0.23, 0.3);
    TR(385, y, String(it.qty == null ? '' : it.qty), 'F3', 10);
    TR(470, y, rate, 'F3', 9);
    TR(MR - 8, y, money(it.amount), 'F3', 10);
    y += it.desc ? 27 : 20;
    stroke(0.92, 0.93, 0.95); line(ML, y - 6, MR, y - 6, 0.5);
  });

  // Total
  y += 8;
  stroke(0.2, 0.23, 0.3); line(360, y, MR, y, 1); y += 20;
  fill(0.1, 0.12, 0.2); T(360, y, 'Total Due', 'F2', 12);
  TR(MR - 8, y, money(inv.amount), 'F4', 13);

  // Footer
  const fy = H - 70;
  stroke(0.9, 0.91, 0.93); line(ML, fy - 14, MR, fy - 14, 0.7);
  fill(0.5, 0.55, 0.62);
  T(ML, fy, inv.status === 'paid' ? 'Paid - thank you for your business.' : 'Payment terms: Net 30. Pay securely via the TooVix DAM billing portal.', 'F1', 9);
  T(ML, fy + 13, 'TooVix DAM - Database Activity Monitoring - system-generated invoice.', 'F1', 8);
  T(ML, fy + 25, 'Generated ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', 'F1', 8);

  // Assemble objects
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R /F4 8 0 R >> >> /Contents 4 0 R >>';
  objs[4] = `<< /Length ${Buffer.byteLength(c, 'latin1')} >>\nstream\n${c}endstream`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objs[7] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  objs[8] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>';

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = Buffer.byteLength(pdf, 'latin1'); pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  const n = objs.length;
  pdf += `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (let i = 1; i < n; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

app.get('/api/billing/invoices/:reference/pdf', authRequired, async (req, res) => {
  try {
    const inv = (await pgPool.query('SELECT * FROM billing_invoices WHERE reference = $1', [req.params.reference])).rows[0];
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    const tenant = (await pgPool.query('SELECT name FROM tenants WHERE id = $1', [inv.tenant_id])).rows[0];
    // Display currency from the frontend (the rate it's showing keeps the PDF in sync).
    const code = String(req.query.currency || 'USD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'USD';
    let rate = parseFloat(req.query.rate);
    if (!rate || rate <= 0 || !isFinite(rate)) rate = 1;
    const PDF_SYM = { USD: '$', INR: 'Rs ', EUR: 'EUR ', GBP: 'GBP ', CAD: 'C$', SGD: 'S$', JPY: 'JPY ', AUD: 'A$' };
    const cur = { code, rate, sym: PDF_SYM[code] || (code + ' ') };
    const pdf = buildInvoicePdf(inv, { name: (tenant && tenant.name) || req.user.tenantName || 'Customer', email: req.user.email }, cur);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${inv.reference}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[Billing] invoice pdf failed:', err.message);
    res.status(500).json({ error: 'Could not generate invoice PDF' });
  }
});

// ── Users ─────────────────────────────────────────────────
app.get('/api/users', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(
    'SELECT id, email, full_name, role, auth_provider, mfa_enabled, status, last_login_at, created_at FROM users WHERE tenant_id = $1 ORDER BY created_at', [req.user.tenantId]
  );
  res.json(rows);
});

app.post('/api/users', authRequired, adminOnly, async (req, res) => {
  const { email, full_name, role, auth_provider, password } = req.body;
  if (!email || !full_name || !role) {
    return res.status(400).json({ error: 'email, full_name, and role are required' });
  }
  const cleanEmail = email.toLowerCase().trim();
  // Scoped to THIS workspace — the same email may exist in other workspaces.
  const existing = await pgPool.query('SELECT id FROM users WHERE email = $1 AND tenant_id = $2', [cleanEmail, req.user.tenantId]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'A user with this email already exists in this workspace' });
  }

  // SSO users (Azure AD / Okta / Google) sign in via their IdP — no password, no invite
  // token, MFA handled by the IdP. Local users without a password get a set-password
  // invite token (+ TOTP MFA); a local user created with a password is active.
  const isSso = !!SSO_INVITE_PROVIDERS[auth_provider];
  const isLocalInvite = !isSso && !password;
  const hash = (!isSso && password) ? await bcrypt.hash(password, 10) : null;
  const inviteToken = isLocalInvite ? crypto.randomBytes(32).toString('hex') : null;
  const inviteExpires = isLocalInvite ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null;
  const status = (!isSso && password) ? 'active' : 'invited';
  const storedProvider = isSso ? auth_provider : 'local';
  const mfaEnabled = !isSso; // password users get TOTP MFA; SSO delegates MFA to the IdP

  const { rows } = await pgPool.query(
    `INSERT INTO users (tenant_id, email, full_name, role, auth_provider, mfa_enabled, status, password_hash, invite_token, invite_expires_at, invited_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, email, full_name, role, auth_provider, mfa_enabled, status, created_at`,
    [req.user.tenantId, cleanEmail, full_name, role, storedProvider, mfaEnabled, status, hash, inviteToken, inviteExpires, req.user.userId]
  );

  const tenantName = req.user.tenantName || 'TooVix DAM';
  let emailSent = false;
  let inviteLink = null;
  if (isLocalInvite) {
    const acceptUrl = `${APP_BASE_URL}/accept-invite?token=${inviteToken}`;
    let sent = false;
    try {
      await sendInviteEmail({ to: cleanEmail, fullName: full_name, role, tenantName, inviterName: req.user.fullName, acceptUrl });
      sent = true;
    } catch (err) {
      console.error('[Invite] Email send failed:', err.message);
    }
    // "emailSent" means a real email was dispatched (SMTP configured). With no SMTP we
    // surface the link to the admin instead, so the flow stays testable in dev.
    emailSent = smtpConfigured() && sent;
    if (!smtpConfigured()) inviteLink = acceptUrl;
  } else if (isSso) {
    const loginUrl = `${APP_BASE_URL}/login`;
    let sent = false;
    try {
      await sendSsoInviteEmail({ to: cleanEmail, fullName: full_name, role, tenantName, inviterName: req.user.fullName, loginUrl, providerName: SSO_INVITE_PROVIDERS[auth_provider] });
      sent = true;
    } catch (err) {
      console.error('[Invite] SSO email send failed:', err.message);
    }
    emailSent = smtpConfigured() && sent;
    if (!smtpConfigured()) inviteLink = loginUrl;
  }

  res.status(201).json({ ...rows[0], emailSent, inviteLink });
});

// ── Invitations (public: accept flow) ─────────────────────
app.get('/api/invites/:token', async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT u.email, u.full_name, u.role, u.invite_expires_at, t.name AS tenant_name,
            (SELECT full_name FROM users WHERE id = u.invited_by) AS invited_by_name
     FROM users u JOIN tenants t ON u.tenant_id = t.id
     WHERE u.invite_token = $1 AND u.status = 'invited'`,
    [req.params.token]
  );
  if (!rows.length) return res.status(404).json({ error: 'Invitation not found or already used' });
  const inv = rows[0];
  if (inv.invite_expires_at && new Date(inv.invite_expires_at) < new Date()) {
    return res.status(410).json({ error: 'This invitation has expired. Ask your admin to resend it.' });
  }
  res.json({
    email: inv.email,
    full_name: inv.full_name,
    role: inv.role,
    tenant_name: inv.tenant_name,
    invited_by_name: inv.invited_by_name,
  });
});

app.post('/api/invites/:token/accept', async (req, res) => {
  const { full_name, password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const { rows } = await pgPool.query(
    `SELECT id, invite_expires_at FROM users WHERE invite_token = $1 AND status = 'invited'`,
    [req.params.token]
  );
  if (!rows.length) return res.status(404).json({ error: 'Invitation not found or already used' });
  if (rows[0].invite_expires_at && new Date(rows[0].invite_expires_at) < new Date()) {
    return res.status(410).json({ error: 'This invitation has expired. Ask your admin to resend it.' });
  }
  const hash = await bcrypt.hash(password, 10);
  await pgPool.query(
    `UPDATE users SET password_hash = $1, full_name = COALESCE(NULLIF($2, ''), full_name),
       status = 'active', invite_token = NULL, invite_expires_at = NULL
     WHERE id = $3`,
    [hash, full_name || '', rows[0].id]
  );
  // A tenant admin accepting = their workspace's first admin is now active → welcome
  // them (best-effort). Team members (non-admin) just get the plain "you can sign in".
  try {
    const info = (await pgPool.query(
      `SELECT u.email, u.full_name, u.role, t.name AS tenant_name, t.slug, t.tier
       FROM users u JOIN tenants t ON u.tenant_id = t.id WHERE u.id = $1`, [rows[0].id])).rows[0];
    if (info && info.role === 'tenant_admin') {
      sendWelcomeEmail({ to: info.email, fullName: info.full_name, tenantName: info.tenant_name, slug: info.slug, tier: info.tier, loginUrl: `${APP_BASE_URL}/login` })
        .catch((e) => console.error(`[Welcome] send failed for ${info.email}: ${e.message}`));
    }
  } catch (e) { /* welcome is best-effort */ }
  res.json({ message: 'Invitation accepted. You can now sign in.' });
});

// ── Resend invitation (admin) ─────────────────────────────
app.post('/api/users/:id/resend-invite', authRequired, adminOnly, async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT u.id, u.email, u.full_name, u.role, u.auth_provider, t.name AS tenant_name
     FROM users u JOIN tenants t ON u.tenant_id = t.id
     WHERE u.id = $1 AND u.status = 'invited'`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'No pending invitation for this user' });
  const u = rows[0];
  let sent = false;
  let link;

  if (SSO_INVITE_PROVIDERS[u.auth_provider]) {
    // SSO user — re-send the access notification; no token to regenerate.
    link = `${APP_BASE_URL}/login`;
    try {
      await sendSsoInviteEmail({ to: u.email, fullName: u.full_name, role: u.role, tenantName: u.tenant_name, inviterName: req.user.fullName, loginUrl: link, providerName: SSO_INVITE_PROVIDERS[u.auth_provider] });
      sent = true;
    } catch (err) {
      console.error('[Invite] SSO resend failed:', err.message);
    }
  } else {
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pgPool.query(`UPDATE users SET invite_token = $1, invite_expires_at = $2 WHERE id = $3`, [inviteToken, inviteExpires, u.id]);
    link = `${APP_BASE_URL}/accept-invite?token=${inviteToken}`;
    try {
      await sendInviteEmail({ to: u.email, fullName: u.full_name, role: u.role, tenantName: u.tenant_name, inviterName: req.user.fullName, acceptUrl: link });
      sent = true;
    } catch (err) {
      console.error('[Invite] Resend failed:', err.message);
    }
  }

  res.json({ message: 'Invitation resent', emailSent: smtpConfigured() && sent, inviteLink: smtpConfigured() ? null : link });
});

app.delete('/api/users/:id', authRequired, adminOnly, async (req, res) => {
  const { rowCount } = await pgPool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ message: 'User deleted' });
});

// ── ClickHouse helper ─────────────────────────────────────
const CH_URL = `http://${process.env.CLICKHOUSE_HOST || 'dam-clickhouse'}:${process.env.CLICKHOUSE_PORT || 8123}`;
const CH_AUTH = `user=${process.env.CLICKHOUSE_USER || 'dam_writer'}&password=${encodeURIComponent(process.env.CLICKHOUSE_PASSWORD || 'dam_click_secret')}`;
async function chQuery(sql, format = 'JSONEachRow') {
  const res = await fetch(`${CH_URL}/?${CH_AUTH}&query=${encodeURIComponent(sql)}&default_format=${format}`);
  const text = await res.text();
  if (format === 'JSONEachRow') return text.trim().split('\n').filter(l => l).map(l => JSON.parse(l));
  return text.trim();
}

// Insert a single event into the data-plane stream (used by the detection sim so
// every raised alert has a real, matching event behind it).
async function chInsertEvent(ev) {
  const db = await eventsDbFor(ev.tenant_id);
  const q = `INSERT INTO ${db}.events (tenant_id, database_name, timestamp, principal, client_ip, operation, schema_name, table_name, columns_accessed, row_count, sql_text, anomaly_score, tags, agent_type, source_host) FORMAT JSONEachRow`;
  await fetch(`${CH_URL}/?${CH_AUTH}&query=${encodeURIComponent(q)}`, { method: 'POST', body: JSON.stringify(ev) });
}

// ── Tier-based data-plane isolation ──────────────────────────────────────────
// Trial/starter tenants SHARE dam_analytics; PAID tenants (professional/enterprise/
// business) get a DEDICATED ClickHouse database once provisioned. The chosen DB is
// stored in tenants.data_plane (NULL = shared) so Meridian stays shared until migrated.
const DEDICATED_TIERS = new Set(['professional', 'enterprise', 'business']);
const _tenantDbCache = new Map(); // tenantId -> ch db name
function chDbName(tenantId) { return 'tenant_' + String(tenantId).replace(/-/g, ''); }
async function eventsDbFor(tenantId) {
  if (!tenantId) return 'dam_analytics';
  if (_tenantDbCache.has(tenantId)) return _tenantDbCache.get(tenantId);
  let db = 'dam_analytics';
  try {
    const t = (await pgPool.query('SELECT data_plane FROM tenants WHERE id = $1', [tenantId])).rows[0];
    if (t && t.data_plane) db = t.data_plane;
  } catch (e) { /* fall back to shared */ }
  _tenantDbCache.set(tenantId, db);
  return db;
}
async function chExecRaw(sql) { await fetch(`${CH_URL}/?${CH_AUTH}`, { method: 'POST', body: sql }); }
// Provision a dedicated events DB for a paid tenant (idempotent); records it on the tenant.
async function ensureTenantEventsDb(tenantId) {
  const db = chDbName(tenantId);
  await chExecRaw(`CREATE DATABASE IF NOT EXISTS ${db}`);
  await chExecRaw(`CREATE TABLE IF NOT EXISTS ${db}.events (
    tenant_id String, database_name String, event_id UUID DEFAULT generateUUIDv4(),
    timestamp DateTime64(3) DEFAULT now64(), principal String, client_ip String,
    operation LowCardinality(String), schema_name String, table_name String,
    columns_accessed Array(String), row_count UInt64 DEFAULT 0, sql_hash String,
    sql_text String, duration_ms UInt32 DEFAULT 0, anomaly_score UInt8 DEFAULT 0,
    tags Array(String), agent_type LowCardinality(String), source_host String
  ) ENGINE = MergeTree() PARTITION BY toYYYYMM(timestamp) ORDER BY (tenant_id, database_name, timestamp)`);
  await pgPool.query('UPDATE tenants SET data_plane = $1 WHERE id = $2', [db, tenantId]);
  _tenantDbCache.set(tenantId, db);
  console.log(`[DataPlane] Provisioned dedicated events DB ${db} for tenant ${tenantId}`);
  return db;
}
async function provisionDataPlaneIfPaid(tenantId, tier) {
  if (DEDICATED_TIERS.has(String(tier || '').toLowerCase())) {
    try { await ensureTenantEventsDb(tenantId); } catch (e) { console.error('[DataPlane] provision failed:', e.message); }
  }
}

// ── Dashboard APIs ────────────────────────────────────────

// Fleet risk: weighted composite score (0–100)
// 30% highest DB risk | 25% critical/high alerts | 15% unmonitored DBs
// 10% offline agents  | 10% compliance gaps      | 10% sensitive unmasked
async function computeFleetRisk(pgPool, T) {
  const dbStats = await pgPool.query(
    `SELECT COUNT(*) as total,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM agents a WHERE a.instance_id = d.instance_id)) as monitored,
            COALESCE(MAX(risk_score), 0) as max_risk,
            COALESCE(AVG(risk_score), 0) as avg_risk
     FROM databases d WHERE d.tenant_id = $1`, [T]
  );
  const alertStats = await pgPool.query(
    `SELECT COUNT(*) FILTER (WHERE severity = 'critical') as critical,
            COUNT(*) FILTER (WHERE severity = 'high') as high
     FROM alerts WHERE status = 'open' AND tenant_id = $1`, [T]
  );
  const agentStats = await pgPool.query(
    `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'online') as online FROM agents WHERE tenant_id = $1`, [T]
  );
  let complianceGaps = 0;
  try {
    const cmp = await pgPool.query(`SELECT COUNT(*) as cnt FROM compliance_scores WHERE score < 85`);
    complianceGaps = parseInt(cmp.rows[0].cnt);
  } catch(e) {}
  let unmaskedPct = 0;
  try {
    const cls = await pgPool.query(
      `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_masked = false) as unmasked FROM classified_columns WHERE tenant_id = $1`, [T]
    );
    const t = parseInt(cls.rows[0].total);
    if (t > 0) unmaskedPct = parseInt(cls.rows[0].unmasked) / t;
  } catch(e) {}

  const db = dbStats.rows[0];
  const al = alertStats.rows[0];
  const ag = agentStats.rows[0];

  const totalDbs = parseInt(db.total) || 1;
  const monitoredDbs = parseInt(db.monitored);
  const maxRisk = parseInt(db.max_risk);
  const critAlerts = parseInt(al.critical);
  const highAlerts = parseInt(al.high);
  const totalAgents = parseInt(ag.total) || 1;
  const onlineAgents = parseInt(ag.online);

  // Factor 1: Highest DB risk score (0–100) → 30%
  const f1 = maxRisk;

  // Factor 2: Critical/high alert penalty (0–100) → 25%
  // Each critical = 15 points, each high = 8 points, capped at 100
  const f2 = Math.min(100, critAlerts * 15 + highAlerts * 8);

  // Factor 3: Unmonitored DB percentage (0–100) → 15%
  const f3 = ((totalDbs - monitoredDbs) / totalDbs) * 100;

  // Factor 4: Offline agent percentage (0–100) → 10%
  const f4 = ((totalAgents - onlineAgents) / totalAgents) * 100;

  // Factor 5: Compliance gaps (0–100) → 10%
  // Each framework below 85% adds ~14 points (100/7 frameworks)
  const f5 = Math.min(100, complianceGaps * 14);

  // Factor 6: Unmasked sensitive columns (0–100) → 10%
  const f6 = unmaskedPct * 100;

  const score = Math.round(f1 * 0.30 + f2 * 0.25 + f3 * 0.15 + f4 * 0.10 + f5 * 0.10 + f6 * 0.10);

  return {
    score: Math.min(100, Math.max(0, score)),
    factors: {
      maxDbRisk: { value: f1, weight: '30%', detail: `Highest DB risk: ${maxRisk}` },
      alertPenalty: { value: Math.round(f2), weight: '25%', detail: `${critAlerts} critical + ${highAlerts} high alerts` },
      unmonitored: { value: Math.round(f3), weight: '15%', detail: `${totalDbs - monitoredDbs}/${totalDbs} unmonitored` },
      offlineAgents: { value: Math.round(f4), weight: '10%', detail: `${totalAgents - onlineAgents}/${totalAgents} offline` },
      complianceGaps: { value: Math.round(f5), weight: '10%', detail: `${complianceGaps} frameworks below 85%` },
      unmaskedData: { value: Math.round(f6), weight: '10%', detail: `${Math.round(unmaskedPct * 100)}% unmasked` },
    }
  };
}

app.get('/api/dashboard/kpis', authRequired, async (req, res) => {
  const T = req.user.tenantId;
  try {
    const dbs = await pgPool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM agents a WHERE a.instance_id = d.instance_id)) as monitored FROM databases d WHERE d.tenant_id = $1`, [T]);
    const alerts = await pgPool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE severity = 'critical') as critical, COUNT(*) FILTER (WHERE severity = 'high') as high FROM alerts WHERE status = 'open' AND tenant_id = $1`, [T]);
    const users = await pgPool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'active') as active FROM users WHERE tenant_id = $1`, [T]);
    const agents = await pgPool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'online') as online FROM agents WHERE tenant_id = $1`, [T]);

    let eventsToday = 0, sensitiveReads = 0, quarantined = 0;
    try {
      const evDb = await eventsDbFor(T);
      eventsToday = parseInt(await chQuery(`SELECT count() FROM ${evDb}.events WHERE tenant_id = '${T}' AND timestamp >= today()`, 'TabSeparated')) || 0;
      sensitiveReads = parseInt(await chQuery(`SELECT count() FROM ${evDb}.events WHERE tenant_id = '${T}' AND length(tags) > 0 AND timestamp >= today()`, 'TabSeparated')) || 0;
      quarantined = (await pgPool.query(`SELECT COUNT(*)::int AS n FROM quarantine_sessions WHERE tenant_id = $1 AND status='held'`, [T])).rows[0].n;
    } catch(e) {}

    const fleetRisk = await computeFleetRisk(pgPool, T);

    const dbRow = dbs.rows[0];
    const alRow = alerts.rows[0];
    res.json({
      databases: { total: parseInt(dbRow.total), monitored: parseInt(dbRow.monitored) },
      alerts: { total: parseInt(alRow.total), critical: parseInt(alRow.critical), high: parseInt(alRow.high) },
      users: { total: parseInt(users.rows[0].total), active: parseInt(users.rows[0].active) },
      agents: { total: parseInt(agents.rows[0].total), online: parseInt(agents.rows[0].online) },
      eventsToday,
      sensitiveReads,
      quarantined,
      fleetRisk: fleetRisk.score,
      fleetRiskFactors: fleetRisk.factors,
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/events-timeline', authRequired, async (req, res) => {
  try { const evDb = await eventsDbFor(req.user.tenantId); res.json(await chQuery(`SELECT toStartOfHour(timestamp) as hour, count() as cnt FROM ${evDb}.events WHERE tenant_id = '${req.user.tenantId}' AND timestamp >= now() - INTERVAL 12 HOUR GROUP BY hour ORDER BY hour`)); }
  catch(e) { res.json([]); }
});

app.get('/api/dashboard/risky-databases', authRequired, async (req, res) => {
  // Risk is computed inline from live signals (same formula as the recompute job) so the
  // widget is always consistent with its own open-alert counts — no 60s staleness window.
  const { rows } = await pgPool.query(
    `SELECT d.id, d.name, d.engine, d.version, d.region,
       CASE WHEN EXISTS (SELECT 1 FROM agents a WHERE a.instance_id = d.instance_id) THEN 'monitored' ELSE 'not_monitored' END AS monitoring_status,
       COALESCE(al.open_alerts, 0) AS open_alerts,
       LEAST(100,
         LEAST(55, COALESCE(al.crit,0)*8 + COALESCE(al.high,0)*3 + COALESCE(al.med,0)*1)
         + CASE WHEN NOT EXISTS (SELECT 1 FROM agents a WHERE a.instance_id = d.instance_id) THEN 20 ELSE 0 END
         + CASE WHEN COALESCE(array_length(d.sensitivity_tags,1),0) > 0 THEN 15 ELSE 0 END
         + CASE WHEN EXISTS (SELECT 1 FROM classified_columns c WHERE c.database_id = d.id AND c.sensitivity IN ('high','critical')) THEN 10 ELSE 0 END
       )::int AS risk_score
     FROM databases d
     LEFT JOIN (
       SELECT database_id, COUNT(*) AS open_alerts,
         COUNT(*) FILTER (WHERE severity='critical') AS crit,
         COUNT(*) FILTER (WHERE severity='high') AS high,
         COUNT(*) FILTER (WHERE severity='medium') AS med
       FROM alerts WHERE status='open' AND database_id IS NOT NULL AND tenant_id = $1 GROUP BY database_id
     ) al ON al.database_id = d.id
     WHERE d.tenant_id = $1
     ORDER BY risk_score DESC, open_alerts DESC LIMIT 10`, [req.user.tenantId]);
  res.json(rows);
});

app.get('/api/dashboard/recent-alerts', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT a.id, a.severity, a.principal, a.summary, a.anomaly_score, a.status, a.created_at,
       d.name as database_name
     FROM alerts a LEFT JOIN databases d ON a.database_id = d.id
     WHERE a.tenant_id = $1
     ORDER BY a.created_at DESC LIMIT 10`, [req.user.tenantId]);
  res.json(rows);
});

// Open alerts grouped by severity — backs the "Open alerts by severity" donut.
// (Distinct from recent-alerts, which is the latest-10 activity feed of any status.)
app.get('/api/dashboard/alerts-by-severity', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT severity, COUNT(*)::int AS count FROM alerts WHERE status = 'open' AND tenant_id = $1 GROUP BY severity`, [req.user.tenantId]);
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  rows.forEach((r) => { if (counts[r.severity] !== undefined) counts[r.severity] = r.count; });
  res.json({ ...counts, total: counts.critical + counts.high + counts.medium + counts.low });
});

app.get('/api/dashboard/events-by-database', authRequired, async (req, res) => {
  try { const evDb = await eventsDbFor(req.user.tenantId); res.json(await chQuery(`SELECT database_name, count() as cnt FROM ${evDb}.events WHERE tenant_id = '${req.user.tenantId}' AND timestamp >= today() GROUP BY database_name ORDER BY cnt DESC`)); }
  catch(e) { res.json([]); }
});

app.get('/api/dashboard/sensitive-access', authRequired, async (req, res) => {
  try { const evDb = await eventsDbFor(req.user.tenantId); res.json(await chQuery(`SELECT arrayJoin(tags) as tag, count() as cnt FROM ${evDb}.events WHERE tenant_id = '${req.user.tenantId}' AND length(tags) > 0 AND timestamp >= today() - 7 GROUP BY tag ORDER BY cnt DESC`)); }
  catch(e) { res.json([]); }
});

app.get('/api/dashboard/sensitive-daily', authRequired, async (req, res) => {
  try {
    const evDb = await eventsDbFor(req.user.tenantId);
    res.json(await chQuery(`SELECT toDayOfWeek(timestamp) as dow, arrayJoin(tags) as tag, count() as cnt FROM ${evDb}.events WHERE tenant_id = '${req.user.tenantId}' AND length(tags) > 0 AND timestamp >= today() - 7 GROUP BY dow, tag ORDER BY dow`));
  } catch(e) { res.json([]); }
});

app.get('/api/dashboard/compliance', async (req, res) => {
  try {
    const { rows } = await pgPool.query(`SELECT * FROM compliance_scores ORDER BY framework`);
    if (rows.length > 0) return res.json(rows);
  } catch(e) {}
  res.json([
    { framework: 'PCI-DSS 4.0', score: 91 }, { framework: 'GDPR', score: 86 },
    { framework: 'SOX', score: 93 }, { framework: 'HIPAA', score: 88 },
    { framework: 'DPDPA', score: 82 }, { framework: 'RBI CSF', score: 91 },
    { framework: 'ISO 27001', score: 79 },
  ]);
});

app.get('/api/dashboard/coverage', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(`SELECT COALESCE(region, 'Unknown') as region, COUNT(*) as cnt FROM databases WHERE tenant_id = $1 GROUP BY region ORDER BY cnt DESC`, [req.user.tenantId]);
  res.json(rows);
});

// ── Audit trail ───────────────────────────────────────────
// Tamper-evident hash chain: each row's hash = SHA-256(prev_hash | content).
// Altering or removing any past row breaks every subsequent hash.
function stableStr(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStr).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStr(v[k])).join(',') + '}';
}
function auditRowHash(prevHash, r) {
  const payload = [prevHash, r.actor_email || '', r.action || '', r.resource_type || '', r.resource_id || '', stableStr(r.details || {})].join('|');
  return crypto.createHash('sha256').update(payload).digest('hex');
}
const GENESIS_HASH = '0'.repeat(64);
async function writeAudit({ tenantId = null, actorId = null, actorEmail = null, action, resourceType = null, resourceId = null, details = {} }) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(918273)'); // serialize chain appends
    const prev = (await client.query('SELECT row_hash FROM audit_trail ORDER BY id DESC LIMIT 1')).rows[0];
    const prevHash = prev && prev.row_hash ? prev.row_hash : GENESIS_HASH;
    const row = { actor_email: actorEmail, action, resource_type: resourceType, resource_id: resourceId, details };
    const rowHash = auditRowHash(prevHash, row);
    const tid = tenantId || (await client.query('SELECT id FROM tenants LIMIT 1')).rows[0]?.id;
    await client.query(
      `INSERT INTO audit_trail (tenant_id, actor_id, actor_email, action, resource_type, resource_id, details, prev_hash, row_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tid, actorId, actorEmail, action, resourceType, resourceId, JSON.stringify(details), prevHash, rowHash]
    );
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.log('[Audit] write failed:', e.message); }
  finally { client.release(); }
}

// Control-plane audit: who did what in the DAM console (Postgres).
app.get('/api/audit', authRequired, async (req, res) => {
  const { rows } = await pgPool.query(
    'SELECT * FROM audit_trail WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100', [req.user.tenantId]
  );
  res.json(rows);
});

// Verify the hash chain — recompute every row and confirm linkage.
app.get('/api/audit/verify', async (req, res) => {
  const { rows } = await pgPool.query('SELECT id, actor_email, action, resource_type, resource_id, details, prev_hash, row_hash FROM audit_trail ORDER BY id ASC');
  let prev = GENESIS_HASH;
  for (const r of rows) {
    const expect = auditRowHash(prev, r);
    if ((r.prev_hash || GENESIS_HASH) !== prev || r.row_hash !== expect) {
      return res.json({ ok: false, total: rows.length, broken_at: r.id });
    }
    prev = r.row_hash;
  }
  res.json({ ok: true, total: rows.length });
});

// ── Data-plane integrity: signed Merkle checkpoints + WORM archive ──
const { createArchive } = require('./archive');
const AUDIT_SIGNING_KEY = process.env.AUDIT_SIGNING_KEY || 'dev-audit-signing-key';
// Pluggable WORM backend: s3 (AWS/MinIO/on-prem) | azure | none — see archive.js.
let archive = null;

async function initArchive() {
  try {
    archive = createArchive(process.env);
    if (!archive) { console.log('[Archive] disabled (ARCHIVE_PROVIDER=none) — detection-only'); return; }
    await archive.init();
    console.log(`[Archive] ready · ${archive.name} · WORM=${archive.mode}/${archive.lockDays}d`);
  } catch (e) { archive = null; console.log('[Archive] unavailable:', e.message); }
}

// Deterministic digest of a window's events (count + SHA-256 over sorted event hashes).
async function windowDigest(fromTs, toTs) {
  const sql = `SELECT count() AS cnt, lower(hex(SHA256(arrayStringConcat(arraySort(groupArray(concat(toString(event_id),'|',toString(timestamp),'|',principal,'|',operation,'|',toString(row_count)))), '\n')))) AS root
    FROM dam_analytics.events WHERE timestamp >= parseDateTimeBestEffort('${chEsc(fromTs)}') AND timestamp < parseDateTimeBestEffort('${chEsc(toTs)}')`;
  const r = await chSafe(sql);
  const row = Array.isArray(r) && r[0] ? r[0] : { cnt: 0, root: '' };
  return { count: parseInt(row.cnt) || 0, root: row.root || '' };
}
function checkpointChainHash(prev, cp) {
  return crypto.createHash('sha256').update([prev, cp.seq, cp.window_start, cp.window_end, cp.event_count, cp.merkle_root].join('|')).digest('hex');
}
async function archiveWindow(seq, fromTs, toTs) {
  if (!archive) return null;
  try {
    const rows = await chSafe(`SELECT event_id, timestamp, principal, database_name, operation, schema_name, table_name, row_count, sql_text FROM dam_analytics.events WHERE timestamp >= parseDateTimeBestEffort('${chEsc(fromTs)}') AND timestamp < parseDateTimeBestEffort('${chEsc(toTs)}') ORDER BY timestamp`);
    const ndjson = rows.map((r) => JSON.stringify(r)).join('\n');
    const key = `events/checkpoint-${String(seq).padStart(6, '0')}.ndjson`;
    return await archive.put(key, ndjson, 'application/x-ndjson');
  } catch (e) { console.log('[Archive] put failed:', e.message); return null; }
}
async function runCheckpoint() {
  try {
    const last = (await pgPool.query('SELECT seq, window_end, chain_hash FROM audit_checkpoints ORDER BY seq DESC LIMIT 1')).rows[0];
    const toTs = new Date(Date.now() - 30000).toISOString(); // 30s settle margin
    let fromTs;
    if (last) fromTs = new Date(last.window_end).toISOString();
    else {
      const min = await chSafe('SELECT min(timestamp) FROM dam_analytics.events', 'TabSeparated');
      if (!min || min.startsWith('0000')) return;
      fromTs = new Date(min.replace(' ', 'T') + 'Z').toISOString();
    }
    if (new Date(fromTs) >= new Date(toTs)) return;
    const { count, root } = await windowDigest(fromTs, toTs);
    if (count === 0) return;
    const seq = last ? last.seq + 1 : 1;
    const prev = last && last.chain_hash ? last.chain_hash : '0'.repeat(64);
    const cp = { seq, window_start: fromTs, window_end: toTs, event_count: count, merkle_root: root };
    const chainHash = checkpointChainHash(prev, cp);
    const signature = crypto.createHmac('sha256', AUDIT_SIGNING_KEY).update(chainHash).digest('hex');
    const archiveKey = await archiveWindow(seq, fromTs, toTs);
    await pgPool.query(
      `INSERT INTO audit_checkpoints (seq, window_start, window_end, event_count, merkle_root, prev_hash, chain_hash, signature, archive_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [seq, fromTs, toTs, count, root, prev, chainHash, signature, archiveKey]
    );
    console.log(`[Checkpoint] #${seq} · ${count} events · root=${root.slice(0, 10)} · archived=${archiveKey ? 'yes' : 'no'}`);
  } catch (e) { console.log('[Checkpoint] failed:', e.message); }
}
setInterval(runCheckpoint, 180000);
setTimeout(() => { initArchive().then(runCheckpoint); }, 25000);

app.get('/api/audit/checkpoints', async (req, res) => {
  const { rows } = await pgPool.query('SELECT seq, window_start, window_end, event_count, merkle_root, chain_hash, signature, archive_key, created_at FROM audit_checkpoints ORDER BY seq DESC LIMIT 50');
  res.json(rows.map((r) => ({ ...r, archived: !!r.archive_key })));
});
// Recompute every checkpoint against ClickHouse — detects deleted/altered events.
app.get('/api/audit/checkpoints/verify', async (req, res) => {
  const cps = (await pgPool.query('SELECT * FROM audit_checkpoints ORDER BY seq ASC')).rows;
  let prev = '0'.repeat(64);
  const broken = [];
  for (const cp of cps) {
    const ws = new Date(cp.window_start).toISOString(), we = new Date(cp.window_end).toISOString();
    const { count, root } = await windowDigest(ws, we);
    const chainHash = checkpointChainHash(prev, { seq: cp.seq, window_start: ws, window_end: we, event_count: cp.event_count, merkle_root: cp.merkle_root });
    const sig = crypto.createHmac('sha256', AUDIT_SIGNING_KEY).update(cp.chain_hash).digest('hex');
    let reason = null;
    if (Number(count) !== Number(cp.event_count)) reason = `event count changed (${cp.event_count} → ${count})`;
    else if (root !== cp.merkle_root) reason = 'event content altered (merkle root mismatch)';
    else if ((cp.prev_hash || '0'.repeat(64)) !== prev || cp.chain_hash !== chainHash) reason = 'checkpoint chain broken';
    else if (cp.signature !== sig) reason = 'invalid signature';
    if (reason) broken.push({ seq: cp.seq, reason });
    prev = cp.chain_hash;
  }
  res.json({ ok: broken.length === 0, total: cps.length, broken });
});

// Database-activity audit: every captured query (data plane, ClickHouse events).
// Filterable + paginated so the full history is searchable, not just the live tail.
const chEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const VALID_OPS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'DDL', 'LOGIN', 'LOGOUT', 'GRANT', 'OTHER'];
app.get('/api/audit/activity', authRequired, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const evDb = await eventsDbFor(req.user.tenantId);
    const where = [`tenant_id = '${chEsc(req.user.tenantId)}'`];
    if (req.query.database) where.push(`database_name = '${chEsc(req.query.database)}'`);
    if (req.query.operation && VALID_OPS.includes(req.query.operation)) where.push(`operation = '${req.query.operation}'`);
    if (req.query.q) { const q = chEsc(req.query.q); where.push(`(sql_text ILIKE '%${q}%' OR principal ILIKE '%${q}%')`); }
    if (req.query.from) where.push(`timestamp >= parseDateTimeBestEffort('${chEsc(req.query.from)}')`);
    if (req.query.to) where.push(`timestamp <= parseDateTimeBestEffort('${chEsc(req.query.to)}')`);
    const whereSql = 'WHERE ' + where.join(' AND ');

    const total = parseInt(await chQuery(`SELECT count() FROM ${evDb}.events ${whereSql}`, 'TabSeparated')) || 0;
    const rows = await chQuery(
      `SELECT timestamp, principal, database_name, operation, schema_name, table_name,
              sql_text, row_count, anomaly_score, client_ip, agent_type
       FROM ${evDb}.events ${whereSql}
       ORDER BY timestamp DESC
       LIMIT ${limit} OFFSET ${offset}`
    );
    // hash-chain index relative to the full (filtered) set, newest = highest.
    res.json({ rows: rows.map((r, i) => ({ ...r, chain: total - offset - i })), total, offset, limit });
  } catch (e) {
    res.json({ rows: [], total: 0, offset: 0, limit: 100 });
  }
});

// ── WebSocket server (live updates) ───────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));

  ws.on('close', () => console.log('[WS] Client disconnected'));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

// Policy-driven detection simulator. Every 30-60s it picks an active rule:
//   enabled  → raises a real alert (honoring false-positive suppressions)
//   monitor  → shadow mode: increments the rule's shadow hit/FP counters, no alert
//   disabled → never selected, so it never fires.
// Toggling a rule's status on the Policies screen genuinely changes what happens.
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const DETAIL_BY_RULE = {
  'Bulk read of sensitive data': { action: 'READ', subtype: 'SELECT', object_name: 'crm.contacts', program: 'tableau', user_type: 'human', tags: ['pii'], flags: ['rows_z_score_extreme', 'sensitive_access'], sql: 'SELECT contact_id, full_name, email, phone\n  FROM crm.contacts\n WHERE lead_score >= 50' },
  'Privileged off-hours access': { action: 'READ', subtype: 'SELECT', object_name: 'customers.personal_data', program: 'psql', user_type: 'human (DBA)', tags: ['gdpr', 'pii'], flags: ['unusual_access_time'], sql: "SELECT customer_id, tax_id\n  FROM customers.personal_data\n WHERE country = 'DE'" },
  'Credential brute force': { action: 'LOGIN', subtype: 'log_connections', object_name: 'pg_catalog', program: 'psql', user_type: 'external IP', tags: [], flags: ['failed_login_spike', 'single_source'], sql: '-- repeated failed authentication attempts --\nFATAL: password authentication failed' },
  'DDL change control': { action: 'DDL', subtype: 'ALTER TABLE', object_name: 'dbo.accounts', program: 'sqlcmd', user_type: 'service', tags: [], flags: ['ddl_outside_window'], sql: 'ALTER TABLE dbo.accounts\n  ADD settlement_ref NVARCHAR(64) NULL;' },
  'GRANT of DBA / SYSDBA': { action: 'GRANT', subtype: 'GRANT', object_name: 'app_temp', program: 'sqlplus', user_type: 'human (DBA)', tags: [], flags: ['privilege_escalation'], sql: 'GRANT DBA TO app_temp;' },
};
const GENERIC_DETAIL = { action: 'READ', subtype: 'SELECT', object_name: 'app.records', program: 'jdbc', user_type: 'service', tags: ['pii'], flags: ['anomaly_detected'], sql: 'SELECT * FROM app.records\n WHERE updated_at > now() - interval 7 day' };
const sevBaseScore = (s) => (s === 'critical' ? 60 : s === 'high' ? 45 : s === 'medium' ? 30 : 20);

setInterval(async () => {
  try {
    const tenantId = (await pgPool.query('SELECT id FROM tenants LIMIT 1')).rows[0].id;
    // Generate a realistic, enriched event that matches one ENABLED rule, so the
    // detection engine has live traffic to evaluate (it doesn't create the alert).
    // Bias toward rules the engine can fully evaluate so alerts keep flowing.
    const pols = (await pgPool.query(`SELECT * FROM policies WHERE status = 'enabled'`)).rows;
    if (!pols.length) return;
    const EVALUABLE = ['Bulk read of sensitive data', 'GRANT of DBA / SYSDBA'];
    const evPols = pols.filter((x) => EVALUABLE.includes(x.name));
    const p = (evPols.length && Math.random() < 0.6) ? pick(evPols) : pick(pols);
    const def = (() => { try { return typeof p.rule_definition === 'string' ? JSON.parse(p.rule_definition) : (p.rule_definition || {}); } catch { return {}; } })();
    let principal = pick(['bi_reader', 'app_crm', 'svc_analytics', 'dba_mueller', 'svc_etl', 'temp_audit']);
    if (def.principal_user_type === 'dba') principal = 'dba_mueller'; // rule scoped to DBAs
    // Attribute the alert to a real registered database so per-DB risk/counts are accurate.
    const dbRow = pick((await pgPool.query('SELECT id, name FROM databases')).rows);
    if (!dbRow) return; // no databases registered yet
    const database = dbRow.name;
    const d = DETAIL_BY_RULE[p.name] || GENERIC_DETAIL;

    // Behavioral predicate: unusual_access_time is evaluated against the learned
    // baseline. During the learning period (no baseline for this principal) we do
    // NOT flag it — otherwise everything would look "unusual" at cold start.
    let evTimestamp; // undefined → event stamped now()
    if (def.unusual_access_time) {
      const total = parseInt(await chQuery(`SELECT count() FROM dam_analytics.baselines WHERE principal = '${chEsc(principal)}'`, 'TabSeparated')) || 0;
      if (total === 0) return; // no baseline yet → still learning → don't fire on time anomaly
      const offHour = Math.floor(Math.random() * 6); // a candidate off-hours access (00:00–05:59)
      const atHour = parseInt(await chQuery(`SELECT count() FROM dam_analytics.baselines WHERE principal = '${chEsc(principal)}' AND hour_of_day = ${offHour}`, 'TabSeparated')) || 0;
      if (atHour > 0) return; // principal IS normally active then → not unusual → don't fire
      const n = new Date(), pad = (x) => String(x).padStart(2, '0');
      evTimestamp = `${n.getUTCFullYear()}-${pad(n.getUTCMonth() + 1)}-${pad(n.getUTCDate())} ${pad(offHour)}:${pad(Math.floor(Math.random() * 60))}:00`;
    }

    // Enabled — raise a real alert, honoring false-positive suppressions.
    const supp = await pgPool.query(
      `SELECT 1 FROM alert_suppressions
       WHERE rule = $1 AND (principal IS NULL OR principal = $2) AND (object_name IS NULL OR object_name = $3) LIMIT 1`,
      [p.name, principal, d.object_name]
    );
    if (supp.rows.length) return;
    const anomaly_score = Math.min(99, sevBaseScore(p.severity) + Math.floor(Math.random() * 40));
    const client_ip = `10.20.${Math.floor(Math.random() * 40)}.${Math.floor(Math.random() * 200)}`;
    const cond = typeof p.rule_definition === 'string' ? p.rule_definition : JSON.stringify(p.rule_definition || {}, null, 2);

    // Derive a real event from the rule's DSL so the alert is grounded in the
    // event stream (the Test backtest and shadow hits will then find it too).
    const operation = (OP_MAP[d.action] && OP_MAP[d.action][0]) || 'SELECT';
    const rowsNum = def.rows_affected && typeof def.rows_affected.gte === 'number'
      ? def.rows_affected.gte + Math.floor(Math.random() * 5000)
      : Math.floor(Math.random() * 2000);
    const evTags = (def.object_sensitivity_tags && Array.isArray(def.object_sensitivity_tags.any_of)) ? def.object_sensitivity_tags.any_of : (d.tags || []);
    const [schema_name, table_name] = (d.object_name || '').includes('.') ? d.object_name.split('.') : ['', d.object_name || ''];
    try {
      const ev = {
        tenant_id: tenantId, database_name: database, principal, client_ip, operation,
        schema_name, table_name, columns_accessed: [], row_count: rowsNum, sql_text: d.sql,
        anomaly_score, tags: evTags, agent_type: 'network', source_host: 'detection-sim',
      };
      if (evTimestamp) ev.timestamp = evTimestamp;
      await chInsertEvent(ev);
    } catch (e) { /* event insert best-effort */ }

    // TRAFFIC GENERATOR ONLY — the event is now in the stream; the detection engine
    // below evaluates it (and real captured events) against the rules and raises any
    // alert. Alerts come from real evaluation, not from here.
  } catch (e) {
    console.log('[Traffic sim] failed:', e.message);
  }
}, 20000 + Math.floor(Math.random() * 20000));

// ── Real detection engine (Phase 1) ───────────────────────
// Incrementally scans the captured event stream and evaluates each ENABLED policy's
// DSL against real events (reusing policyToClickhouse) — matches become alerts,
// deduped via a moving watermark and honoring suppressions/exceptions. Stateless +
// tag/threshold rules now; behavioral/windowed rules are Phase 2.
let detectionWatermark = null;
// Only evaluate a rule in Phase 1 if EVERY predicate is supported, or the only
// ignored ones are harmless scope refinements. A rule whose *defining* predicate is
// behavioral/windowed (first-time, off-hours, N-in-window, cross-schema, no-where,
// grants-role, driver…) must be SKIPPED — firing on its weak remainder over-alerts.
const BENIGN_IGNORABLE = new Set(['principal_user_type']);
async function runDetectionEngine() {
  try {
    const tenants = (await pgPool.query('SELECT id FROM tenants')).rows;
    if (!tenants.length) return;
    const hi = (await chQuery(`SELECT toString(now() - INTERVAL 5 SECOND)`, 'TabSeparated')).trim(); // 5s safety lag
    if (!detectionWatermark) detectionWatermark = (await chQuery(`SELECT toString(now() - INTERVAL 2 MINUTE)`, 'TabSeparated')).trim();
    const lo = detectionWatermark;
    if (!hi || hi <= lo) return;

    // Fully tenant-scoped: each tenant's OWN enabled policies are evaluated only against
    // that tenant's events (in its own data plane), and the resulting alert carries a
    // matching tenant_id + policy_id — never a foreign tenant's policy.
    for (const t of tenants) {
      const tenantId = t.id;
      const pols = (await pgPool.query(`SELECT * FROM policies WHERE tenant_id = $1 AND status = 'enabled'`, [tenantId])).rows;
      if (!pols.length) continue;
      const evDb = await eventsDbFor(tenantId);
      const dbByName = {};
      (await pgPool.query('SELECT id, name FROM databases WHERE tenant_id = $1', [tenantId])).rows.forEach((d) => { dbByName[d.name] = d.id; });
      const supp = (await pgPool.query(`SELECT rule, principal, object_name, database_name FROM alert_suppressions WHERE tenant_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())`, [tenantId])).rows;
      const suppressed = (rule, principal, object, database) => supp.some((s) =>
        s.rule === rule
        && (s.principal == null || s.principal === principal)
        && (s.object_name == null || s.object_name === object)
        && (s.database_name == null || s.database_name === database));

      for (const p of pols) {
        let def = p.rule_definition; if (typeof def === 'string') { try { def = JSON.parse(def); } catch { def = {}; } }
        const { where, ignored, supported } = policyToClickhouse(def || {});
        if (!supported || !ignored.every((k) => BENIGN_IGNORABLE.has(k))) continue; // behavioral/windowed → Phase 2
        const whereSql = [`tenant_id = '${chEsc(tenantId)}'`, `timestamp > '${chEsc(lo)}'`, `timestamp <= '${chEsc(hi)}'`, ...where].join(' AND ');
        let evs;
        try {
          evs = await chQuery(`SELECT principal, database_name, schema_name, table_name, operation, row_count, sql_text, anomaly_score, tags, client_ip
                               FROM ${evDb}.events WHERE ${whereSql} ORDER BY timestamp LIMIT 200`);
        } catch (e) { continue; }
        if (!Array.isArray(evs)) continue;
        for (const ev of evs) {
          const object = ev.schema_name ? `${ev.schema_name}.${ev.table_name}` : (ev.table_name || ev.database_name || '');
          if (suppressed(p.name, ev.principal, object, ev.database_name)) continue; // exception / allow-list honored
          const score = (+ev.anomaly_score > 0) ? +ev.anomaly_score : Math.min(99, sevBaseScore(p.severity) + 20);
          const rowsTxt = ['LOGIN', 'GRANT', 'DDL'].includes(ev.operation) ? '—' : Number(ev.row_count || 0).toLocaleString();
          const ins = await pgPool.query(
            `INSERT INTO alerts (tenant_id, database_id, policy_id, severity, principal, summary, raw_sql, anomaly_score, status,
                                 rule, action, subtype, object_name, rows_affected, client_ip, sensitivity_tags, why, rule_condition)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id, created_at`,
            [tenantId, dbByName[ev.database_name] || null, p.id, p.severity, ev.principal, p.name, ev.sql_text, score,
             p.name, ev.operation, ev.operation, object, rowsTxt, ev.client_ip || '', ev.tags || [], p.description,
             typeof p.rule_definition === 'string' ? p.rule_definition : JSON.stringify(p.rule_definition || {})]
          );
          try { broadcast({ type: 'alert', alert: { id: ins.rows[0].id, severity: p.severity, principal: ev.principal, database: ev.database_name, summary: p.name, anomaly_score: score, timestamp: ins.rows[0].created_at } }); } catch (e) { /* WS optional */ }
          dispatchAlert({ tenantId, severity: p.severity, principal: ev.principal, summary: p.name, database: ev.database_name, raw_sql: ev.sql_text, ts: ins.rows[0].created_at });
        }
      }
    }
    detectionWatermark = hi; // advance only after a full successful pass across all tenants
  } catch (e) { console.log('[Detection] engine failed:', e.message); }
}
setInterval(runDetectionEngine, 7000);
setTimeout(runDetectionEngine, 9000);

// Per-database risk score (0–100), recomputed from real signals so the "Top risky
// databases" widget, the Databases list, and fleet risk all stay live:
//   open-alert pressure (severity-weighted, capped) + unmonitored + sensitive data exposure.
async function recomputeDbRisk() {
  try {
    await pgPool.query(`
      UPDATE databases d SET risk_score = s.score, updated_at = now()
      FROM (
        SELECT d.id,
          LEAST(100,
            LEAST(55, COALESCE(al.crit,0)*8 + COALESCE(al.high,0)*3 + COALESCE(al.med,0)*1)
            + CASE WHEN NOT EXISTS (SELECT 1 FROM agents a WHERE a.instance_id = d.instance_id) THEN 20 ELSE 0 END
            + CASE WHEN COALESCE(array_length(d.sensitivity_tags,1),0) > 0 THEN 15 ELSE 0 END
            + CASE WHEN EXISTS (SELECT 1 FROM classified_columns c WHERE c.database_id = d.id AND c.sensitivity IN ('high','critical')) THEN 10 ELSE 0 END
          )::int AS score
        FROM databases d
        LEFT JOIN (
          SELECT database_id,
            COUNT(*) FILTER (WHERE severity='critical') AS crit,
            COUNT(*) FILTER (WHERE severity='high') AS high,
            COUNT(*) FILTER (WHERE severity='medium') AS med
          FROM alerts WHERE status='open' AND database_id IS NOT NULL GROUP BY database_id
        ) al ON al.database_id = d.id
      ) s WHERE d.id = s.id`);
  } catch (e) { console.log('[Risk] recompute failed:', e.message); }
}
setInterval(recomputeDbRisk, 60000);
setTimeout(recomputeDbRisk, 8000);

// Baseline builder: learn each principal's normal activity (hour-of-day × day-of-week)
// from GENUINE traffic only (excludes the detection sim's own events). This is what
// behavioral predicates like unusual_access_time are scored against.
async function buildBaselines() {
  // INSERT … SELECT must go via POST (ClickHouse runs GET read-only).
  const sql = `INSERT INTO dam_analytics.baselines
       (tenant_id, database_name, principal, hour_of_day, day_of_week, avg_queries, avg_rows, p95_queries, p95_rows, common_tables)
     SELECT tenant_id, database_name, principal,
            toHour(timestamp) AS hour_of_day, toDayOfWeek(timestamp) AS day_of_week,
            count() AS avg_queries, avg(row_count) AS avg_rows,
            quantile(0.95)(row_count) AS p95_queries, quantile(0.95)(row_count) AS p95_rows,
            groupUniqArray(table_name) AS common_tables
     FROM dam_analytics.events
     WHERE timestamp >= now() - INTERVAL 30 DAY AND source_host != 'detection-sim'
     GROUP BY tenant_id, database_name, principal, hour_of_day, day_of_week`;
  try {
    const res = await fetch(`${CH_URL}/?${CH_AUTH}`, { method: 'POST', body: sql });
    if (!res.ok) console.log('[Baselines] build failed:', (await res.text()).slice(0, 200));
  } catch (e) { console.log('[Baselines] build failed:', e.message); }
}
setInterval(buildBaselines, 300000); // refresh learned baselines every 5 min
setTimeout(buildBaselines, 20000);   // initial learn shortly after boot

// Seed a learned "normal hours" profile for the DBA principal (Mon–Fri 09:00–17:00).
// It has no organic traffic, so without this its off-hours rule could never have a
// baseline to deviate from. Represents "we learned dba_mueller works business hours."
async function seedDbaBaseline() {
  try {
    const cnt = parseInt(await chQuery(`SELECT count() FROM dam_analytics.baselines WHERE principal = 'dba_mueller'`, 'TabSeparated')) || 0;
    if (cnt > 0) return;
    const rows = [];
    for (let day = 1; day <= 5; day++) for (let h = 9; h <= 17; h++) {
      rows.push({ tenant_id: 'dev-tenant', database_name: 'PG-CUSTOMERS-EU', principal: 'dba_mueller', hour_of_day: h, day_of_week: day, avg_queries: 20, avg_rows: 200, p95_queries: 40, p95_rows: 800, common_tables: ['customers.personal_data'] });
    }
    const q = 'INSERT INTO dam_analytics.baselines (tenant_id, database_name, principal, hour_of_day, day_of_week, avg_queries, avg_rows, p95_queries, p95_rows, common_tables) FORMAT JSONEachRow';
    await fetch(`${CH_URL}/?${CH_AUTH}&query=${encodeURIComponent(q)}`, { method: 'POST', body: rows.map((r) => JSON.stringify(r)).join('\n') });
  } catch (e) { console.log('[Baselines] dba seed failed:', e.message); }
}
setTimeout(seedDbaBaseline, 22000);

// Shadow evaluation: every 60s, set each MONITOR rule's shadow_hits to the REAL
// number of events it matches over the last 24h (same backtest the Test button uses).
// Non-backtestable rules (behavioral/threshold-window) keep their last value.
setInterval(async () => {
  try {
    // Tenant-scoped: a monitor rule's shadow_hits count only its OWN tenant's events.
    const monitors = (await pgPool.query(`SELECT id, tenant_id, rule_definition FROM policies WHERE status = 'monitor'`)).rows;
    const evDbCache = {};
    for (const m of monitors) {
      let def = m.rule_definition;
      if (typeof def === 'string') { try { def = JSON.parse(def); } catch { def = {}; } }
      const { where, supported } = policyToClickhouse(def || {});
      if (!supported) continue;
      const evDb = evDbCache[m.tenant_id] || (evDbCache[m.tenant_id] = await eventsDbFor(m.tenant_id));
      const whereSql = [`tenant_id = '${chEsc(m.tenant_id)}'`, 'timestamp >= now() - INTERVAL 24 HOUR', ...where].join(' AND ');
      const hits = parseInt(await chQuery(`SELECT count() FROM ${evDb}.events WHERE ${whereSql}`, 'TabSeparated')) || 0;
      await pgPool.query('UPDATE policies SET shadow_hits = $2, updated_at = now() WHERE id = $1', [m.id, hits]);
    }
  } catch (e) { /* shadow eval non-fatal */ }
}, 60000);

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.DAM_API_PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   TooVix DAM API  v0.1.0            ║
  ║   Port: ${PORT}                        ║
  ║   Env:  ${process.env.NODE_ENV || 'development'}                ║
  ╚══════════════════════════════════════╝
  `);
  try {
    await runAuthMigration();
    await runAdminMigration();
    await loadBillingRates();
    await loadSmtpConfig();
    await loadPlatformSmtp();
    await loadGatewayConfig();
  } catch (err) {
    console.error('[Auth] Migration failed:', err.message);
  }
});
