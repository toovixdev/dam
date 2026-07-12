-- db-vm-pg (Postgres on EC2) -> inventory
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY, sku TEXT, name TEXT, price NUMERIC(10,2), stock INT
);
CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY, name TEXT, contact_email TEXT, phone TEXT
);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY, supplier_id INT, product_id INT, qty INT, ordered_at TIMESTAMP DEFAULT now(), status TEXT
);

INSERT INTO products (sku, name, price, stock)
SELECT 'SKU-' || g, 'Product ' || g, round((random() * 500 + 5)::numeric, 2), (random() * 1000)::int
FROM generate_series(1, 200) g;

INSERT INTO suppliers (name, contact_email, phone)
SELECT 'Supplier ' || g, 'supplier' || g || '@example.com', '+91-99' || lpad((random() * 99999999)::int::text, 8, '0')
FROM generate_series(1, 50) g;

INSERT INTO purchase_orders (supplier_id, product_id, qty, status)
SELECT (random() * 49 + 1)::int, (random() * 199 + 1)::int, (random() * 100 + 1)::int,
       (ARRAY['open','received','cancelled'])[(random() * 2 + 1)::int]
FROM generate_series(1, 300) g;
