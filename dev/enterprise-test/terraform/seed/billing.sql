-- db-paas (Cloud SQL) → billing (payments; PCI: card_number, cvv)
USE billing;

CREATE TABLE IF NOT EXISTS invoices (
  id INT PRIMARY KEY AUTO_INCREMENT, customer_ref INT, amount DECIMAL(10,2), currency CHAR(3), issued_at DATE, status VARCHAR(20)
);
CREATE TABLE IF NOT EXISTS cards (
  id INT PRIMARY KEY AUTO_INCREMENT, customer_ref INT, cardholder_name VARCHAR(120),
  card_number VARCHAR(19), expiry CHAR(7), cvv CHAR(4)
);
CREATE TABLE IF NOT EXISTS payments (
  id INT PRIMARY KEY AUTO_INCREMENT, invoice_id INT, method VARCHAR(20), amount DECIMAL(10,2), paid_at DATETIME
);
CREATE TABLE IF NOT EXISTS transactions (
  id INT PRIMARY KEY AUTO_INCREMENT, card_id INT, amount DECIMAL(10,2), merchant VARCHAR(60), ts DATETIME, status VARCHAR(20)
);

INSERT INTO invoices (customer_ref,amount,currency,issued_at,status)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<200)
SELECT 1+FLOOR(RAND()*200), ROUND(RAND()*2000+10,2), 'USD',
       DATE_SUB(CURDATE(), INTERVAL FLOOR(RAND()*365) DAY),
       ELT(1+FLOOR(RAND()*3),'paid','due','overdue') FROM s;

INSERT INTO cards (customer_ref,cardholder_name,card_number,expiry,cvv)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<120)
SELECT n, CONCAT('Customer ',n),
       CONCAT('4111', LPAD(FLOOR(RAND()*1000000000000),12,'0')),
       CONCAT(LPAD(1+FLOOR(RAND()*12),2,'0'),'/20',LPAD(6+FLOOR(RAND()*5),2,'0')),
       LPAD(FLOOR(RAND()*1000),3,'0') FROM s;

INSERT INTO payments (invoice_id,method,amount,paid_at)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<150)
SELECT 1+FLOOR(RAND()*200), ELT(1+FLOOR(RAND()*3),'card','ach','wire'),
       ROUND(RAND()*2000+10,2), NOW() FROM s;

INSERT INTO transactions (card_id,amount,merchant,ts,status)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<300)
SELECT 1+FLOOR(RAND()*120), ROUND(RAND()*500+1,2),
       ELT(1+FLOOR(RAND()*5),'Amazon','Walmart','Uber','Starbucks','Apple'),
       NOW(), ELT(1+FLOOR(RAND()*3),'approved','declined','pending') FROM s;
