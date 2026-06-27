-- Client MySQL: Payments database (simulates DB2-PAYMENTS-PROD equivalent)

CREATE TABLE IF NOT EXISTS customers (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    full_name     VARCHAR(120) NOT NULL,
    email         VARCHAR(200),
    phone         VARCHAR(20),
    card_number   VARCHAR(19),
    card_expiry   VARCHAR(5),
    sin           VARCHAR(11),
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    customer_id   INT,
    amount        DECIMAL(12,2),
    currency      VARCHAR(3) DEFAULT 'USD',
    card_last4    VARCHAR(4),
    merchant      VARCHAR(120),
    status        VARCHAR(20) DEFAULT 'approved',
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    action        VARCHAR(50),
    principal     VARCHAR(80),
    table_name    VARCHAR(80),
    row_count     INT,
    ip_address    VARCHAR(45),
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed data (PCI + PII for classification testing)
INSERT INTO customers (full_name, email, phone, card_number, card_expiry, sin) VALUES
('John Smith',       'john@example.com',     '+1-555-123-4567', '4242424242424242', '12/27', '123-456-789'),
('Maria Garcia',     'maria@corp.net',       '+1-555-234-5678', '5100000000003100', '03/28', '234-567-890'),
('Robert Johnson',   'robert.j@mail.com',    '+1-555-345-6789', '378282246310005',  '06/26', '345-678-901'),
('Lisa Wang',        'lisa.w@tech.io',       '+1-555-456-7890', '6011111111111117', '09/27', NULL),
('Mohammed Al-Rashid','mo.rashid@corp.ae',    '+971-50-123-4567','4000056655665556', '01/28', NULL),
('Emily Brown',      'emily.b@company.com',  '+1-555-567-8901', '5200828282828210', '11/27', '456-789-012'),
('Hiroshi Tanaka',   'h.tanaka@corp.jp',     '+81-3-1234-5678', '4242424242424242', '07/28', NULL),
('Sophie Martin',    'sophie.m@mail.fr',     '+33-6-1234-5678', '5100000000003100', '04/27', NULL);

INSERT INTO transactions (customer_id, amount, currency, card_last4, merchant, status) VALUES
(1, 150.00,  'USD', '4242', 'Amazon Web Services',    'approved'),
(1, 49.99,   'USD', '4242', 'Netflix Inc',            'approved'),
(2, 1200.00, 'USD', '3100', 'Apple Store',            'approved'),
(3, 85.50,   'USD', '0005', 'Uber Technologies',      'approved'),
(4, 320.00,  'USD', '1117', 'Google Cloud Platform',  'approved'),
(5, 2500.00, 'AED', '5556', 'Emirates Airlines',      'approved'),
(6, 75.00,   'USD', '8210', 'Spotify AB',             'approved'),
(2, 9999.99, 'USD', '3100', 'Wire Transfer - Offshore','declined'),
(3, 15000.00,'USD', '0005', 'Crypto Exchange XYZ',    'flagged');

INSERT INTO audit_log (action, principal, table_name, row_count, ip_address) VALUES
('SELECT', 'app_payments', 'transactions', 500, '10.0.1.15'),
('SELECT', 'bi_reader',    'customers',    8,   '10.0.2.30'),
('UPDATE', 'app_payments', 'transactions', 1,   '10.0.1.15'),
('SELECT', 'svc_report',   'transactions', 1000,'10.0.3.10');
