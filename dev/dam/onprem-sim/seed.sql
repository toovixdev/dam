-- Seed the simulated on-prem database with a realistic app schema that carries
-- sensitive data (PII + PCI), some rows, and the two logins the demo uses.
-- Loaded by setup-onprem.sh via `sudo mysql < seed.sql`.
CREATE DATABASE IF NOT EXISTS appdb;
USE appdb;

CREATE TABLE customers (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  full_name  VARCHAR(100),
  email      VARCHAR(120),
  phone      VARCHAR(20),
  pan        VARCHAR(10),          -- India PAN (PII)
  aadhaar    CHAR(12),             -- Aadhaar number (PII)
  city       VARCHAR(60),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cards (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT,
  card_number VARCHAR(19),         -- PAN / cardholder data (PCI)
  cvv         CHAR(4),
  expiry      CHAR(5)
);

CREATE TABLE orders (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT,
  amount      DECIMAL(10,2),
  status      VARCHAR(20),
  placed_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO customers (full_name,email,phone,pan,aadhaar,city) VALUES
 ('Asha Rao',   'asha.rao@example.com',   '9812345670','ABCPR1234K','123412341234','Bengaluru'),
 ('Vikram Nair','vikram.nair@example.com','9800011122','XYZPN5678L','567856785678','Mumbai'),
 ('Priya Menon','priya.menon@example.com','9765432100','LMNPM9012M','901290129012','Chennai'),
 ('Rahul Das',  'rahul.das@example.com',  '9700099887','QRSPD3456N','345634563456','Kolkata'),
 ('Sara Khan',  'sara.khan@example.com',  '9611122233','TUVPK7890P','789078907890','Hyderabad');

INSERT INTO cards (customer_id,card_number,cvv,expiry) VALUES
 (1,'4111 1111 1111 1111','123','06/28'),
 (2,'5500 0000 0000 0004','456','09/27'),
 (3,'3400 0000 0000 009', '789','12/26');

INSERT INTO orders (customer_id,amount,status) VALUES
 (1,1299.00,'paid'),(2,499.50,'paid'),(3,89.99,'refunded'),(4,2500.00,'paid'),(5,150.00,'pending');

-- Read-only monitoring login DAM uses for classification (PII/PCI column discovery).
CREATE USER 'dam_svc'@'%' IDENTIFIED WITH mysql_native_password BY 'dam_svc_secret';
GRANT SELECT, PROCESS ON *.* TO 'dam_svc'@'%';

-- An ordinary application login used to generate realistic activity (see gen-traffic.sh).
CREATE USER 'appuser'@'%' IDENTIFIED WITH mysql_native_password BY 'app_secret';
GRANT SELECT, INSERT, UPDATE, DELETE ON appdb.* TO 'appuser'@'%';

FLUSH PRIVILEGES;
