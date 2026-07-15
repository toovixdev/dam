-- Sensitive-data seed for the SQL Server VM — PII / PCI / financial columns for
-- testing classification & audit. Idempotent (safe to re-run).

IF DB_ID('SensitiveTestDB') IS NULL EXEC('CREATE DATABASE SensitiveTestDB');
GO
USE SensitiveTestDB;
GO

-- ── PII: names, emails, national IDs, DOB, address ────────────────────────────
IF OBJECT_ID('dbo.customers') IS NULL
CREATE TABLE dbo.customers (
  id            INT IDENTITY PRIMARY KEY,
  full_name     NVARCHAR(100),
  email         NVARCHAR(100),
  phone         NVARCHAR(20),
  aadhaar       CHAR(14),      -- India national ID (PII)
  pan           CHAR(10),      -- India tax ID (PII)
  ssn           CHAR(11),      -- US SSN (PII)
  date_of_birth DATE,
  address       NVARCHAR(200)
);
GO
IF NOT EXISTS (SELECT 1 FROM dbo.customers)
INSERT INTO dbo.customers (full_name,email,phone,aadhaar,pan,ssn,date_of_birth,address) VALUES
 ('Asha Rao','asha.rao@example.com','+91-9990001111','1234-5678-9012','ABCPR1234K','123-45-6789','1990-04-12','40 MG Road, Bengaluru'),
 ('Ravi Kumar','ravi.k@example.com','+91-9990002222','2345-6789-0123','PQRSK4567L','234-56-7890','1985-11-03','591 Anna Salai, Chennai'),
 ('Meera Nair','meera.nair@example.com','+91-9990003333','3456-7890-1234','LMNOP7890M','345-67-8901','1993-07-21','12 Marine Drive, Mumbai');
GO

-- ── PCI: card number, CVV, expiry, cardholder ─────────────────────────────────
IF OBJECT_ID('dbo.payments') IS NULL
CREATE TABLE dbo.payments (
  id           INT IDENTITY PRIMARY KEY,
  customer_id  INT,
  cardholder   NVARCHAR(100),
  card_number  CHAR(16),      -- PCI
  cvv          CHAR(4),       -- PCI
  card_expiry  CHAR(5),       -- PCI
  amount       DECIMAL(10,2),
  txn_date     DATETIME
);
GO
IF NOT EXISTS (SELECT 1 FROM dbo.payments)
INSERT INTO dbo.payments (customer_id,cardholder,card_number,cvv,card_expiry,amount,txn_date) VALUES
 (1,'Asha Rao','4111111111111111','123','12/28',291.32,'2026-05-01'),
 (2,'Ravi Kumar','5500000000000004','456','01/27',850.52,'2026-05-14'),
 (3,'Meera Nair','3400000000000009','7890','09/29',110.40,'2026-06-02');
GO

-- ── Other sensitive: bank account, IFSC, passport, salary ─────────────────────
IF OBJECT_ID('dbo.accounts') IS NULL
CREATE TABLE dbo.accounts (
  id              INT IDENTITY PRIMARY KEY,
  customer_id     INT,
  bank_account_no VARCHAR(20),
  ifsc_code       CHAR(11),
  passport_no     CHAR(9),
  annual_salary   DECIMAL(12,2)
);
GO
IF NOT EXISTS (SELECT 1 FROM dbo.accounts)
INSERT INTO dbo.accounts (customer_id,bank_account_no,ifsc_code,passport_no,annual_salary) VALUES
 (1,'50100123456789','HDFC0001234','M1234567',1850000.00),
 (2,'50100987654321','ICIC0005678','N7654321',1420000.00),
 (3,'50100555544443','SBIN0009012','P9988776',2100000.00);
GO
