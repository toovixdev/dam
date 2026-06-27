-- ClickHouse analytics schema (per-tenant, hot 90-day rolling)

CREATE DATABASE IF NOT EXISTS dam_analytics;

-- Main event store: every SQL statement captured by agents
CREATE TABLE IF NOT EXISTS dam_analytics.events (
    tenant_id       String,
    database_name   String,
    event_id        UUID DEFAULT generateUUIDv4(),
    timestamp       DateTime64(3) DEFAULT now64(),
    principal       String,
    client_ip       String,
    operation       LowCardinality(String),    -- SELECT, INSERT, UPDATE, DELETE, DDL, LOGIN, LOGOUT
    schema_name     String,
    table_name      String,
    columns_accessed Array(String),
    row_count       UInt64 DEFAULT 0,
    sql_hash        String,
    sql_text        String,
    duration_ms     UInt32 DEFAULT 0,
    anomaly_score   UInt8 DEFAULT 0,
    tags            Array(String),
    agent_type      LowCardinality(String),    -- host_ebpf, network, cloud_push, audit_pull, inline_proxy
    source_host     String
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, database_name, timestamp)
TTL toDateTime(timestamp) + INTERVAL 90 DAY;

-- Session tracking
CREATE TABLE IF NOT EXISTS dam_analytics.sessions (
    tenant_id       String,
    database_name   String,
    session_id      String,
    principal       String,
    client_ip       String,
    connected_at    DateTime64(3),
    disconnected_at Nullable(DateTime64(3)),
    query_count     UInt32 DEFAULT 0,
    rows_read       UInt64 DEFAULT 0,
    rows_written    UInt64 DEFAULT 0,
    anomaly_score   UInt8 DEFAULT 0,
    status          LowCardinality(String) DEFAULT 'active'
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(connected_at)
ORDER BY (tenant_id, database_name, connected_at);

-- Aggregated baselines (for anomaly detection)
CREATE TABLE IF NOT EXISTS dam_analytics.baselines (
    tenant_id       String,
    database_name   String,
    principal       String,
    hour_of_day     UInt8,
    day_of_week     UInt8,
    avg_queries     Float64,
    avg_rows        Float64,
    p95_queries     Float64,
    p95_rows        Float64,
    common_tables   Array(String),
    updated_at      DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, database_name, principal, hour_of_day, day_of_week);

-- Alert events (denormalized for fast dashboard queries)
CREATE TABLE IF NOT EXISTS dam_analytics.alert_events (
    tenant_id       String,
    alert_id        String,
    database_name   String,
    severity        LowCardinality(String),
    principal       String,
    policy_name     String,
    summary         String,
    anomaly_score   UInt8,
    status          LowCardinality(String),
    created_at      DateTime64(3) DEFAULT now64()
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, created_at);

-- Materialized view: events per hour per database (for dashboards)
CREATE MATERIALIZED VIEW IF NOT EXISTS dam_analytics.events_hourly
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (tenant_id, database_name, principal, hour)
AS SELECT
    tenant_id,
    database_name,
    principal,
    toStartOfHour(timestamp) AS hour,
    count() AS event_count,
    sum(row_count) AS total_rows,
    max(anomaly_score) AS max_anomaly
FROM dam_analytics.events
GROUP BY tenant_id, database_name, principal, hour;
