import type { z } from "zod";
import { resolveConfig, type WeaveConfig, type WeaveContext } from "./engine.js";
import type { Schema } from "./schema.js";
import type { Provider } from "./types.js";
import { runExtract, type ExtractOptions, type ExtractResult } from "./tasks/extract.js";
import { runGenerate, type GenerateOptions, type GenerateResult } from "./tasks/generate.js";
import {
  runGenerateObject,
  type GenerateObjectOptions,
  type GenerateObjectResult,
} from "./tasks/object.js";
import {
  runClassify,
  runSummarize,
  type ClassifyOptions,
  type ClassifyResult,
  type SummarizeOptions,
  type SummarizeResult,
} from "./tasks/text.js";

/** The ai-weave client returned by {@link createWeave}. */
export interface Weave {
  /** Providers in fallback order (primary first). */
  readonly providers: readonly Provider[];
  /** Free-form text generation (supports tools; you run the tool loop). */
  generate(options: GenerateOptions): Promise<GenerateResult>;
  /** Generates an object validated against a Zod schema. */
  generateObject<S extends Schema>(
    options: GenerateObjectOptions<S>,
  ): Promise<GenerateObjectResult<z.output<S>>>;
  /** Extracts schema-shaped data from text, a URL or a fetched page. */
  extract<S extends Schema>(options: ExtractOptions<S>): Promise<ExtractResult<z.output<S>>>;
  /** Classifies text into one of the given labels. */
  classify<L extends string>(options: ClassifyOptions<L>): Promise<ClassifyResult<L>>;
  /** Summarizes text. */
  summarize(options: SummarizeOptions): Promise<SummarizeResult>;
}

/**
 * Creates an ai-weave client.
 *
 * @example
 * ```ts
 * const ai = createWeave({ provider: anthropic(), fallback: [openai()], fetcher: webFetcher() });
 * const { data } = await ai.extract({ url, schema: Recipe });
 * ```
 */
export function createWeave(config: WeaveConfig): Weave {
  const ctx: WeaveContext = resolveConfig(config);
  return {
    providers: ctx.providers,
    generate: (options) => runGenerate(ctx, options),
    generateObject: (options) => runGenerateObject(ctx, options),
    extract: (options) => runExtract(ctx, options),
    classify: (options) => runClassify(ctx, options),
    summarize: (options) => runSummarize(ctx, options),
  };
}
