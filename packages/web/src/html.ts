import type { FetchedPage } from "@ai-weave/core";
import { parseDocument } from "htmlparser2";
import { isTag, isText, type AnyNode, type Element } from "domhandler";

const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "nav",
  "footer",
  "aside",
  "form",
  "button",
  "select",
  "input",
  "textarea",
  "dialog",
  "head",
  "link",
  "meta",
]);

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "ul",
  "ol",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "blockquote",
  "figure",
  "figcaption",
  "dl",
  "dt",
  "dd",
  "address",
  "details",
  "summary",
  "hr",
]);

const NOISE_CLASS =
  /^(cookies?|consent|newsletter|ads?|advert|advertisement|social|share|sharing|related|comments?|sidebar|popup|modal|promo|subscribe|breadcrumbs?|skip-link)([-_].*)?$/i;

function textOf(node: AnyNode): string {
  if (isText(node)) return node.data;
  if (isTag(node) || node.type === "root") {
    return (node as Element).children.map(textOf).join("");
  }
  return "";
}

function isHidden(el: Element): boolean {
  const a = el.attribs;
  if ("hidden" in a || a["aria-hidden"] === "true") return true;
  if (a.style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style)) return true;
  const tokens = `${a.class ?? ""} ${a.id ?? ""}`.split(/\s+/).filter(Boolean);
  return tokens.some((t) => NOISE_CLASS.test(t));
}

function walk(node: AnyNode, visit: (el: Element) => void): void {
  if (isTag(node)) visit(node);
  if ("children" in node) for (const child of (node as Element).children) walk(child, visit);
}

function find(root: AnyNode, pred: (el: Element) => boolean): Element | undefined {
  let found: Element | undefined;
  walk(root, (el) => {
    if (!found && pred(el)) found = el;
  });
  return found;
}

interface RenderState {
  listDepth: number;
}

function renderChildren(el: Element, state: RenderState): string {
  return el.children.map((c) => render(c, state)).join("");
}

function render(node: AnyNode, state: RenderState): string {
  if (isText(node)) return node.data.replace(/\s+/g, " ");
  if (node.type === "root")
    return (node as unknown as Element).children.map((c) => render(c, state)).join("");
  if (!isTag(node)) return "";
  const tag = node.name;
  if (SKIP_TAGS.has(tag) || isHidden(node)) return "";
  switch (tag) {
    case "br":
      return "\n";
    case "hr":
      return "\n\n---\n\n";
    case "img":
      return "";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = textOf(node).replace(/\s+/g, " ").trim();
      return text ? `\n\n${"#".repeat(Number(tag[1]))} ${text}\n\n` : "";
    }
    case "pre":
      return `\n\n\`\`\`\n${textOf(node).replace(/^\n+|\s+$/g, "")}\n\`\`\`\n\n`;
    case "ul":
    case "ol": {
      const inner = { listDepth: state.listDepth + 1 };
      let index = 0;
      const items = node.children
        .filter(isTag)
        .filter((c) => c.name === "li" && !isHidden(c))
        .map((li) => {
          index++;
          const marker = tag === "ol" ? `${index}.` : "-";
          const body = renderChildren(li, inner)
            .replace(/\n{2,}/g, "\n")
            .trim();
          return body ? `${"  ".repeat(state.listDepth)}${marker} ${body}` : "";
        })
        .filter(Boolean);
      return items.length ? `\n\n${items.join("\n")}\n\n` : "";
    }
    case "tr": {
      const cells = node.children
        .filter(isTag)
        .filter((c) => c.name === "td" || c.name === "th")
        .map((c) => renderChildren(c, state).replace(/\s+/g, " ").trim());
      return cells.length ? `\n| ${cells.join(" | ")} |` : "";
    }
    case "blockquote": {
      const body = renderChildren(node, state).trim();
      return body
        ? `\n\n${body
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n")}\n\n`
        : "";
    }
    default: {
      const body = renderChildren(node, state);
      return BLOCK_TAGS.has(tag) ? `\n\n${body}\n\n` : body;
    }
  }
}

function normalize(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+$/, "").replace(/^ +(?=[^\s\-\d])/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Parses JSON-LD text tolerantly (comments, CDATA, stray control characters). */
export function parseJsonLdText(text: string): unknown {
  const cleaned = text
    .replace(/^\s*<!--|-->\s*$/g, "")
    .replace(/^\s*\/\/\s*<!\[CDATA\[|\/\/\s*\]\]>\s*$/g, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    try {
      // eslint-disable-next-line no-control-regex
      return JSON.parse(cleaned.replace(/[\u0000-\u001f]+/g, " "));
    } catch {
      return undefined;
    }
  }
}

/** Flattens JSON-LD into typed nodes: expands arrays, `@graph` and `mainEntity`. */
export function flattenJsonLd(
  value: unknown,
  out: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const v of value) flattenJsonLd(v, out);
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj["@type"] !== undefined) out.push(obj);
    if (obj["@graph"] !== undefined) flattenJsonLd(obj["@graph"], out);
    if (obj.mainEntity && typeof obj.mainEntity === "object") flattenJsonLd(obj.mainEntity, out);
  }
  return out;
}

export interface ParseHtmlOptions {
  /** Page URL (used as `FetchedPage.url`). */
  url?: string;
  contentType?: string;
}

/**
 * Parses HTML into a {@link FetchedPage}: title, main content as markdown, and JSON-LD.
 * Removes scripts, navigation, footers, ads, cookie banners and hidden elements.
 */
export function parseHtml(html: string, options: ParseHtmlOptions = {}): FetchedPage {
  const doc = parseDocument(html, { decodeEntities: true });

  const structuredData: Record<string, unknown>[] = [];
  let title: string | undefined;
  let ogTitle: string | undefined;
  walk(doc, (el) => {
    if (el.name === "script" && /ld\+json/i.test(el.attribs.type ?? "")) {
      const parsed = parseJsonLdText(textOf(el));
      if (parsed !== undefined) flattenJsonLd(parsed, structuredData);
    } else if (el.name === "title" && title === undefined) {
      title = textOf(el).replace(/\s+/g, " ").trim() || undefined;
    } else if (el.name === "meta" && el.attribs.property === "og:title" && el.attribs.content) {
      ogTitle ??= el.attribs.content.trim();
    }
  });

  const root =
    find(doc, (el) => el.name === "main" || el.attribs.role === "main") ??
    find(doc, (el) => el.name === "article") ??
    find(doc, (el) => el.name === "body") ??
    doc;
  const content = normalize(render(root as AnyNode, { listDepth: 0 }));
  const h1 = find(root as AnyNode, (el) => el.name === "h1");

  return {
    url: options.url ?? "",
    title: ogTitle ?? title ?? (h1 ? textOf(h1).trim() : undefined),
    content,
    structuredData,
    contentType: options.contentType ?? "text/html",
  };
}

/** Parses an ISO 8601 duration (e.g. `PT1H30M`) into minutes. Returns undefined if invalid. */
export function parseIsoDuration(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m =
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
      value.trim(),
    );
  if (!m || value.trim().toUpperCase() === "P" || value.trim().toUpperCase() === "PT")
    return undefined;
  const [, d = "0", h = "0", min = "0", s = "0"] = m;
  return Math.round(Number(d) * 1440 + Number(h) * 60 + Number(min) + Number(s) / 60);
}
