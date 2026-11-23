/**
 * Safe URL fetching, HTML → markdown and schema.org JSON-LD extraction for ai-weave.
 * @packageDocumentation
 */
export { webFetcher, DEFAULT_USER_AGENT, type WebFetcherOptions } from "./fetcher.js";
export {
  parseHtml,
  parseJsonLdText,
  flattenJsonLd,
  parseIsoDuration,
  type ParseHtmlOptions,
} from "./html.js";
export {
  assertPublicUrl,
  isPrivateAddress,
  isIpLiteral,
  defaultLookup,
  type GuardOptions,
  type LookupFn,
} from "./guard.js";
export { isAllowedByRobots } from "./robots.js";
