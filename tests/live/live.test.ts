/**
 * Opt-in live tests against real APIs: `LIVE=1 pnpm test:live`.
 * Each provider runs only if its API key is set.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createWeave, type Provider } from "@ai-weave/core";
import { anthropic } from "@ai-weave/anthropic";
import { openai } from "@ai-weave/openai";
import { gemini } from "@ai-weave/gemini";

const live = process.env.LIVE === "1";
const providers: Array<[string, () => Provider, boolean]> = [
  [
    "anthropic",
    () => anthropic({ model: process.env.ANTHROPIC_MODEL }),
    !!process.env.ANTHROPIC_API_KEY,
  ],
  ["openai", () => openai({ model: process.env.OPENAI_MODEL }), !!process.env.OPENAI_API_KEY],
  [
    "gemini",
    () => gemini({ model: process.env.GEMINI_MODEL }),
    !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
  ],
];

const Recipe = z.object({
  title: z.string(),
  servings: z.number().optional(),
  ingredients: z.array(z.object({ name: z.string(), quantity: z.string().optional() })).min(1),
  steps: z.array(z.string()).min(1),
});

const text = `Easy Pancakes (makes 8). Whisk 1 cup flour, 1 egg, 1 cup milk and a pinch of salt.
Heat a pan, pour 1/4 cup batter per pancake, flip when bubbles appear.`;

for (const [name, create, hasKey] of providers) {
  describe.skipIf(!live || !hasKey)(`live: ${name}`, () => {
    it("generates text", { timeout: 60_000 }, async () => {
      const ai = createWeave({ provider: create() });
      const { text: out, usage } = await ai.generate({
        prompt: "Reply with exactly: pong",
        maxTokens: 50,
      });
      expect(out.toLowerCase()).toContain("pong");
      expect(usage.inputTokens).toBeGreaterThan(0);
    });

    it("extracts a typed recipe", { timeout: 90_000 }, async () => {
      const ai = createWeave({ provider: create() });
      const { data, usage } = await ai.extract({ text, schema: Recipe });
      expect(data.title.toLowerCase()).toContain("pancake");
      expect(data.ingredients.length).toBeGreaterThanOrEqual(3);
      console.log(name, usage);
    });
  });
}
