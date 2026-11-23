import {
  FetchError,
  TimeoutError,
  withTimeout,
  type CallOptions,
  type FetchedPage,
  type FetchLike,
  type Fetcher,
} from "@ai-weave/core";
import { assertPublicUrl, type LookupFn } from "./guard.js";
import { parseHtml } from "./html.js";
import { isAllowedByRobots } from "./robots.js";

export interface WebFetcherOptions {
  /** Allow loopback/private network targets. Default false (SSRF protection). */
  allowPrivateNetwork?: boolean;
  /** Maximum response size in bytes. Default 5 MB. */
  maxBytes?: number;
  /** Timeout for the whole fetch (all redirects), in ms. Default 15000. */
  timeoutMs?: number;
  /** Maximum redirects to follow. Default 5. */
  maxRedirects?: number;
  /** User agent header. */
  userAgent?: string;
  /** Check robots.txt before fetching. Default false (user-initiated fetches behave like a browser). */
  respectRobotsTxt?: boolean;
  /** Custom DNS resolver for the SSRF guard. */
  lookup?: LookupFn;
  /** Custom fetch implementation. */
  fetch?: FetchLike;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

export const DEFAULT_USER_AGENT = "ai-weave/0.1 (+https://github.com/swaroopdiwakar007/ai-weave)";

const ALLOWED_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/ld+json",
];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Releases a response body without waiting (cancel can hang on tee'd streams). */
function discard(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

function charsetOf(contentType: string | null, head: Uint8Array): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  if (fromHeader) return fromHeader;
  const sniff = new TextDecoder("latin1").decode(head.subarray(0, 2048));
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1] ?? "utf-8";
}

async function readLimited(response: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    discard(response);
    throw new FetchError(`Response too large (${declared} bytes > ${maxBytes})`, { url });
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => {});
      throw new FetchError(`Response too large (> ${maxBytes} bytes)`, { url });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * Creates a {@link Fetcher} that safely downloads a page and converts it to a {@link FetchedPage}.
 *
 * Safety: http(s) only, blocks private/loopback/link-local targets (checked on every redirect hop),
 * caps response size, redirects and time, and only accepts text-like content types.
 */
export function webFetcher(options: WebFetcherOptions = {}): Fetcher {
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 5;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const robotsCache = new Map<string, string | null>();

  const guardedGet = async (
    startUrl: URL,
    signal: AbortSignal,
  ): Promise<{ response: Response; url: URL }> => {
    const doFetch = options.fetch ?? (globalThis.fetch as FetchLike);
    let url = startUrl;
    for (let hop = 0; ; hop++) {
      await assertPublicUrl(url, {
        allowPrivateNetwork: options.allowPrivateNetwork,
        lookup: options.lookup,
      });
      let response: Response;
      try {
        response = await doFetch(url.href, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: {
            "user-agent": userAgent,
            accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
            "accept-language": "en;q=0.9,*;q=0.5",
            ...options.headers,
          },
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new FetchError(`Failed to fetch ${url.href}: ${(error as Error).message}`, {
          url: url.href,
          cause: error,
        });
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        discard(response);
        if (!location) throw new FetchError(`Redirect without Location header`, { url: url.href });
        if (hop >= maxRedirects)
          throw new FetchError(`Too many redirects (> ${maxRedirects})`, { url: url.href });
        url = new URL(location, url);
        continue;
      }
      return { response, url };
    }
  };

  const robotsAllows = async (url: URL, signal: AbortSignal): Promise<boolean> => {
    let txt = robotsCache.get(url.origin);
    if (txt === undefined) {
      try {
        const { response } = await guardedGet(new URL("/robots.txt", url.origin), signal);
        txt = response.ok
          ? decode(await readLimited(response, 512 * 1024, url.href), "utf-8")
          : null;
      } catch (error) {
        if (signal.aborted) throw error;
        txt = null;
      }
      robotsCache.set(url.origin, txt);
    }
    return txt === null ? true : isAllowedByRobots(txt, userAgent, url.pathname + url.search);
  };

  return {
    async fetch(rawUrl: string, call?: CallOptions): Promise<FetchedPage> {
      let start: URL;
      try {
        start = new URL(rawUrl);
      } catch {
        throw new FetchError(`Invalid URL: ${rawUrl}`, { url: rawUrl });
      }
      try {
        return await withTimeout(
          async (signal) => {
            if (options.respectRobotsTxt && !(await robotsAllows(start, signal))) {
              throw new FetchError(`Blocked by robots.txt: ${start.href}`, { url: start.href });
            }
            const { response, url } = await guardedGet(start, signal);
            if (!response.ok) {
              discard(response);
              throw new FetchError(`HTTP ${response.status} fetching ${url.href}`, {
                url: url.href,
                status: response.status,
              });
            }
            const contentType = response.headers.get("content-type");
            const mime = (contentType ?? "text/html").split(";")[0]!.trim().toLowerCase();
            if (!ALLOWED_TYPES.includes(mime)) {
              discard(response);
              throw new FetchError(`Unsupported content type "${mime}"`, { url: url.href });
            }
            const bytes = await readLimited(response, maxBytes, url.href);
            const text = decode(bytes, charsetOf(contentType, bytes));
            if (mime === "text/html" || mime === "application/xhtml+xml") {
              return parseHtml(text, { url: url.href, contentType: mime });
            }
            return { url: url.href, content: text, structuredData: [], contentType: mime };
          },
          options.timeoutMs ?? 15_000,
          call?.signal,
          `Fetching ${start.href}`,
        );
      } catch (error) {
        if (error instanceof TimeoutError) {
          throw new FetchError(error.message, { url: start.href, cause: error });
        }
        throw error;
      }
    },
  };
}
