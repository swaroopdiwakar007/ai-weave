/**
 * Default price table in USD per 1M tokens. Prices change, so verify them against
 * vendor pricing pages and override them via `createWeave({ pricing })`.
 * Keys are `provider:modelPrefix`. The longest matching prefix wins, so dated model ids like
 * `claude-sonnet-4-5-20250929` match `claude-sonnet-4-5`.
 * @module
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

export type PriceTable = Record<string, ModelPrice>;

export const DEFAULT_PRICES: PriceTable = {
  "anthropic:claude-opus-4-5": { input: 5, output: 25 },
  "anthropic:claude-opus-4": { input: 15, output: 75 },
  "anthropic:claude-sonnet-4": { input: 3, output: 15 },
  "anthropic:claude-3-7-sonnet": { input: 3, output: 15 },
  "anthropic:claude-haiku-4-5": { input: 1, output: 5 },
  "anthropic:claude-3-5-haiku": { input: 0.8, output: 4 },

  "openai:gpt-5-nano": { input: 0.05, output: 0.4 },
  "openai:gpt-5-mini": { input: 0.25, output: 2 },
  "openai:gpt-5": { input: 1.25, output: 10 },
  "openai:gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "openai:gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "openai:gpt-4.1": { input: 2, output: 8 },
  "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
  "openai:gpt-4o": { input: 2.5, output: 10 },

  "gemini:gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini:gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini:gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini:gemini-2.0-flash": { input: 0.1, output: 0.4 },
};

/** Finds the price for a provider/model by longest prefix match. */
export function findPrice(
  table: PriceTable,
  provider: string,
  model: string,
): ModelPrice | undefined {
  const key = `${provider}:${model}`;
  let best: { len: number; price: ModelPrice } | undefined;
  for (const [prefix, price] of Object.entries(table)) {
    if (key.startsWith(prefix) && (!best || prefix.length > best.len)) {
      best = { len: prefix.length, price };
    }
  }
  return best?.price;
}

/** Estimates the cost of a call in USD, or `undefined` if the model is unknown. */
export function estimateCost(
  table: PriceTable,
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const price = findPrice(table, provider, model);
  if (!price) return undefined;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
