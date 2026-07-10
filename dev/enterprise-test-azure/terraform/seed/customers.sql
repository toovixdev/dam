-- db-vm-b → customers (customer master; PII-heavy: name, email, phone, dob, Aadhaar, PAN)
USE customers;

CREATE TABLE IF NOT EXISTS customers (
  id INT PRIMARY KEY AUTO_INCREMENT, full_name VARCHAR(120), email VARCHAR(120), phone VARCHAR(20),
  dob DATE, aadhaar CHAR(12), pan CHAR(10), address VARCHAR(200), created_at DATETIME
);
CREATE TABLE IF NOT EXISTS kyc_documents (
  id INT PRIMARY KEY AUTO_INCREMENT, customer_id INT, doc_type VARCHAR(30), doc_number VARCHAR(40), status VARCHAR(20)
);
CREATE TABLE IF NOT EXISTS consents (
  id INT PRIMARY KEY AUTO_INCREMENT, customer_id INT, purpose VARCHAR(60), granted TINYINT, ts DATETIME
);

INSERT INTO customers (full_name,email,phone,dob,aadhaar,pan,address,created_at)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<200)
SELECT CONCAT('Customer ',n), CONCAT('user',n,'@example.com'),
       CONCAT('9',LPAD(FLOOR(RAND()*1000000000),9,'0')),
       DATE_SUB('2001-01-01', INTERVAL FLOOR(RAND()*14000) DAY),
       LPAD(FLOOR(RAND()*1000000000000),12,'0'),
       CONCAT('ABCDE',LPAD(n,4,'0'),'F'),
       CONCAT(FLOOR(RAND()*999),' Park Ave, Metro City'),
       NOW() FROM s;

INSERT INTO kyc_documents (customer_id,doc_type,doc_number,status)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<200)
SELECT n, ELT(1+FLOOR(RAND()*3),'passport','aadhaar','pan'),
       CONCAT('DOC',LPAD(FLOOR(RAND()*100000000),9,'0')),
       ELT(1+FLOOR(RAND()*3),'pending','verified','rejected') FROM s;

INSERT INTO consents (customer_id,purpose,granted,ts)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<200)
SELECT n, ELT(1+FLOOR(RAND()*3),'marketing','kyc','analytics'), FLOOR(RAND()*2), NOW() FROM s;
