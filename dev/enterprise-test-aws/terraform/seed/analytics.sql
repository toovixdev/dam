-- db-paas-pg (RDS Postgres) -> analytics
-- customers carries PII (email, ssn) so the DAM has sensitive columns to classify.
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY, name TEXT, email TEXT, ssn TEXT, created_at TIMESTAMP DEFAULT now()
);
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY, customer_id INT, event_type TEXT, ts TIMESTAMP DEFAULT now(), amount NUMERIC(10,2)
);

INSERT INTO customers (name, email, ssn)
SELECT 'Customer ' || g, 'customer' || g || '@example.com',
       lpad((random() * 999)::int::text, 3, '0') || '-' || lpad((random() * 99)::int::text, 2, '0') || '-' || lpad((random() * 9999)::int::text, 4, '0')
FROM generate_series(1, 200) g;

INSERT INTO events (customer_id, event_type, amount)
SELECT (random() * 199 + 1)::int, (ARRAY['login','purchase','refund','view'])[(random() * 3 + 1)::int], round((random() * 1000)::numeric, 2)
FROM generate_series(1, 500) g;
