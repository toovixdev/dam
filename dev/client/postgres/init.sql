-- Client PostgreSQL: CRM database (simulates PG-CRM-PROD)

CREATE SCHEMA IF NOT EXISTS crm;

CREATE TABLE crm.contacts (
    id            SERIAL PRIMARY KEY,
    full_name     VARCHAR(120) NOT NULL,
    email         VARCHAR(200) NOT NULL,
    phone         VARCHAR(20),
    address       TEXT,
    ssn           VARCHAR(11),
    date_of_birth DATE,
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE crm.orders (
    id            SERIAL PRIMARY KEY,
    contact_id    INT REFERENCES crm.contacts(id),
    amount        NUMERIC(12,2),
    currency      VARCHAR(3) DEFAULT 'USD',
    status        VARCHAR(20) DEFAULT 'pending',
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE crm.notes (
    id            SERIAL PRIMARY KEY,
    contact_id    INT REFERENCES crm.contacts(id),
    author        VARCHAR(80),
    body          TEXT,
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- Seed data (PII for classification testing)
INSERT INTO crm.contacts (full_name, email, phone, address, ssn, date_of_birth) VALUES
('John Smith',       'john.smith@example.com',    '+1-555-123-4567', '123 Main St, New York, NY 10001',   '123-45-6789', '1985-03-14'),
('Maria Garcia',     'maria.garcia@corp.net',     '+1-555-234-5678', '456 Oak Ave, Chicago, IL 60601',    '234-56-7890', '1992-11-28'),
('Raj Kumar Patel',  'raj.patel@mail.co',         '+91-98765-43210', '78 MG Road, Mumbai 400001',         NULL,          '1988-06-15'),
('Sarah Chen',       'sarah.chen@tech.io',        '+1-555-345-6789', '789 Pine St, San Francisco, CA',    '345-67-8901', '1990-01-22'),
('Hans Mueller',     'hans.m@example.de',         '+49-30-1234567',  'Hauptstr. 10, Berlin 10115',        NULL,          '1978-09-03'),
('Priya Nair',       'priya.nair@example.in',     '+91-87654-32109', '22 Nehru Nagar, Kochi 682001',      NULL,          '1995-07-19'),
('James Wilson',     'james.w@company.com',       '+1-555-456-7890', '321 Elm Blvd, Austin, TX 78701',    '456-78-9012', '1982-12-01'),
('Ananya Rao',       'ananya.rao@example.in',     '+91-76543-21098', '15 Gandhi Path, Bangalore 560001',  NULL,          '1993-04-11'),
('David Laurent',    'david.l@corp.fr',           '+33-1-2345-6789', '5 Rue de Rivoli, Paris 75001',      NULL,          '1987-08-25'),
('Kavya Menon',      'kavya.m@mail.co',           '+91-65432-10987', '8 Anna Salai, Chennai 600001',      NULL,          '1991-02-14');

INSERT INTO crm.orders (contact_id, amount, currency, status) VALUES
(1, 1250.00, 'USD', 'completed'),
(1, 340.50,  'USD', 'completed'),
(2, 8900.00, 'USD', 'pending'),
(3, 45000.00,'INR', 'completed'),
(4, 2100.00, 'USD', 'completed'),
(5, 780.00,  'EUR', 'pending'),
(6, 32000.00,'INR', 'completed'),
(7, 560.00,  'USD', 'completed'),
(8, 28000.00,'INR', 'pending'),
(9, 1100.00, 'EUR', 'completed');

INSERT INTO crm.notes (contact_id, author, body) VALUES
(1, 'support_agent', 'Customer called about billing issue. Resolved.'),
(2, 'sales_rep',     'Interested in enterprise plan upgrade.'),
(3, 'support_agent', 'KYC verification completed successfully.'),
(5, 'compliance',    'GDPR data access request fulfilled - Art.15');

-- Create read-only user for BI (simulates bi_reader principal)
CREATE USER bi_reader WITH PASSWORD 'bi_readonly_123';
GRANT USAGE ON SCHEMA crm TO bi_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA crm TO bi_reader;

-- Create service account (simulates svc_analytics)
CREATE USER svc_analytics WITH PASSWORD 'analytics_svc_123';
GRANT USAGE ON SCHEMA crm TO svc_analytics;
GRANT SELECT ON ALL TABLES IN SCHEMA crm TO svc_analytics;
