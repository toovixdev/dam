const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

// ── Database connections ──────────────────────────────────
const pgPool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  user: process.env.PG_USER || 'dam_admin',
  password: process.env.PG_PASSWORD || 'dam_control_secret',
  database: process.env.PG_DATABASE || 'dam_control',
  max: 10,
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

// ── Databases ─────────────────────────────────────────────
app.get('/api/databases', async (req, res) => {
  const { rows } = await pgPool.query(
    'SELECT id, name, engine, version, host, port, deployment_type, cloud_provider, region, risk_score, monitoring_status, created_at FROM databases ORDER BY name'
  );
  res.json(rows);
});

app.post('/api/databases', async (req, res) => {
  const { name, engine, version, host, port, deployment_type, cloud_provider, region } = req.body;
  const tenantId = req.headers['x-tenant-id'];
  const { rows } = await pgPool.query(
    `INSERT INTO databases (tenant_id, name, engine, version, host, port, deployment_type, cloud_provider, region)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [tenantId, name, engine, version, host, port, deployment_type, cloud_provider, region]
  );
  res.status(201).json(rows[0]);
});

// ── Agents ────────────────────────────────────────────────
app.get('/api/agents', async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT a.*, d.name as database_name FROM agents a
     JOIN databases d ON a.database_id = d.id
     ORDER BY a.created_at DESC`
  );
  res.json(rows);
});

app.post('/api/agents', async (req, res) => {
  const { database_id, agent_type, host, config } = req.body;
  const tenantId = req.headers['x-tenant-id'];
  const { rows } = await pgPool.query(
    `INSERT INTO agents (tenant_id, database_id, agent_type, host, config, status)
     VALUES ($1, $2, $3, $4, $5, 'online') RETURNING *`,
    [tenantId, database_id, agent_type, host, JSON.stringify(config || {})]
  );
  res.status(201).json(rows[0]);
});

// ── Alerts ────────────────────────────────────────────────
app.get('/api/alerts', async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT a.*, d.name as database_name FROM alerts a
     LEFT JOIN databases d ON a.database_id = d.id
     ORDER BY a.created_at DESC LIMIT 100`
  );
  res.json(rows);
});

// ── Policies ──────────────────────────────────────────────
app.get('/api/policies', async (req, res) => {
  const { rows } = await pgPool.query(
    'SELECT * FROM policies ORDER BY created_at DESC'
  );
  res.json(rows);
});

// ── Classification ────────────────────────────────────────
app.get('/api/classification/columns', async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT cc.*, d.name as database_name FROM classified_columns cc
     JOIN databases d ON cc.database_id = d.id
     ORDER BY cc.confidence DESC`
  );
  res.json(rows);
});

// ── DSAR ──────────────────────────────────────────────────
app.get('/api/dsar', async (req, res) => {
  const { rows } = await pgPool.query(
    'SELECT * FROM dsar_requests ORDER BY created_at DESC'
  );
  res.json(rows);
});

app.post('/api/dsar', async (req, res) => {
  const { subject_name, subject_identifier, request_type, regulation } = req.body;
  const tenantId = req.headers['x-tenant-id'];
  const ref = 'DSAR-' + String(Math.floor(Math.random() * 9000) + 1000);
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + 30);
  const { rows } = await pgPool.query(
    `INSERT INTO dsar_requests (tenant_id, reference, subject_name, subject_identifier, request_type, regulation, deadline)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [tenantId, ref, subject_name, subject_identifier, request_type, regulation, deadline]
  );
  res.status(201).json(rows[0]);
});

// ── Users ─────────────────────────────────────────────────
app.get('/api/users', async (req, res) => {
  const { rows } = await pgPool.query(
    'SELECT id, email, full_name, role, auth_provider, mfa_enabled, status, last_login_at, created_at FROM users ORDER BY created_at'
  );
  res.json(rows);
});

// ── Audit trail ───────────────────────────────────────────
app.get('/api/audit', async (req, res) => {
  const { rows } = await pgPool.query(
    'SELECT * FROM audit_trail ORDER BY created_at DESC LIMIT 100'
  );
  res.json(rows);
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

// Simulate live alert push every 30-60s
setInterval(() => {
  const severities = ['critical', 'high', 'medium', 'low'];
  const principals = ['bi_reader', 'app_crm', 'svc_analytics', 'dba_admin', 'temp_user'];
  const databases = ['PG-CRM-PROD', 'MYSQL-PAYMENTS-PROD', 'MONGO-PROFILES-UK'];
  const summaries = [
    'Bulk PII export exceeding baseline',
    'Login from new geographic location',
    'Privileged operation outside change window',
    'Service account accessing sensitive columns',
    'Failed login attempts threshold exceeded',
  ];

  broadcast({
    type: 'alert',
    alert: {
      severity: severities[Math.floor(Math.random() * severities.length)],
      principal: principals[Math.floor(Math.random() * principals.length)],
      database: databases[Math.floor(Math.random() * databases.length)],
      summary: summaries[Math.floor(Math.random() * summaries.length)],
      anomaly_score: Math.floor(Math.random() * 60) + 40,
      timestamp: new Date().toISOString(),
    },
  });
}, 30000 + Math.floor(Math.random() * 30000));

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.DAM_API_PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   TooVix DAM API  v0.1.0            ║
  ║   Port: ${PORT}                        ║
  ║   Env:  ${process.env.NODE_ENV || 'development'}                ║
  ╚══════════════════════════════════════╝
  `);
});
