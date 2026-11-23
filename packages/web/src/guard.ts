import type * as Dns from "node:dns";
import { FetchError } from "@ai-weave/core";

/** Resolves a hostname to IP addresses. */
export type LookupFn = (hostname: string) => Promise<string[]>;

function parseIPv4(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : undefined;
}

function isPrivateIPv4(o: number[]): boolean {
  const [a = 0, b = 0, c = 0] = o;
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands an IPv6 address into 8 16-bit groups. Returns undefined if invalid. */
function parseIPv6(input: string): number[] | undefined {
  let ip = input
    .replace(/^\[|\]$/g, "")
    .split("%")[0]!
    .toLowerCase();
  if (!ip.includes(":")) return undefined;
  // Embedded IPv4 in the last 32 bits.
  const v4match = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (v4match) {
    const v4 = parseIPv4(v4match[1]!);
    if (!v4) return undefined;
    ip =
      ip.slice(0, -v4match[1]!.length) +
      `${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.length === 8 && nums.every((n) => !Number.isNaN(n)) ? nums : undefined;
}

function isPrivateIPv6(g: number[]): boolean {
  const [g0 = 0, g1 = 0, , , , g5 = 0, g6 = 0, g7 = 0] = g;
  const allZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (allZero(0, 8)) return true; // ::
  if (allZero(0, 7) && g7 === 1) return true; // ::1
  const embedded = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  if (allZero(0, 5) && g5 === 0xffff) return isPrivateIPv4(embedded); // ::ffff:a.b.c.d
  if (allZero(0, 6)) return isPrivateIPv4(embedded); // ::a.b.c.d (deprecated)
  if (g0 === 0x64 && g1 === 0xff9b && allZero(2, 6)) return isPrivateIPv4(embedded); // NAT64
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  return false;
}

/** True if `ip` is a loopback, private, link-local, reserved or otherwise non-public address. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isPrivateIPv4(v4);
  const v6 = parseIPv6(ip);
  if (v6) return isPrivateIPv6(v6);
  return true; // Unparseable: fail closed.
}

/** True if the string is an IP literal (v4 or v6, brackets allowed). */
export function isIpLiteral(host: string): boolean {
  return parseIPv4(host) !== undefined || parseIPv6(host) !== undefined;
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];

/** Default DNS lookup using `node:dns` when available. Returns `undefined` on runtimes without DNS. */
export const defaultLookup: LookupFn | undefined =
  typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node ===
  "string"
    ? async (hostname) => {
        const dns = (await import(/* webpackIgnore: true */ "node:dns")) as typeof Dns;
        const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
        return results.map((r) => r.address);
      }
    : undefined;

export interface GuardOptions {
  /** Allow loopback/private targets (e.g. for local development). Default false. */
  allowPrivateNetwork?: boolean;
  /** DNS resolver used to check hostnames. Default: `node:dns` (skipped on runtimes without it). */
  lookup?: LookupFn;
}

/**
 * Throws {@link FetchError} unless `url` is an http(s) URL that resolves only to public addresses.
 * Note: a hostile DNS server could still return a different address at connect time (DNS rebinding).
 * For strict isolation, also run fetches through an egress proxy.
 */
export async function assertPublicUrl(url: URL, options: GuardOptions = {}): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchError(`Blocked URL scheme "${url.protocol}". Only http and https are allowed.`, {
      url: url.href,
    });
  }
  if (url.username || url.password) {
    throw new FetchError("URLs with credentials are not allowed", { url: url.href });
  }
  if (options.allowPrivateNetwork) return;
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new FetchError(`Blocked private host "${host}"`, { url: url.href });
  }
  if (isIpLiteral(host)) {
    if (isPrivateAddress(host))
      throw new FetchError(`Blocked private address ${host}`, { url: url.href });
    return;
  }
  const lookup = options.lookup ?? defaultLookup;
  if (!lookup) return;
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch (error) {
    throw new FetchError(`Could not resolve host "${host}"`, { url: url.href, cause: error });
  }
  if (!addresses.length)
    throw new FetchError(`Could not resolve host "${host}"`, { url: url.href });
  const bad = addresses.find(isPrivateAddress);
  if (bad)
    throw new FetchError(`Blocked: "${host}" resolves to private address ${bad}`, {
      url: url.href,
    });
}
