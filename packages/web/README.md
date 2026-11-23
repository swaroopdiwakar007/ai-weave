# @ai-weave/web

Safe web fetching for ai-weave: SSRF guard, HTML → clean markdown, schema.org JSON-LD.

```ts
import { webFetcher, parseHtml } from "@ai-weave/web";

const ai = createWeave({ provider, fetcher: webFetcher() });
await ai.extract({ url, schema });

// Already have the HTML? Skip fetching:
await ai.extract({ page: parseHtml(html, { url }), schema });
```

## `webFetcher(options)`

| Option                                    | Default |                                                                      |
| ----------------------------------------- | ------- | -------------------------------------------------------------------- |
| `allowPrivateNetwork`                     | `false` | Allow localhost/private IPs (local development only)                 |
| `maxBytes`                                | 5 MB    | Response size cap (checks both the header and the stream)            |
| `timeoutMs`                               | 15000   | Whole fetch, including redirects                                     |
| `maxRedirects`                            | 5       | Every hop is re-checked by the SSRF guard                            |
| `respectRobotsTxt`                        | `false` | User-initiated fetches act like a browser. Turn this on for crawling |
| `userAgent`, `headers`, `fetch`, `lookup` |         | Customization and testing                                            |

Accepted content types: HTML, XHTML, plain text, markdown and JSON. Everything else throws
`FetchError`.

**Guard:**

- Only http(s) URLs are allowed. URLs with credentials are rejected.
- These hosts are blocked: `localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa`.
- Private, loopback, link-local, CGNAT, multicast and reserved IPv4/IPv6 addresses are blocked. This
  includes IPv4-mapped/NAT64 forms and any hostname whose DNS answer contains one.
- DNS rebinding between the check and the connection isn't prevented. Use an egress proxy if you
  need strict isolation.

Some sites block non-browser clients through bot management (for example, HTTP 402/403 from
Allrecipes). An optional headless-browser fetcher is planned.

## Helpers

`parseHtml`, `parseIsoDuration` (`"PT1H30M"` → `90`), `flattenJsonLd`, `parseJsonLdText`,
`isPrivateAddress`, `assertPublicUrl`, `isAllowedByRobots`.
