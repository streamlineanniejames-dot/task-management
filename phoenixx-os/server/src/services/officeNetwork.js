import net from 'node:net';
import { get, all } from '../db/index.js';

/**
 * Is this check-in coming from the office?
 *
 * The only network fact the server can establish for itself is the public
 * address a request arrives from (`req.ip`, resolved behind the hosting proxy
 * by Express's `trust proxy`). That is what is matched here, against the
 * connections HR has listed. Nothing the browser sends takes part: a Wi-Fi
 * name, an IP or a "verified" flag in the body would be the employee vouching
 * for themselves, and no browser can read the Wi-Fi name in the first place.
 *
 * The Wi-Fi names on each row are labels, so HR can tell which connection is
 * which. Every SSID served by one router shares that router's public address.
 */

export const METHOD = 'public_ip';

/** '::ffff:49.206.113.67' is how an IPv4 client can appear on a dual-stack socket. */
export function normaliseIp(raw) {
  if (!raw) return null;
  const ip = String(raw).trim().replace(/^::ffff:/i, '');
  return net.isIP(ip) ? ip : null;
}

/** Parses '49.206.113.67' or '117.98.188.0/24' (or IPv6) into a matchable range. */
export function parseRange(value) {
  const text = String(value || '').trim();
  const [addr, bits] = text.split('/');
  const family = net.isIP(addr);
  if (!family) return null;
  const max = family === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (bits !== undefined && !/^\d+$/.test(bits))) {
    return null;
  }
  return { addr, prefix, type: family === 4 ? 'ipv4' : 'ipv6' };
}

/**
 * Address space the server can never see a client arrive from - LAN, loopback,
 * carrier NAT, link-local. Listing one would approve every employee's home
 * router, so the API refuses them with an explanation instead.
 */
const PRIVATE = new net.BlockList();
for (const [a, p] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8],
  ['100.64.0.0', 10], ['169.254.0.0', 16], ['0.0.0.0', 8]]) PRIVATE.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['fc00::', 7], ['fe80::', 10], ['::1', 128], ['::', 128]]) PRIVATE.addSubnet(a, p, 'ipv6');

export const isPrivateRange = (range) => PRIVATE.check(range.addr, range.type);

/** A range too broad to mean "our office" - a /8 covers sixteen million addresses. */
export const isTooBroad = (range) => (range.type === 'ipv4' ? range.prefix < 16 : range.prefix < 48);

export const checkEnabled = (tenantId) => !!get('SELECT network_check FROM tenants WHERE id = ?', [tenantId])?.network_check;

export const activeNetworks = (tenantId) => all(
  `SELECT * FROM approved_networks
    WHERE tenant_id = ? AND deleted_at IS NULL AND is_active = 1 ORDER BY network_name, ssid`,
  [tenantId],
);

/** The first active network whose range holds this address, or null. */
export function matchNetwork(tenantId, rawIp) {
  const ip = normaliseIp(rawIp);
  if (!ip) return null;
  const type = net.isIP(ip) === 4 ? 'ipv4' : 'ipv6';
  for (const n of activeNetworks(tenantId)) {
    const range = parseRange(n.public_ip);
    if (!range || range.type !== type) continue;
    const list = new net.BlockList();
    list.addSubnet(range.addr, range.prefix, range.type);
    if (list.check(ip, type)) return n;
  }
  return null;
}

/**
 * The verdict for one check-in. `verified` is null when the workspace has the
 * check switched off - "not checked" is a different fact from "failed".
 */
export function verifyCheckIn(tenantId, rawIp) {
  const ip = normaliseIp(rawIp);
  if (!checkEnabled(tenantId)) {
    return { enabled: false, verified: null, method: null, network: null, ip };
  }
  const network = matchNetwork(tenantId, ip);
  return { enabled: true, verified: !!network, method: METHOD, network, ip };
}
