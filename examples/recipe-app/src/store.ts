import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractMethod } from "@ai-weave/core";
import type { Recipe } from "./recipe.js";

export interface SavedRecipe {
  id: string;
  savedAt: string;
  sourceUrl?: string;
  method: ExtractMethod;
  recipe: Recipe;
}

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../data/recipes.json");

/** Tiny JSON-file store; swap for your database. */
export async function loadRecipes(): Promise<SavedRecipe[]> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as SavedRecipe[];
  } catch {
    return [];
  }
}

export async function saveRecipe(entry: Omit<SavedRecipe, "id" | "savedAt">): Promise<SavedRecipe> {
  const all = await loadRecipes();
  const saved: SavedRecipe = {
    id: crypto.randomUUID(),
    savedAt: new Date().toISOString(),
    ...entry,
  };
  const rest = all.filter((r) => !entry.sourceUrl || r.sourceUrl !== entry.sourceUrl);
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify([...rest, saved], null, 2));
  return saved;
}
