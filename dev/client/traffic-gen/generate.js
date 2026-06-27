const { Client: PgClient } = require('pg');
const mysql = require('mysql2/promise');
const { MongoClient } = require('mongodb');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const ts = () => new Date().toTimeString().slice(0, 8);

// ── PostgreSQL queries ──────────────────────────────────────
const PG_QUERIES = [
  { label: 'SELECT contact by id',               sql: () => `SELECT id, full_name, email FROM crm.contacts WHERE id = ${randInt(1,10)}`, user: 'app_crm' },
  { label: 'BULK SELECT contacts (SSN exposed)',  sql: () => `SELECT full_name, email, phone, ssn FROM crm.contacts LIMIT 100`, user: 'bi_reader' },
  { label: 'SELECT completed orders',             sql: () => `SELECT o.id, o.amount, c.full_name FROM crm.orders o JOIN crm.contacts c ON o.contact_id = c.id WHERE o.status = 'completed'`, user: 'app_crm' },
  { label: 'Aggregate orders by currency',        sql: () => `SELECT COUNT(*), SUM(amount) FROM crm.orders GROUP BY currency`, user: 'svc_analytics' },
  { label: 'INSERT new order',                    sql: () => `INSERT INTO crm.orders (contact_id, amount, currency, status) VALUES (${randInt(1,10)}, ${randInt(10,5000)}.99, 'USD', 'pending')`, user: 'app_crm' },
  { label: 'UPDATE contact timestamp',            sql: () => `UPDATE crm.contacts SET updated_at = now() WHERE id = ${randInt(1,10)}`, user: 'app_crm' },
];

// ── MySQL queries ───────────────────────────────────────────
const MYSQL_QUERIES = [
  { label: 'SELECT transactions',                sql: () => `SELECT id, amount, merchant, status FROM transactions WHERE customer_id = ${randInt(1,8)} LIMIT 5` },
  { label: 'SELECT card_number (PCI!)',           sql: () => `SELECT full_name, card_number, card_expiry FROM customers WHERE id = ${randInt(1,8)}` },
  { label: 'INSERT transaction',                  sql: () => `INSERT INTO transactions (customer_id, amount, card_last4, merchant, status) VALUES (${randInt(1,8)}, ${randInt(10,500)}.50, '4242', 'Test Merchant', 'approved')` },
  { label: 'Audit log write',                     sql: () => `INSERT INTO audit_log (action, principal, table_name, row_count, ip_address) VALUES ('SELECT', 'app_payments', 'transactions', ${randInt(1,100)}, '10.0.1.${randInt(1,254)}')` },
  { label: 'SELECT SIN numbers (PII!)',           sql: () => `SELECT full_name, sin FROM customers WHERE sin IS NOT NULL` },
];

// ── MongoDB queries ─────────────────────────────────────────
const MONGO_QUERIES = [
  { label: 'Find user by email',          fn: (db) => db.collection('users').findOne({ email: 'oliver.w@example.co.uk' }, { projection: { full_name: 1, email: 1 } }) },
  { label: 'Query Aadhaar+PAN (PII!)',    fn: (db) => db.collection('users').find({ aadhaar: { $ne: null } }, { projection: { full_name: 1, aadhaar: 1, pan_number: 1 } }).toArray() },
  { label: 'Verified KYC docs',           fn: (db) => db.collection('kyc_documents').find({ status: 'verified' }).toArray() },
  { label: 'Activity log write',          fn: (db) => db.collection('activity_log').insertOne({ user_email: 'oliver.w@example.co.uk', action: 'login', ip: '82.132.1.10', ts: new Date() }) },
];

async function main() {
  console.log('=== TooVix DAM Traffic Generator ===');
  console.log('Waiting 12s for databases...\n');
  await sleep(12000);

  // Connect PostgreSQL (multiple users)
  const pgConns = {};
  for (const user of ['app_crm', 'bi_reader', 'svc_analytics']) {
    const pw = user === 'app_crm' ? process.env.PG_PASSWORD : (user === 'bi_reader' ? 'bi_readonly_123' : 'analytics_svc_123');
    try {
      const c = new PgClient({ host: process.env.PG_HOST, user, password: pw, database: 'crm' });
      await c.connect();
      pgConns[user] = c;
      console.log(`[PG] Connected as ${user}`);
    } catch (e) {
      console.log(`[PG] Failed to connect as ${user}: ${e.message}`);
    }
  }

  // Connect MySQL
  let mysqlConn;
  try {
    mysqlConn = await mysql.createConnection({
      host: process.env.MYSQL_HOST,
      user: 'app_payments',
      password: process.env.MYSQL_PASSWORD,
      database: 'payments',
    });
    console.log('[MySQL] Connected as app_payments');
  } catch (e) {
    console.log(`[MySQL] Failed: ${e.message}`);
  }

  // Connect MongoDB
  let mongoDB;
  try {
    const mongoClient = new MongoClient(`mongodb://admin:${process.env.MONGO_PASSWORD}@${process.env.MONGO_HOST}:27017/profiles?authSource=admin`);
    await mongoClient.connect();
    mongoDB = mongoClient.db('profiles');
    console.log('[MongoDB] Connected');
  } catch (e) {
    console.log(`[MongoDB] Failed: ${e.message}`);
  }

  console.log('\n--- Traffic generation started ---\n');

  let counter = 0;

  while (true) {
    counter++;

    // PostgreSQL
    const pgQ = pick(PG_QUERIES);
    const pgConn = pgConns[pgQ.user];
    if (pgConn) {
      try {
        await pgConn.query(pgQ.sql());
        console.log(`[${ts()}] PG    | ${pgQ.user.padEnd(14)} | ${pgQ.label}`);
      } catch (e) { /* ignore */ }
    }

    await sleep(randInt(1000, 3000));

    // MySQL
    if (mysqlConn) {
      const myQ = pick(MYSQL_QUERIES);
      try {
        await mysqlConn.query(myQ.sql());
        console.log(`[${ts()}] MySQL | ${'app_payments'.padEnd(14)} | ${myQ.label}`);
      } catch (e) { /* ignore */ }
    }

    await sleep(randInt(1000, 3000));

    // MongoDB
    if (mongoDB) {
      const mgQ = pick(MONGO_QUERIES);
      try {
        await mgQ.fn(mongoDB);
        console.log(`[${ts()}] Mongo | ${'app_profiles'.padEnd(14)} | ${mgQ.label}`);
      } catch (e) { /* ignore */ }
    }

    await sleep(randInt(2000, 5000));

    // Anomaly every ~20 iterations
    if (counter % 20 === 0 && pgConns['bi_reader']) {
      console.log(`\n[${ts()}] *** ANOMALY: bi_reader bulk export of SSN + DOB + address ***`);
      try {
        await pgConns['bi_reader'].query('SELECT full_name, email, phone, ssn, date_of_birth, address FROM crm.contacts');
      } catch (e) { /* ignore */ }
      console.log('');
    }
  }
}

main().catch(console.error);
