/**
 * @module utils/loopback
 *
 * Task #232: SSRF allowlist for the controlled internal connections the
 * gateway makes (the loopback OAuth probe/proxy against per-account
 * `workspace-mcp` listeners). Those connections target a port that is
 * ultimately derived from on-disk account config; pinning the host to a
 * strict loopback allowlist and bounding the port closes the door on the
 * probe/proxy being coerced into reaching off-box targets.
 */

/**
 * IPv4/IPv6 loopback literals plus the `localhost` hostname. We treat
 * the whole 127.0.0.0/8 range as loopback (matches the kernel) and the
 * IPv6 `::1` (in its common textual forms).
 */
export function isLoopbackHost(host: string): boolean {
  if (!host) return false;
  let h = host.trim().toLowerCase();
  if (!h) return false;
  // Strip an IPv6 bracket wrapper, e.g. "[::1]".
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost') return true;
  // IPv6 loopback, including the IPv4-mapped form ::ffff:127.0.0.1.
  if (h === '::1' || h === '::ffff:127.0.0.1') return true;
  // IPv4 loopback range 127.0.0.0/8.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const octets = m.slice(1).map((n) => Number(n));
    if (octets.every((o) => o >= 0 && o <= 255) && octets[0] === 127) return true;
  }
  return false;
}

/** True when `port` is an integer in the valid TCP range 1–65535. */
export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Assert that `{ host, port }` is a safe loopback target. Throws a
 * descriptive `Error` when the host is non-loopback or the port is out
 * of range. Callers performing the actual connect/fetch should call this
 * first and surface the rejection as a 4xx.
 */
export function assertLoopbackTarget(host: string, port: number): void {
  if (!isLoopbackHost(host)) {
    throw new Error(`Refusing non-loopback target host "${host}" (SSRF guard)`);
  }
  if (!isValidPort(port)) {
    throw new Error(`Refusing out-of-range port ${port} (SSRF guard)`);
  }
}
