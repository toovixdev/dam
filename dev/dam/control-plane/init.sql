-- DAM Control Plane schema

-- Tenants
CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(120) NOT NULL,
    slug            VARCHAR(60) UNIQUE NOT NULL,
    tier            VARCHAR(20) NOT NULL DEFAULT 'professional',
    deployment_type VARCHAR(20) NOT NULL DEFAULT 'saas',
    cloud_provider  VARCHAR(20),
    data_region     VARCHAR(40),
    status          VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Users
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES tenants(id),
    email           VARCHAR(200) UNIQUE NOT NULL,
    full_name       VARCHAR(120) NOT NULL,
    role            VARCHAR(40) NOT NULL DEFAULT 'viewer',
    auth_provider   VARCHAR(40) DEFAULT 'local',
    mfa_enabled     BOOLEAN DEFAULT false,
    status          VARCHAR(20) DEFAULT 'active',
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Registered databases
CREATE TABLE databases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES tenants(id),
    name            VARCHAR(120) NOT NULL,
    engine          VARCHAR(40) NOT NULL,
    version         VARCHAR(20),
    host            VARCHAR(200),
    port            INT,
    deployment_type VARCHAR(20),
    cloud_provider  VARCHAR(20),
    region          VARCHAR(40),
    risk_score      INT DEFAULT 0,
    monitoring_status VARCHAR(20) DEFAULT 'not_monitored',
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Agents
CREATE TABLE agents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    database_id     UUID REFERENCES databases(id),
    tenant_id       UUID REFERENCES tenants(id),
    agent_type      VARCHAR(30) NOT NULL,
    host            VARCHAR(200),
    version         VARCHAR(20),
    status          VARCHAR(20) DEFAULT 'pending',
    last_heartbeat  TIMESTAMPTZ,
    config          JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Policies
CREATE TABLE policies (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES tenants(id),
    name            VARCHAR(120) NOT NULL,
    description     TEXT,
    severity        VARCHAR(20) DEFAULT 'medium',
    status          VARCHAR(20) DEFAULT 'disabled',
    rule_definition JSONB NOT NULL DEFAULT '{}',
    shadow_hits     INT DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Alerts
CREATE TABLE alerts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES tenants(id),
    database_id     UUID REFERENCES databases(id),
    policy_id       UUID REFERENCES policies(id),
    severity        VARCHAR(20) NOT NULL,
    principal       VARCHAR(120),
    summary         TEXT,
    raw_sql         TEXT,
    status          VARCHAR(20) DEFAULT 'open',
    anomaly_score   INT DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT now(),
    resolved_at     TIMESTAMPTZ
);

-- Classification rules
CREATE TABLE classification_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES tenants(id),
    name            VARCHAR(120) NOT NULL,
    detection_target VARCHAR(20) NOT NULL,
    column_pattern  VARCHAR(500),
    data_pattern    VARCHAR(500),
    validator       VARCHAR(40),
    tags            TEXT[] DEFAULT '{}',
    min_confidence  NUMERIC(3,2) DEFAULT 0.85,
    engines         TEXT[] DEFAULT '{all}',
    status          VARCHAR(20) DEFAULT 'shadow',
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Classified columns
CREATE TABLE classified_columns (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES tenants(id),
    database_id     UUID REFERENCES databases(id),
    schema_name     VARCHAR(80),
    table_name      VARCHAR(80),
    column_name     VARCHAR(80),
    data_type       VARCHAR(40),
    tags            TEXT[] DEFAULT '{}',
    confidence      NUMERIC(3,2),
    detection_method VARCHAR(20),
    validator       VARCHAR(40),
    is_masked       BOOLEAN DEFAULT false,
    last_scanned_at TIMESTAMPTZ DEFAULT now()
);

-- DSAR requests
CREATE TABLE dsar_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES tenants(id),
    reference       VARCHAR(20) UNIQUE NOT NULL,
    subject_name    VARCHAR(120) NOT NULL,
    subject_identifier VARCHAR(200) NOT NULL,
    request_type    VARCHAR(40) NOT NULL,
    regulation      VARCHAR(40) NOT NULL,
    status          VARCHAR(20) DEFAULT 'discovering',
    deadline        DATE NOT NULL,
    databases_found INT DEFAULT 0,
    columns_found   INT DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT now(),
    fulfilled_at    TIMESTAMPTZ
);

-- Integration configs
CREATE TABLE integrations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES tenants(id),
    name            VARCHAR(80) NOT NULL,
    type            VARCHAR(40) NOT NULL,
    config          JSONB NOT NULL DEFAULT '{}',
    status          VARCHAR(20) DEFAULT 'inactive',
    last_sync_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Audit trail (immutable)
CREATE TABLE audit_trail (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID,
    actor_id        UUID,
    actor_email     VARCHAR(200),
    action          VARCHAR(80) NOT NULL,
    resource_type   VARCHAR(40),
    resource_id     UUID,
    details         JSONB DEFAULT '{}',
    ip_address      INET,
    prev_hash       VARCHAR(64),
    row_hash        VARCHAR(64),
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Seed: dev tenant
INSERT INTO tenants (name, slug, tier, deployment_type, cloud_provider, data_region) VALUES
('Meridian Financial Group', 'meridian-fg', 'enterprise', 'saas', 'azure', 'East US');

-- Seed: dev user
INSERT INTO users (tenant_id, email, full_name, role, auth_provider, mfa_enabled, status) VALUES
((SELECT id FROM tenants LIMIT 1), 'admin@meridian-fg.com', 'Sarah Chen', 'tenant_admin', 'local', true, 'active');

-- Seed: databases
INSERT INTO databases (tenant_id, name, engine, version, host, port, deployment_type, cloud_provider, region, risk_score, monitoring_status) VALUES
((SELECT id FROM tenants LIMIT 1), 'PG-CRM-PROD',       'postgresql', '16',    'client-postgres', 5432,  'iaas',   NULL,    'US-East', 52, 'monitored'),
((SELECT id FROM tenants LIMIT 1), 'MYSQL-PAYMENTS-PROD','mysql',     '8.0',   'client-mysql',    3306,  'iaas',   NULL,    'US-East', 79, 'monitored'),
((SELECT id FROM tenants LIMIT 1), 'MONGO-PROFILES-UK',  'mongodb',   '7.0',   'client-mongo',    27017, 'iaas',   NULL,    'EU-West', 45, 'monitored');
