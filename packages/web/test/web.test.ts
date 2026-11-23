import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FetchError, type FetchLike } from "@ai-weave/core";
import {
  assertPublicUrl,
  flattenJsonLd,
  isAllowedByRobots,
  isIpLiteral,
  isPrivateAddress,
  parseHtml,
  parseIsoDuration,
  parseJsonLdText,
  webFetcher,
} from "@ai-weave/web";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const publicLookup = async () => ["93.184.216.34"];

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "[::1]",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::10.0.0.1",
    "2001:db8::1",
    "fe80::1%eth0",
    "not-an-ip",
    "1:2:3",
    "1::2::3",
  ])("blocks %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each([
    "93.184.216.34",
    "8.8.8.8",
    "172.32.0.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "2a00:1450:4001:81b::200e",
  ])("allows %s", (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it("detects IP literals", () => {
    expect(isIpLiteral("1.2.3.4")).toBe(true);
    expect(isIpLiteral("[2001:db8::1]")).toBe(true);
    expect(isIpLiteral("example.com")).toBe(false);
    expect(isIpLiteral("1.2.3.999")).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  const check = (url: string, opts = {}) =>
    assertPublicUrl(new URL(url), { lookup: publicLookup, ...opts });

  it("blocks bad schemes, credentials, private hosts and private DNS answers", async () => {
    await expect(check("file:///etc/passwd")).rejects.toThrow(/scheme/);
    await expect(check("ftp://example.com")).rejects.toThrow(/scheme/);
    await expect(check("http://user:pw@example.com")).rejects.toThrow(/credentials/);
    await expect(check("http://localhost:3000")).rejects.toThrow(/private host/);
    await expect(check("http://db.internal/")).rejects.toThrow(/private host/);
    await expect(check("http://127.0.0.1/")).rejects.toThrow(/private address/);
    await expect(check("http://0x7f.1/")).rejects.toThrow(/private address/); // normalized by URL
    await expect(check("http://[::1]/")).rejects.toThrow(/private address/);
    await expect(
      check("http://evil.test/", { lookup: async () => ["93.184.216.34", "10.0.0.1"] }),
    ).rejects.toThrow(/resolves to private address 10.0.0.1/);
    await expect(check("http://nx.test/", { lookup: async () => [] })).rejects.toThrow(/resolve/);
    await expect(
      check("http://nx.test/", {
        lookup: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toThrow(/resolve/);
  });

  it("allows public hosts and private hosts when opted in", async () => {
    await expect(check("https://example.com/recipe")).resolves.toBeUndefined();
    await expect(check("http://8.8.8.8/")).resolves.toBeUndefined();
    await expect(
      check("http://localhost/", { allowPrivateNetwork: true }),
    ).resolves.toBeUndefined();
  });

  it("uses node DNS by default", async () => {
    await expect(
      assertPublicUrl(new URL("http://localhost.localdomain.invalid./")),
    ).rejects.toBeInstanceOf(FetchError);
  });
});

describe("parseHtml", () => {
  it("extracts title, JSON-LD and clean markdown from a recipe page", () => {
    const page = parseHtml(fixture("recipe-jsonld.html"), {
      url: "https://kitchen.example/lasagna",
    });
    expect(page.url).toBe("https://kitchen.example/lasagna");
    expect(page.title).toBe("Classic Lasagna");
    expect(page.structuredData.map((n) => n["@type"])).toEqual([
      "WebSite",
      "BreadcrumbList",
      "Recipe",
    ]);
    expect(page.content).toContain("# Classic Lasagna");
    expect(page.content).toContain("This is the best lasagna & it feeds a crowd.");
    expect(page.content).toContain("## Ingredients\n\n- 12 lasagna noodles\n- 1 lb ground beef");
    expect(page.content).toContain("1. Preheat the oven to 375°F.\n2. Layer noodles");
    for (const noise of [
      "Home",
      "cookies",
      "Share on Facebook",
      "Popular posts",
      "©",
      "tracking",
    ]) {
      expect(page.content).not.toContain(noise);
    }
  });

  it("handles pages without JSON-LD: nested lists, tables, pre, quotes, hidden content", () => {
    const page = parseHtml(fixture("recipe-no-jsonld.html"));
    expect(page.title).toBe("Grandma's Tomato Soup");
    expect(page.structuredData).toEqual([]);
    expect(page.content).toContain("### You will need");
    expect(page.content).toContain("- 1 onion\n  - diced finely");
    expect(page.content).toContain("Chop the tomatoes.\nSimmer everything");
    expect(page.content).toContain("| Nutrient | Amount |\n| Calories | 120 |");
    expect(page.content).toContain("```\ncode block\n```");
    expect(page.content).toContain("> Best soup ever");
    expect(page.content).not.toContain("Hidden SEO text");
    expect(page.content).not.toContain("Menu");
    expect(page.content).not.toContain("Great recipe!");
    expect(page.content).not.toContain("color: red");
  });

  it("falls back to body and h1 for title", () => {
    const page = parseHtml(
      "<body><h1>Only H1</h1><p>a<br/>b</p><hr><img src=x alt=y><h2> </h2><ul><li></li></ul><blockquote> </blockquote></body>",
    );
    expect(page.title).toBe("Only H1");
    expect(page.content).toBe("# Only H1\n\na\nb\n\n---");
    expect(parseHtml("plain text").content).toBe("plain text");
    expect(parseHtml("<p>x</p>").contentType).toBe("text/html");
  });

  it("parses tolerant JSON-LD and flattens graphs", () => {
    expect(parseJsonLdText('<!-- {"@type":"A"} -->')).toEqual({ "@type": "A" });
    expect(parseJsonLdText('{"@type":"A","d":"line1\nline2"}')).toEqual({
      "@type": "A",
      d: "line1 line2",
    });
    expect(parseJsonLdText("{bad")).toBeUndefined();
    const nodes = flattenJsonLd([
      { "@type": "WebPage", mainEntity: { "@type": "Recipe" } },
      { "@graph": [{ "@type": "A" }, [{ "@type": "B" }]] },
      "x",
      null,
    ]);
    expect(nodes.map((n) => n["@type"])).toEqual(["WebPage", "Recipe", "A", "B"]);
  });

  it("parses ISO 8601 durations to minutes", () => {
    expect(parseIsoDuration("PT30M")).toBe(30);
    expect(parseIsoDuration("PT1H15M")).toBe(75);
    expect(parseIsoDuration("P1DT2H")).toBe(1560);
    expect(parseIsoDuration("PT90S")).toBe(2);
    expect(parseIsoDuration("pt0.5h")).toBe(30);
    expect(parseIsoDuration("PT")).toBeUndefined();
    expect(parseIsoDuration("30 minutes")).toBeUndefined();
    expect(parseIsoDuration(30)).toBeUndefined();
  });
});

describe("isAllowedByRobots", () => {
  const robots = `
# comment
User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.pdf$

User-agent: ai-weave
User-agent: other
Disallow: /no-weave
`;
  it("applies the most specific group and longest rule", () => {
    expect(isAllowedByRobots(robots, "SomeBot/1.0", "/private/x")).toBe(false);
    expect(isAllowedByRobots(robots, "SomeBot/1.0", "/private/public/x")).toBe(true);
    expect(isAllowedByRobots(robots, "SomeBot/1.0", "/file.pdf")).toBe(false);
    expect(isAllowedByRobots(robots, "SomeBot/1.0", "/file.pdf?x")).toBe(true);
    expect(isAllowedByRobots(robots, "SomeBot/1.0", "/recipes")).toBe(true);
    expect(isAllowedByRobots(robots, "ai-weave/0.1 (+url)", "/private/x")).toBe(true);
    expect(isAllowedByRobots(robots, "ai-weave/0.1", "/no-weave")).toBe(false);
    expect(isAllowedByRobots("", "x", "/")).toBe(true);
    expect(isAllowedByRobots("Disallow: /\nSitemap: x", "x", "/")).toBe(true);
  });
});

type Route = (init?: RequestInit) => Response;

function siteFetch(routes: Record<string, Route | Response>) {
  const seen: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    seen.push(url);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return typeof route === "function" ? route(init) : route.clone();
  };
  return { fetch, seen };
}

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });

describe("webFetcher", () => {
  it("fetches and parses an HTML page", async () => {
    const { fetch, seen } = siteFetch({
      "https://kitchen.example/lasagna": html(fixture("recipe-jsonld.html")),
    });
    const page = await webFetcher({ fetch, lookup: publicLookup }).fetch(
      "https://kitchen.example/lasagna",
    );
    expect(page.title).toBe("Classic Lasagna");
    expect(page.structuredData).toHaveLength(3);
    expect(seen).toEqual(["https://kitchen.example/lasagna"]);
  });

  it("follows redirects but re-checks every hop", async () => {
    const redirect = (location: string) =>
      new Response(null, { status: 302, headers: { location } });
    const { fetch } = siteFetch({
      "https://a.example/": redirect("/b"),
      "https://a.example/b": html("<h1>B</h1>"),
      "https://a.example/evil": redirect("http://169.254.169.254/latest/meta-data"),
      "https://a.example/loop": redirect("/loop"),
      "https://a.example/noloc": new Response(null, { status: 301 }),
    });
    const fetcher = webFetcher({ fetch, lookup: publicLookup, maxRedirects: 3 });
    expect((await fetcher.fetch("https://a.example/")).url).toBe("https://a.example/b");
    await expect(fetcher.fetch("https://a.example/evil")).rejects.toThrow(
      /private address 169.254.169.254/,
    );
    await expect(fetcher.fetch("https://a.example/loop")).rejects.toThrow(/Too many redirects/);
    await expect(fetcher.fetch("https://a.example/noloc")).rejects.toThrow(/Location/);
  });

  it("rejects invalid URLs, HTTP errors, binary content and oversized bodies", async () => {
    const big = "x".repeat(2000);
    const { fetch } = siteFetch({
      "https://a.example/404": new Response("nope", { status: 404 }),
      "https://a.example/img": new Response("PNG", { headers: { "content-type": "image/png" } }),
      "https://a.example/big-declared": html(big, { "content-length": "2000" }),
      "https://a.example/big-stream": html(big),
    });
    const fetcher = webFetcher({ fetch, lookup: publicLookup, maxBytes: 1000 });
    await expect(fetcher.fetch("not a url")).rejects.toThrow(/Invalid URL/);
    await expect(fetcher.fetch("https://a.example/404")).rejects.toMatchObject({ status: 404 });
    await expect(fetcher.fetch("https://a.example/img")).rejects.toThrow(
      /content type "image\/png"/,
    );
    await expect(fetcher.fetch("https://a.example/big-declared")).rejects.toThrow(/too large/);
    await expect(fetcher.fetch("https://a.example/big-stream")).rejects.toThrow(/too large/);
    await expect(fetcher.fetch("http://localhost/")).rejects.toBeInstanceOf(FetchError);
  });

  it("wraps network errors and timeouts as FetchError", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError("ECONNRESET");
    };
    await expect(
      webFetcher({ fetch: failing, lookup: publicLookup }).fetch("https://a.example/"),
    ).rejects.toThrow(/Failed to fetch.*ECONNRESET/);
    const hanging: FetchLike = (_url, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    const error = await webFetcher({ fetch: hanging, lookup: publicLookup, timeoutMs: 10 })
      .fetch("https://a.example/")
      .catch((e) => e);
    expect(error).toBeInstanceOf(FetchError);
    expect(error.message).toMatch(/timed out/);
  });

  it("returns non-HTML text content as-is and decodes charsets", async () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in latin1
    const { fetch } = siteFetch({
      "https://a.example/t.txt": new Response("hello", {
        headers: { "content-type": "text/plain" },
      }),
      "https://a.example/latin": new Response(latin1, {
        headers: { "content-type": "text/plain; charset=iso-8859-1" },
      }),
      "https://a.example/meta": new Response(
        new Uint8Array([
          ...new TextEncoder().encode('<meta charset="iso-8859-1"><p>caf'),
          0xe9,
          ...new TextEncoder().encode("</p>"),
        ]),
        {
          headers: { "content-type": "text/html" },
        },
      ),
      "https://a.example/bogus": new Response("ok", {
        headers: { "content-type": "text/plain; charset=bogus-charset" },
      }),
      // A byte body gets no default content-type; treat it as HTML.
      "https://a.example/notype": new Response(new TextEncoder().encode("<p>untyped</p>")),
    });
    const fetcher = webFetcher({ fetch, lookup: publicLookup });
    expect(await fetcher.fetch("https://a.example/t.txt")).toMatchObject({
      content: "hello",
      contentType: "text/plain",
      structuredData: [],
    });
    expect((await fetcher.fetch("https://a.example/latin")).content).toBe("café");
    expect((await fetcher.fetch("https://a.example/meta")).content).toBe("café");
    expect((await fetcher.fetch("https://a.example/bogus")).content).toBe("ok");
    expect((await fetcher.fetch("https://a.example/notype")).content).toBe("untyped");
  });

  it("respects robots.txt when enabled and caches it", async () => {
    const { fetch, seen } = siteFetch({
      "https://a.example/robots.txt": new Response("User-agent: *\nDisallow: /private", {
        headers: { "content-type": "text/plain" },
      }),
      "https://a.example/ok": html("<p>ok</p>"),
      "https://b.example/ok": html("<p>ok</p>"),
    });
    const fetcher = webFetcher({
      fetch,
      lookup: publicLookup,
      respectRobotsTxt: true,
      headers: { "x-test": "1" },
    });
    await expect(fetcher.fetch("https://a.example/private/x")).rejects.toThrow(/robots.txt/);
    await expect(fetcher.fetch("https://a.example/ok")).resolves.toMatchObject({ content: "ok" });
    // b.example has no robots.txt (404) → allowed.
    await expect(fetcher.fetch("https://b.example/ok")).resolves.toMatchObject({ content: "ok" });
    expect(seen.filter((u) => u.endsWith("robots.txt"))).toEqual([
      "https://a.example/robots.txt",
      "https://b.example/robots.txt",
    ]);
  });

  it("treats robots.txt fetch failures as allowed and honors abort", async () => {
    let calls = 0;
    const fetch: FetchLike = async (input) => {
      calls++;
      if (String(input).endsWith("robots.txt")) throw new TypeError("network");
      return html("<p>fine</p>");
    };
    const fetcher = webFetcher({ fetch, lookup: publicLookup, respectRobotsTxt: true });
    await expect(fetcher.fetch("https://a.example/x")).resolves.toMatchObject({ content: "fine" });
    expect(calls).toBe(2);
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetcher.fetch("https://a.example/x", { signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });
});
