import { z } from "zod";
import { parseIsoDuration } from "@ai-weave/web";

/** The structured recipe the app stores. */
export const Recipe = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  servings: z.number().int().positive().optional(),
  prepTimeMinutes: z.number().nonnegative().optional(),
  cookTimeMinutes: z.number().nonnegative().optional(),
  totalTimeMinutes: z.number().nonnegative().optional(),
  ingredients: z
    .array(
      z.object({
        name: z.string().min(1).describe("Ingredient name, e.g. 'ground beef'"),
        quantity: z.string().optional().describe("Amount with unit, e.g. '1 lb'"),
      }),
    )
    .min(1),
  steps: z.array(z.string().min(1)).min(1),
});

export type Recipe = z.infer<typeof Recipe>;

const QUANTITY =
  /^((?:[\d½¼¾⅓⅔⅛]+(?:[\s.,/-]+[\d½¼¾⅓⅔⅛]+)*)\s*(?:(?:cups?|tbsps?|tablespoons?|tsps?|teaspoons?|lbs?|pounds?|oz|ounces?|g|grams?|kg|ml|l|liters?|litres?|cloves?|cans?|pinch(?:es)?|dash(?:es)?|slices?|sticks?|bunch(?:es)?)\b\.?)?)\s+(.+)$/i;

/** Splits "1 lb ground beef" into { quantity: "1 lb", name: "ground beef" }. */
export function splitIngredient(line: string): Recipe["ingredients"][number] {
  const text = line.replace(/\s+/g, " ").trim();
  const match = QUANTITY.exec(text);
  return match ? { quantity: match[1]!.trim(), name: match[2]!.trim() } : { name: text };
}

const asText = (v: unknown): string | undefined =>
  typeof v === "string" ? v.replace(/<[^>]+>/g, "").trim() || undefined : undefined;

function steps(value: unknown): string[] {
  if (typeof value === "string")
    return value
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  if (Array.isArray(value)) return value.flatMap(steps);
  if (value && typeof value === "object") {
    const node = value as Record<string, unknown>;
    if (node.itemListElement) return steps(node.itemListElement);
    const text = asText(node.text) ?? asText(node.name);
    return text ? [text] : [];
  }
  return [];
}

function servings(value: unknown): number | undefined {
  for (const v of Array.isArray(value) ? value : [value]) {
    const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/**
 * Maps a schema.org Recipe JSON-LD node to our Recipe shape. Used by ai.extract's JSON-LD
 * fast path: when the result validates, no LLM call is made.
 */
export function recipeFromJsonLd(node: Record<string, unknown>): Recipe {
  const ingredients = Array.isArray(node.recipeIngredient) ? node.recipeIngredient : [];
  return {
    title: asText(node.name) ?? "",
    description: asText(node.description),
    servings: servings(node.recipeYield),
    prepTimeMinutes: parseIsoDuration(node.prepTime),
    cookTimeMinutes: parseIsoDuration(node.cookTime),
    totalTimeMinutes: parseIsoDuration(node.totalTime),
    ingredients: ingredients.filter((i): i is string => typeof i === "string").map(splitIngredient),
    steps: steps(node.recipeInstructions),
  };
}
