/**
 * Target-set model for the discovery scanner.
 *
 * A target spec says WHERE to look; the protocol fingerprint (scanner.js) still
 * decides WHAT each open port is. This module turns a human-written spec into the
 * concrete host list to probe. Each comma-separated token may be:
 *
 *   - a hostname            db-vm-a, client-mysql          (probed as-is)
 *   - a single IPv4         10.40.0.5                      (probed as-is)
 *   - a CIDR block          10.40.0.0/24                   (expanded to hosts)
 *   - a dashed IPv4 range   10.40.0.10-10.40.0.40          (expanded)
 *                           10.40.0.10-40                  (short form: last octet)
 *
 * Expansion is IPv4-only and capped: a fat prefix like /8 is almost always a
 * mistake, would take hours, and trips every IDS — so it is refused, not run.
 * Anything that isn't an IPv4 literal / CIDR / range — hostnames, IPv6 — is
 * emitted verbatim as one target, so mixed specs ("prod-hub, 10.40.0.0/24") work.
 */

// Largest number of addresses a single CIDR/range token may expand to.
// 65536 == a /16. Anything bigger is refused; pass a tighter prefix instead.
const DEFAULT_MAX_HOSTS = 65536;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIPv4(s) {
  const m = IPV4.exec(s);
  return !!m && m.slice(1).every((o) => +o >= 0 && +o <= 255);
}

function ipToInt(s) {
  const m = IPV4.exec(s);
  return (((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4]) >>> 0;
}
function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function unique(arr) { return [...new Set(arr)]; }

// A token is a dashed range only if the part before the first '-' is a real IPv4.
// This keeps hostnames like "client-mysql" from being mistaken for ranges.
function isDashRange(token) {
  const i = token.indexOf('-');
  return i > 0 && isIPv4(token.slice(0, i).trim());
}

/** Expand "10.40.0.0/24" → array of host IPs (network + broadcast excluded for /30 and larger). */
function expandCidr(token, maxHosts) {
  const [addr, prefixStr] = token.split('/');
  const prefix = parseInt(prefixStr, 10);
  if (!isIPv4(addr) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`invalid CIDR: ${token}`);
  }
  const size = 2 ** (32 - prefix);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const base = (ipToInt(addr) & mask) >>> 0;
  // Usable hosts: drop the network + broadcast address for /30 and larger blocks;
  // for /31 and /32 there is no such reservation, so probe every address.
  let start = base, end = base + size - 1;
  if (prefix <= 30) { start = base + 1; end = base + size - 2; }
  const count = end - start + 1;
  if (count > maxHosts) {
    throw new Error(`CIDR ${token} expands to ${count} hosts (> cap ${maxHosts}); use a tighter prefix`);
  }
  const out = [];
  for (let n = start; n <= end; n++) out.push(intToIp(n >>> 0));
  return out;
}

/** Expand "10.40.0.10-10.40.0.40" or "10.40.0.10-40" → array of host IPs. */
function expandRange(token, maxHosts) {
  const dash = token.indexOf('-');
  const lo = token.slice(0, dash).trim();
  let hi = token.slice(dash + 1).trim();
  if (!isIPv4(lo)) throw new Error(`invalid range start: ${token}`);
  if (/^\d{1,3}$/.test(hi)) { const p = lo.split('.'); p[3] = hi; hi = p.join('.'); } // short form
  if (!isIPv4(hi)) throw new Error(`invalid range end: ${token}`);
  const a = ipToInt(lo), b = ipToInt(hi);
  if (b < a) throw new Error(`range end before start: ${token}`);
  const count = b - a + 1;
  if (count > maxHosts) throw new Error(`range ${token} expands to ${count} hosts (> cap ${maxHosts})`);
  const out = [];
  for (let n = a; n <= b; n++) out.push(intToIp(n >>> 0));
  return out;
}

/**
 * Expand a target spec into the concrete host list to probe.
 * @param {string|string[]} spec  comma-separated tokens, or an array of tokens
 * @param {{maxHosts?: number}} opts
 * @returns {{hosts: string[], warnings: string[]}} deduped hosts + any tokens that were skipped
 */
function expandTargets(spec, opts = {}) {
  const maxHosts = opts.maxHosts || DEFAULT_MAX_HOSTS;
  const tokens = Array.isArray(spec) ? spec : String(spec || '').split(',');
  const hosts = [];
  const warnings = [];
  for (const raw of tokens) {
    const token = String(raw).trim();
    if (!token) continue;
    try {
      if (token.includes('/')) hosts.push(...expandCidr(token, maxHosts));
      else if (isDashRange(token)) hosts.push(...expandRange(token, maxHosts));
      else hosts.push(token); // hostname, single IPv4, or IPv6 — probe verbatim
    } catch (e) {
      warnings.push(e.message);
    }
  }
  return { hosts: unique(hosts), warnings };
}

module.exports = { expandTargets, isIPv4, ipToInt, intToIp, DEFAULT_MAX_HOSTS };
