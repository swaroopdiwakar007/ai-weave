# Recipe app example

Paste a recipe URL to get a typed `Recipe` (title, times, servings, ingredients with quantities,
steps), stored in `data/recipes.json`.

```bash
pnpm install && pnpm build                 # from the repo root
pnpm --filter recipe-app demo              # offline: bundled pages + mock model, no keys needed

export ANTHROPIC_API_KEY=...               # and/or OPENAI_API_KEY, GEMINI_API_KEY
pnpm --filter recipe-app start https://www.bbcgoodfood.com/recipes/easy-pancakes
pnpm --filter recipe-app start URL --provider gemini --model gemini-2.5-flash
pnpm --filter recipe-app start URL --normalize    # let the model normalize the JSON-LD (hybrid)
pnpm --filter recipe-app start URL --no-jsonld    # always read the page with the model
pnpm --filter recipe-app start --list
```

## How it works

1. `webFetcher()` downloads the page safely and extracts the main content and the JSON-LD.
2. If the page has a schema.org `Recipe`, `recipeFromJsonLd` maps it, and the mapped data is
   validated with Zod. When it's valid, no model call is made, so it costs $0.
3. If there's no JSON-LD, or it's incomplete, the cleaned page goes to the model. The model returns
   JSON matching the `Recipe` schema, which is validated and repaired if needed.
4. Any other providers you have API keys for are used as automatic fallbacks.

See `src/cli.ts` for the ai-weave usage and `src/recipe.ts` for the schema and JSON-LD mapper.
