/**
 * Port-set model for the discovery scanner.
 *
 * The whole point: we do NOT trust the port number to identify an engine.
 * Port selection only decides *where to look*; the protocol fingerprint
 * (see scanner.js) decides *what it is*. So a Postgres on 48291 is still
 * found and identified — the port set just has to be wide enough to include it.
 */

// Default listening ports per engine (the "textbook" ports).
const DEFAULT_PORTS = {
  postgres: [5432],
  mysql: [3306],
  mariadb: [3306],
  oracle: [1521],
  mssql: [1433],
  mongodb: [27017],
  redis: [6379],
  cassandra: [9042],
  db2: [50000],
  elasticsearch: [9200],
};

// Common NON-default ports operators actually use (second instance, pooler,
// proxy, "moved it up one"). This is what catches most real-world drift.
const ALTERNATE_PORTS = [
  5433, 5434, 5435, 6432, // postgres + pgbouncer
  3307, 3308, 6033,       // mysql/mariadb + proxysql
  1522, 1526, 1525,       // oracle
  1434,                   // mssql
  27018, 27019, 27020,    // mongodb (shards/replicas)
  6380, 6381,             // redis
  9043,                   // cassandra
  50001,                  // db2
];

// A curated "top ports" set: defaults + alternates + a spread of ports DBs are
// commonly relocated to. Balances coverage against scan time / IDS noise.
const TOP_EXTRA = [
  1521, 1433, 3306, 5432, 27017, 6379, 9042, 50000,
  1521, 49152, 49153, 49154, 1024, 2048, 8000, 8080,
  15432, 13306, 11521, 11433, 12701, // "prefix" relocations
];

const PRESETS = {
  // Fast baseline — only the textbook ports. Misses relocated DBs.
  default: { label: 'Default ports only', ports: () => unique(flat(Object.values(DEFAULT_PORTS))) },
  // Recommended — defaults + the common alternates operators actually use.
  common: { label: 'Default + common alternates', ports: () => unique([...flat(Object.values(DEFAULT_PORTS)), ...ALTERNATE_PORTS]) },
  // Broader curated set.
  top: { label: 'Top relocated ports (~80)', ports: () => unique([...flat(Object.values(DEFAULT_PORTS)), ...ALTERNATE_PORTS, ...TOP_EXTRA]) },
  // Exhaustive — every TCP port. Thorough but slow + noisy; use rate limiting.
  full: { label: 'Full range (1–65535)', ports: () => range(1, 65535) },
  // User-supplied list/ranges, e.g. "5432, 3300-3400, 27017-27019".
  custom: { label: 'Custom list / ranges', ports: (spec) => parsePortSpec(spec) },
};

function flat(arr) { return arr.reduce((a, b) => a.concat(b), []); }
function unique(arr) { return [...new Set(arr)].sort((a, b) => a - b); }
function range(a, b) { const out = []; for (let p = a; p <= b; p++) out.push(p); return out; }

/** Parse "5432, 3300-3400, 27017-27019" → sorted unique int array. */
function parsePortSpec(spec) {
  if (!spec) return [];
  const ports = [];
  for (const tokenRaw of String(spec).split(',')) {
    const token = tokenRaw.trim();
    if (!token) continue;
    if (token.includes('-')) {
      const [lo, hi] = token.split('-').map((s) => parseInt(s.trim(), 10));
      if (Number.isInteger(lo) && Number.isInteger(hi) && lo <= hi) {
        for (let p = Math.max(1, lo); p <= Math.min(65535, hi); p++) ports.push(p);
      }
    } else {
      const p = parseInt(token, 10);
      if (Number.isInteger(p) && p >= 1 && p <= 65535) ports.push(p);
    }
  }
  return unique(ports);
}

/**
 * Resolve a port-set config to the concrete list of ports to probe.
 * @param {{preset?: string, customPorts?: string}} cfg
 * @returns {number[]}
 */
function expandPortSet(cfg = {}) {
  const preset = PRESETS[cfg.preset] || PRESETS.common;
  return preset.ports(cfg.customPorts);
}

module.exports = { DEFAULT_PORTS, ALTERNATE_PORTS, PRESETS, parsePortSpec, expandPortSet };
