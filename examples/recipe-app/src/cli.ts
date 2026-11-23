/**
 * Recipe extractor: paste a URL, get a typed recipe, store it.
 *
 *   pnpm --filter recipe-app start <url> [--provider anthropic|openai|gemini] [--model <id>] [--normalize]
 *   pnpm --filter recipe-app start --list
 *   pnpm --filter recipe-app demo          # offline, no API keys needed
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createWeave, type FetchLike, type Provider, type Usage } from "@ai-weave/core";
import { mockProvider } from "@ai-weave/core/testing";
import { anthropic } from "@ai-weave/anthropic";
import { openai } from "@ai-weave/openai";
import { gemini } from "@ai-weave/gemini";
import { webFetcher } from "@ai-weave/web";
import { Recipe, recipeFromJsonLd, type Recipe as RecipeT } from "./recipe.js";
import { loadRecipes, saveRecipe } from "./store.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    normalize: { type: "boolean", default: false },
    "no-jsonld": { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    offline: { type: "boolean", default: false },
  },
});

const factories: Record<string, { create: (model?: string) => Provider; hasKey: () => boolean }> = {
  anthropic: {
    create: (model) => anthropic({ model }),
    hasKey: () => !!process.env.ANTHROPIC_API_KEY,
  },
  openai: { create: (model) => openai({ model }), hasKey: () => !!process.env.OPENAI_API_KEY },
  gemini: {
    create: (model) => gemini({ model }),
    hasKey: () => !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
  },
};

/** Primary = --provider (or the first with a key); fallback = the other providers with keys. */
function liveProviders(): { provider: Provider; fallback: Provider[] } {
  const configured = Object.keys(factories).filter((n) => factories[n]!.hasKey());
  const primaryName = values.provider ?? configured[0];
  if (!primaryName || !factories[primaryName]) {
    console.error(
      "No provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY, or run `pnpm demo`.",
    );
    process.exit(1);
  }
  return {
    provider: factories[primaryName]!.create(values.model),
    fallback: configured.filter((n) => n !== primaryName).map((n) => factories[n]!.create()),
  };
}

/** Offline mode: serve bundled HTML pages and script the model's replies. */
function offlineSetup() {
  const pages: Record<string, string> = {
    "https://kitchen.example/lasagna": "lasagna.html",
    "https://kitchen.example/soup": "soup.html",
  };
  const fetch: FetchLike = async (url) => {
    const file = pages[String(url)];
    if (!file) return new Response("Not found", { status: 404 });
    const html = readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8");
    return new Response(html, { headers: { "content-type": "text/html" } });
  };
  const soup: RecipeT = {
    title: "Grandma's Tomato Soup",
    servings: 4,
    prepTimeMinutes: 10,
    ingredients: [
      { quantity: "6", name: "ripe tomatoes" },
      { quantity: "1", name: "onion, diced finely" },
      { quantity: "2 cups", name: "vegetable stock" },
    ],
    steps: ["Chop the tomatoes.", "Simmer everything for 20 minutes."],
  };
  return {
    provider: mockProvider({
      defaultResponse: { json: soup, usage: { inputTokens: 420, outputTokens: 120 } },
    }),
    fetcher: webFetcher({ fetch, lookup: async () => ["93.184.216.34"] }),
    urls: Object.keys(pages),
  };
}

function printRecipe(recipe: RecipeT) {
  const times = [
    recipe.prepTimeMinutes !== undefined && `prep ${recipe.prepTimeMinutes} min`,
    recipe.cookTimeMinutes !== undefined && `cook ${recipe.cookTimeMinutes} min`,
    recipe.totalTimeMinutes !== undefined && `total ${recipe.totalTimeMinutes} min`,
    recipe.servings !== undefined && `serves ${recipe.servings}`,
  ].filter(Boolean);
  console.log(`\n🍽  ${recipe.title}${times.length ? `  (${times.join(", ")})` : ""}`);
  if (recipe.description) console.log(`   ${recipe.description}`);
  console.log("\n   Ingredients:");
  for (const i of recipe.ingredients)
    console.log(`   • ${i.quantity ? `${i.quantity} ` : ""}${i.name}`);
  console.log("\n   Steps:");
  recipe.steps.forEach((s, n) => console.log(`   ${n + 1}. ${s}`));
}

function printUsage(usage: Usage) {
  const cost = usage.costUsd === undefined ? "n/a" : `$${usage.costUsd.toFixed(5)}`;
  console.log(
    `\n   ${usage.calls} model call(s) via ${usage.provider}/${usage.model}: ` +
      `${usage.inputTokens}+${usage.outputTokens} tokens, ${cost}, ${usage.latencyMs} ms`,
  );
}

async function main() {
  if (values.list) {
    const all = await loadRecipes();
    if (!all.length) console.log("No recipes saved yet.");
    for (const r of all)
      console.log(`${r.savedAt}  ${r.recipe.title}  [${r.method}]  ${r.sourceUrl ?? ""}`);
    return;
  }

  const offline = values.offline ? offlineSetup() : undefined;
  const urls = positionals.length ? positionals : (offline?.urls ?? []);
  if (!urls.length) {
    console.error(
      "Usage: recipe-app <url> [--provider anthropic|openai|gemini] [--model id] [--normalize]",
    );
    process.exit(1);
  }

  const { provider, fallback } = offline
    ? { provider: offline.provider, fallback: [] }
    : liveProviders();
  const ai = createWeave({
    provider,
    fallback,
    fetcher: offline?.fetcher ?? webFetcher(),
    onError: (e) =>
      console.warn(
        `   ⚠ ${e.provider} attempt ${e.attempt + 1} failed: ${(e.error as Error).message}`,
      ),
  });

  for (const url of urls) {
    console.log(`\n→ ${url}`);
    try {
      const { data, source, usage } = await ai.extract({
        url,
        schema: Recipe,
        instructions:
          "Split each ingredient into quantity (with unit) and name. Keep the original units.",
        // --normalize: skip the deterministic mapper and let the model normalize JSON-LD (hybrid).
        jsonLd: values["no-jsonld"]
          ? undefined
          : { type: "Recipe", map: values.normalize ? undefined : recipeFromJsonLd },
      });
      printRecipe(data);
      console.log(`\n   source: ${source.method}${source.truncated ? " (content truncated)" : ""}`);
      printUsage(usage);
      const saved = await saveRecipe({
        sourceUrl: source.url,
        method: source.method,
        recipe: data,
      });
      console.log(`   ✔ saved as ${saved.id}`);
    } catch (error) {
      console.error(`   ✖ ${(error as Error).name}: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
}

await main();
