-- db-win-mssql (SQL Server 2022) -> salesdb
-- Sales + PCI data (card_number, cvv) and PII (email) so the DAM has sensitive
-- objects to classify and alert on, mirroring the MySQL 'billing' seed.

IF OBJECT_ID('dbo.customers') IS NULL
CREATE TABLE dbo.customers (
  id INT IDENTITY PRIMARY KEY, name NVARCHAR(120), email NVARCHAR(160), created_at DATETIME
);
IF OBJECT_ID('dbo.cards') IS NULL
CREATE TABLE dbo.cards (
  id INT IDENTITY PRIMARY KEY, customer_ref INT, cardholder_name NVARCHAR(120),
  card_number VARCHAR(19), expiry CHAR(7), cvv CHAR(4)
);
IF OBJECT_ID('dbo.orders') IS NULL
CREATE TABLE dbo.orders (
  id INT IDENTITY PRIMARY KEY, customer_ref INT, amount DECIMAL(10,2), status VARCHAR(20), ordered_at DATETIME
);
IF OBJECT_ID('dbo.transactions') IS NULL
CREATE TABLE dbo.transactions (
  id INT IDENTITY PRIMARY KEY, card_id INT, amount DECIMAL(10,2), merchant VARCHAR(60), ts DATETIME, status VARCHAR(20)
);

-- customers (200)
;WITH n AS (SELECT TOP (200) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS r FROM sys.all_objects a CROSS JOIN sys.all_objects b)
INSERT INTO dbo.customers (name, email, created_at)
SELECT CONCAT('Customer ', r), CONCAT('customer', r, '@example.com'),
       DATEADD(DAY, -(ABS(CHECKSUM(NEWID())) % 365), GETDATE())
FROM n;

-- cards (120) — PCI: card_number + cvv
;WITH n AS (SELECT TOP (120) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS r FROM sys.all_objects a CROSS JOIN sys.all_objects b)
INSERT INTO dbo.cards (customer_ref, cardholder_name, card_number, expiry, cvv)
SELECT r, CONCAT('Customer ', r),
       '4111' + RIGHT('000000000000' + CAST(ABS(CHECKSUM(NEWID())) % 1000000000000 AS VARCHAR(12)), 12),
       RIGHT('0' + CAST(1 + ABS(CHECKSUM(NEWID())) % 12 AS VARCHAR(2)), 2) + '/20' + RIGHT('0' + CAST(6 + ABS(CHECKSUM(NEWID())) % 5 AS VARCHAR(2)), 2),
       RIGHT('000' + CAST(ABS(CHECKSUM(NEWID())) % 1000 AS VARCHAR(3)), 3)
FROM n;

-- orders (300)
;WITH n AS (SELECT TOP (300) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS r FROM sys.all_objects a CROSS JOIN sys.all_objects b)
INSERT INTO dbo.orders (customer_ref, amount, status, ordered_at)
SELECT 1 + ABS(CHECKSUM(NEWID())) % 200, CAST(ABS(CHECKSUM(NEWID())) % 2000 + 10 AS DECIMAL(10,2)),
       CASE ABS(CHECKSUM(NEWID())) % 3 WHEN 0 THEN 'paid' WHEN 1 THEN 'due' ELSE 'overdue' END,
       DATEADD(DAY, -(ABS(CHECKSUM(NEWID())) % 365), GETDATE())
FROM n;

-- transactions (300)
;WITH n AS (SELECT TOP (300) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS r FROM sys.all_objects a CROSS JOIN sys.all_objects b)
INSERT INTO dbo.transactions (card_id, amount, merchant, ts, status)
SELECT 1 + ABS(CHECKSUM(NEWID())) % 120, CAST(ABS(CHECKSUM(NEWID())) % 500 + 1 AS DECIMAL(10,2)),
       CASE ABS(CHECKSUM(NEWID())) % 5 WHEN 0 THEN 'Amazon' WHEN 1 THEN 'Walmart' WHEN 2 THEN 'Uber' WHEN 3 THEN 'Starbucks' ELSE 'Apple' END,
       GETDATE(), CASE ABS(CHECKSUM(NEWID())) % 3 WHEN 0 THEN 'approved' WHEN 1 THEN 'declined' ELSE 'pending' END
FROM n;
