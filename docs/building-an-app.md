# Building an app with ai-weave

This guide plans a complete app (**RecipeBox**, a web app for saving and cooking recipes) on top of
ai-weave. It then shows shorter examples for other kinds of apps. Every snippet uses APIs that ship
today (v0.1):

- `generate`, `generateObject`, `extract`, `classify`, `summarize`
- the Anthropic, OpenAI and Gemini providers
- `webFetcher`
- `mockProvider`

Features that depend on later phases (chat, AI search) are marked **⏳**.

---

## 1. What you can build today

| App               | AI feature                                      | ai-weave call                                         |
| ----------------- | ----------------------------------------------- | ----------------------------------------------------- |
| Recipe saver      | Paste a URL → structured recipe                 | `extract({ url, schema, jsonLd })`                    |
| Job tracker       | Paste a job post → company, salary, skills      | `extract({ url, schema })`                            |
| Reading list      | Save an article → summary and tags              | `extract` + `summarize` + `classify`                  |
| Support inbox     | Route tickets, draft replies                    | `classify` + `generateObject`                         |
| Expense tracker   | Paste a receipt email → line items              | `extract({ text, schema })`                           |
| Real-estate notes | Listing URL → price, beds, sq ft, pros and cons | `extract` + `generateObject`                          |
| Event aggregator  | Event page → date, venue, price                 | `extract({ url, schema, jsonLd: { type: "Event" } })` |
| Product compare   | Two product URLs → comparison table             | `extract` ×2 + `generateObject`                       |

The pattern is always the same: **a Zod schema describes what your app stores**, and ai-weave turns
messy input into that shape.

---

## 2. Reference app: RecipeBox

### Features

| #   | Feature                                               | How                                             | Phase      |
| --- | ----------------------------------------------------- | ----------------------------------------------- | ---------- |
| F1  | Import a recipe from a URL                            | `extract` with the JSON-LD fast path (often $0) | ✅ now     |
| F2  | Import from pasted text (e.g. a message from grandma) | `extract({ text })`                             | ✅ now     |
| F3  | Auto-tag cuisine, meal type and diet                  | `classify` ×3 in parallel                       | ✅ now     |
| F4  | Short card description                                | `summarize`                                     | ✅ now     |
| F5  | Scale servings and convert units                      | `generateObject`                                | ✅ now     |
| F6  | Weekly meal plan and shopping list                    | `generateObject`                                | ✅ now     |
| F7  | "I'm out of buttermilk" ingredient substitutions      | `generateObject`                                | ✅ now     |
| F8  | Cost dashboard (AI spend per user)                    | `onUsage` hook                                  | ✅ now     |
| F9  | Chat assistant: "save this link and plan dinners"     | `ai.chat` + `<ChatWidget/>`                     | ⏳ Phase 2 |
| F10 | Semantic search: "quick vegetarian dinner"            | `ai.search.index(...).query()`                  | ⏳ Phase 3 |

### Architecture

```
Browser (Next.js pages, React)
   │  fetch / server actions        ← no API keys in the browser
   ▼
Next.js route handlers (Node runtime)
   ├─ lib/ai.ts       createWeave(): provider + fallback + webFetcher + onUsage
   ├─ lib/schemas.ts  Zod schemas = the app's data contract
   └─ lib/db.ts       Prisma/Drizzle (SQLite → Postgres)
   ▼
Claude / OpenAI / Gemini         recipe websites (via the SSRF-safe webFetcher)
```

**Stack:** Next.js (App Router), TypeScript, Zod, Prisma + SQLite, and ai-weave. Use the Node
runtime for AI routes: `webFetcher` checks DNS answers with `node:dns`, and on edge runtimes that
check is skipped.

### Folder structure

```
recipebox/
  app/
    page.tsx                      # recipe list
    import/page.tsx               # paste a URL or text
    recipes/[id]/page.tsx         # recipe detail, scale, substitutions
    plan/page.tsx                 # meal plan + shopping list
    api/
      recipes/import/route.ts     # F1, F2, F3, F4
      recipes/[id]/scale/route.ts # F5
      plan/route.ts               # F6
      substitute/route.ts         # F7
  lib/
    ai.ts                         # the single ai-weave client
    schemas.ts                    # Zod schemas
    recipe-jsonld.ts              # schema.org → Recipe mapper (copy from examples/recipe-app)
    errors.ts                     # ai-weave errors → HTTP responses
    db.ts
  tests/
    import.test.ts                # mockProvider, no network
```

### Data model

```prisma
model Recipe {
  id          String   @id @default(cuid())
  userId      String
  sourceUrl   String?
  method      String   // "jsonld" | "hybrid" | "llm" (how it was extracted)
  data        Json     // validated Recipe (lib/schemas.ts)
  summary     String?
  cuisine     String?
  mealType    String?
  diet        String?
  createdAt   DateTime @default(now())
  @@unique([userId, sourceUrl])
}

model AiUsage {
  id        String   @id @default(cuid())
  userId    String?
  task      String
  provider  String
  model     String
  tokens    Int
  costUsd   Float?
  createdAt DateTime @default(now())
}
```

---

## 3. Step by step

### Step 1: Install

ai-weave isn't on npm yet. Until it is, either build your app inside the monorepo (`examples/recipebox`,
which becomes a pnpm workspace member automatically) or pack the packages:

```bash
# inside the ai-weave repo
pnpm build
cd packages/core && pnpm pack   # repeat for anthropic, openai, gemini, web
# in your app
npm i ../ai-weave/packages/core/ai-weave-core-0.1.0.tgz ... zod
```

After publishing: `npm i @ai-weave/core @ai-weave/anthropic @ai-weave/openai @ai-weave/web zod`.

`.env.local`:

```
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...        # optional fallback
```

### Step 2: One AI client for the whole app (`lib/ai.ts`)

```ts
import "server-only"; // Next.js: fails the build if imported from client code
import { createWeave } from "@ai-weave/core";
import { anthropic } from "@ai-weave/anthropic";
import { openai } from "@ai-weave/openai";
import { webFetcher } from "@ai-weave/web";
import { db } from "./db";

export const ai = createWeave({
  provider: anthropic({ model: "claude-haiku-4-5" }), // fast and cheap for extraction
  fallback: process.env.OPENAI_API_KEY ? [openai({ model: "gpt-4o-mini" })] : [],
  fetcher: webFetcher({ timeoutMs: 15_000 }),
  timeoutMs: 45_000,
  onUsage: (u) =>
    void db.aiUsage.create({
      data: {
        task: u.task,
        provider: u.provider,
        model: u.model,
        tokens: u.totalTokens,
        costUsd: u.costUsd,
      },
    }),
  onError: (e) =>
    console.warn(`[ai] ${e.provider} attempt ${e.attempt + 1}:`, (e.error as Error).message),
});
```

### Step 3: Schemas are the contract (`lib/schemas.ts`)

```ts
import { z } from "zod";

export const Ingredient = z.object({
  name: z.string().min(1),
  quantity: z.string().optional().describe("Amount with unit, e.g. '2 cups'"),
});

export const Recipe = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  servings: z.number().int().positive().optional(),
  prepTimeMinutes: z.number().nonnegative().optional(),
  cookTimeMinutes: z.number().nonnegative().optional(),
  totalTimeMinutes: z.number().nonnegative().optional(),
  ingredients: z.array(Ingredient).min(1),
  steps: z.array(z.string().min(1)).min(1),
});
export type Recipe = z.infer<typeof Recipe>;

export const CUISINES = [
  "italian",
  "indian",
  "mexican",
  "chinese",
  "japanese",
  "thai",
  "french",
  "mediterranean",
  "american",
  "other",
] as const;
export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "dessert", "snack", "drink"] as const;
export const DIETS = ["vegan", "vegetarian", "pescatarian", "gluten-free", "none"] as const;
```

### Step 4: Import a recipe, F1–F4 (`app/api/recipes/import/route.ts`)

```ts
import { z } from "zod";
import { ai } from "@/lib/ai";
import { Recipe, CUISINES, MEAL_TYPES, DIETS } from "@/lib/schemas";
import { recipeFromJsonLd } from "@/lib/recipe-jsonld";
import { toHttpError } from "@/lib/errors";
import { db } from "@/lib/db";
import { getUserId } from "@/lib/auth";

export const runtime = "nodejs";

const Body = z.union([
  z.object({ url: z.string().url() }),
  z.object({ text: z.string().min(20).max(50_000) }),
]);

export async function POST(req: Request) {
  const userId = await getUserId(req);
  const body = Body.safeParse(await req.json());
  if (!body.success) return Response.json({ error: "Send { url } or { text }" }, { status: 400 });

  try {
    // 1. Extract. On most recipe sites the JSON-LD mapper succeeds and no LLM call is made.
    const { data: recipe, source } = await ai.extract({
      ...body.data,
      schema: Recipe,
      jsonLd: { type: "Recipe", map: recipeFromJsonLd },
      instructions:
        "Split each ingredient into quantity (with unit) and name. Keep original units.",
      signal: req.signal, // stop paying if the user navigates away
    });

    // 2. Enrich in parallel. These are small calls, so a cheap model is fine.
    const input = `${recipe.title}\n${recipe.ingredients.map((i) => i.name).join(", ")}`;
    const [cuisine, mealType, diet, summary] = await Promise.all([
      ai.classify({ input, labels: CUISINES }),
      ai.classify({ input, labels: MEAL_TYPES }),
      ai.classify({
        input,
        labels: DIETS,
        instructions: "Pick the most restrictive diet the recipe satisfies.",
      }),
      ai.summarize({ input: JSON.stringify(recipe), maxWords: 30 }),
    ]);

    const saved = await db.recipe.upsert({
      where: {
        userId_sourceUrl: { userId, sourceUrl: source.url ?? `text:${crypto.randomUUID()}` },
      },
      update: {},
      create: {
        userId,
        sourceUrl: source.url,
        method: source.method,
        data: recipe,
        summary: summary.text,
        cuisine: cuisine.label,
        mealType: mealType.label,
        diet: diet.label,
      },
    });
    return Response.json(saved, { status: 201 });
  } catch (error) {
    return toHttpError(error);
  }
}
```

### Step 5: Turn errors into good UX (`lib/errors.ts`)

```ts
import {
  AbortError,
  AllProvidersFailedError,
  FetchError,
  RateLimitError,
  ValidationError,
} from "@ai-weave/core";

export function toHttpError(error: unknown): Response {
  if (error instanceof FetchError)
    return Response.json(
      { error: "We couldn't open that page. Check the link, or paste the recipe text instead." },
      { status: 422 },
    );
  if (error instanceof ValidationError)
    return Response.json(
      { error: "That page doesn't look like a recipe.", details: error.issues },
      { status: 422 },
    );
  if (error instanceof RateLimitError || error instanceof AllProvidersFailedError)
    return Response.json(
      { error: "Our AI is busy. Please try again in a minute." },
      { status: 503 },
    );
  if (error instanceof AbortError) return new Response(null, { status: 499 });
  console.error(error);
  return Response.json({ error: "Something went wrong." }, { status: 500 });
}
```

### Step 6: Scale servings and convert units, F5

```ts
const Scaled = z.object({
  servings: z.number().int().positive(),
  ingredients: z.array(Ingredient),
});

export async function scaleRecipe(recipe: Recipe, servings: number, units: "metric" | "us") {
  const { data } = await ai.generateObject({
    schema: Scaled,
    system:
      "You are a precise kitchen assistant. Scale quantities exactly and convert units sensibly.",
    prompt: `Scale this recipe to ${servings} servings using ${units} units.\n${JSON.stringify(recipe.ingredients)}`,
    temperature: 0,
  });
  return data;
}
```

### Step 7: Weekly meal plan and shopping list, F6

```ts
const MealPlan = z.object({
  days: z
    .array(
      z.object({
        day: z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
        recipeId: z.string(),
        reason: z.string().max(120),
      }),
    )
    .length(7),
  shoppingList: z.array(
    z.object({
      item: z.string(),
      quantity: z.string(),
      aisle: z.enum(["produce", "dairy", "meat", "pantry", "frozen", "bakery", "other"]),
    }),
  ),
});

export async function planWeek(recipes: { id: string; data: Recipe }[], preferences: string) {
  const catalog = recipes.map((r) => ({
    id: r.id,
    title: r.data.title,
    ingredients: r.data.ingredients,
  }));
  const { data, usage } = await ai.generateObject({
    schema: MealPlan,
    system:
      "Plan varied dinners from the user's saved recipes only. Merge duplicate shopping items.",
    prompt: `Preferences: ${preferences}\nSaved recipes:\n${JSON.stringify(catalog)}`,
    maxTokens: 4000,
  });
  // Guard against hallucinated ids. The schema can't know your database.
  const ids = new Set(recipes.map((r) => r.id));
  if (!data.days.every((d) => ids.has(d.recipeId)))
    throw new Error("Plan referenced an unknown recipe");
  return { plan: data, costUsd: usage.costUsd };
}
```

### Step 8: Ingredient substitutions, F7

```ts
const Substitutes = z.object({
  options: z
    .array(
      z.object({
        substitute: z.string(),
        amount: z.string(),
        impact: z.string().describe("How taste or texture changes"),
      }),
    )
    .min(1)
    .max(3),
});

const { data } = await ai.generateObject({
  schema: Substitutes,
  prompt: `Recipe: ${recipe.title}. I'm out of "${ingredient}". Suggest substitutes.`,
});
```

### Step 9: Test without API keys (`tests/import.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { createWeave } from "@ai-weave/core";
import { mockProvider } from "@ai-weave/core/testing";
import { Recipe } from "@/lib/schemas";

describe("recipe import", () => {
  it("extracts from pasted text", async () => {
    const provider = mockProvider({
      responses: [
        {
          json: {
            title: "Pancakes",
            ingredients: [{ name: "flour", quantity: "1 cup" }],
            steps: ["Mix", "Fry"],
          },
        },
      ],
    });
    const ai = createWeave({ provider });
    const { data, source } = await ai.extract({
      text: "Pancakes: 1 cup flour. Mix and fry.",
      schema: Recipe,
    });
    expect(data.title).toBe("Pancakes");
    expect(source.method).toBe("llm");
    expect(provider.calls[0]!.messages.at(-1)!.content).toContain("<untrusted_content>");
  });
});
```

Inject the client so tests can swap it: export a `createAi()` factory from `lib/ai.ts`, or pass
`ai` into your service functions.

### Step 10 ⏳: Chat assistant (Phase 2) and semantic search (Phase 3)

Planned APIs. These **don't work yet**; they're shown so you can design for them now:

```ts
// Phase 2
const chat = ai.chat({
  system: "You are RecipeBox's kitchen assistant.",
  tools: {
    importRecipe: tool({
      input: z.object({ url: z.string().url() }),
      run: ({ url }) => importRecipe(url),
    }),
  },
  store: sqliteStore("./chat.db"),
});
// <ChatWidget endpoint="/api/ai" sessionId={user.id} />

// Phase 3
const index = ai.search.index("recipes", { embedder, vectorStore });
const { results, answer } = await index.query("quick vegetarian dinner", {
  answer: true,
  filter: { userId },
});
```

Until then, you can build a basic assistant with `ai.generate({ messages, tools })` and run the
tool loop yourself.

---

## 4. More app examples

### Job tracker: paste a job post

```ts
const Job = z.object({
  title: z.string(),
  company: z.string(),
  location: z.string().optional(),
  remote: z.enum(["remote", "hybrid", "onsite"]).optional(),
  salaryMin: z.number().optional(),
  salaryMax: z.number().optional(),
  currency: z.string().length(3).optional(),
  skills: z.array(z.string()).max(15),
  seniority: z.enum(["intern", "junior", "mid", "senior", "lead"]).optional(),
});

const { data: job } = await ai.extract({ url, schema: Job, jsonLd: { type: "JobPosting" } });
const { label: fit } = await ai.classify({
  input: `Job: ${JSON.stringify(job)}\nMy skills: TypeScript, React, Node, Postgres`,
  labels: {
    strong: "Meets nearly all requirements",
    partial: "Meets about half",
    weak: "Meets few",
  },
});
```

### Reading list: save an article, get a summary and tags

```ts
const page = await webFetcher().fetch(url); // fetch once, reuse for every task
const [summary, topic] = await Promise.all([
  ai.summarize({ input: page.content, maxWords: 60, format: "bullets" }),
  ai.classify({
    input: page.content.slice(0, 4000),
    labels: ["tech", "business", "science", "health", "culture", "other"],
  }),
]);
await db.bookmark.create({
  data: { url: page.url, title: page.title, summary: summary.text, topic: topic.label },
});
```

### Support inbox: triage and draft replies

```ts
const { label: priority } = await ai.classify({
  input: ticket.body,
  labels: {
    urgent: "Outage, data loss, payment failure",
    normal: "Bugs, how-to",
    low: "Feedback, feature ideas",
  },
});

const Draft = z.object({
  reply: z.string(),
  needsHuman: z.boolean().describe("True if refunds, legal or account security are involved"),
  suggestedArticleIds: z.array(z.string()).max(3),
});
const { data: draft } = await ai.generateObject({
  schema: Draft,
  system: `You draft polite support replies. Only cite these help articles: ${JSON.stringify(articles)}`,
  prompt: `Customer wrote:\n${ticket.body}`,
});
```

### Expense tracker: receipt email to line items

```ts
const Receipt = z.object({
  merchant: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.string().length(3),
  total: z.number(),
  items: z.array(z.object({ description: z.string(), amount: z.number() })),
  category: z.enum(["food", "travel", "software", "office", "other"]),
});
const { data } = await ai.extract({
  text: emailBody,
  schema: Receipt,
  instructions: "Dates as YYYY-MM-DD.",
});
```

### Local or private models (no data leaves your network)

```ts
const ai = createWeave({
  provider: openai({
    id: "ollama",
    baseURL: "http://localhost:11434/v1",
    model: "llama3.1",
    capabilities: { structuredOutput: false },
  }),
});
```

---

## 5. Delivery plan for RecipeBox

| Week  | Milestone                                                                  | Done when                                                                 |
| ----- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1     | Next.js skeleton, auth, DB, `lib/ai.ts`, schemas                           | `POST /api/recipes/import` saves a recipe from a URL                      |
| 2     | Import UI (URL + paste text), error messages, recipe detail page           | 20 real recipe URLs import correctly, and failures show friendly messages |
| 3     | Auto-tags, summaries, filters by cuisine/meal/diet, scaling and units      | Tags appear on cards, and scaling 4→6 servings is correct                 |
| 4     | Meal plan + shopping list, substitutions, usage dashboard, per-user limits | A plan is generated from saved recipes, and spend per user is visible     |
| 5     | Tests with `mockProvider`, an eval set of about 30 URLs, deploy            | CI green, extraction accuracy measured, app live                          |
| Later | Chat assistant (library Phase 2), semantic search (Phase 3)                | —                                                                         |

## 6. Production checklist

- [ ] Call ai-weave **only on the server** (`import "server-only"`). Keys go in env vars.
- [ ] Use the Node runtime for routes that fetch URLs (so DNS-level SSRF checks run).
- [ ] Add per-user rate limits and a monthly spend cap. Store `onUsage` events and refuse requests over budget.
- [ ] Pass `req.signal` so cancelled requests stop spending tokens.
- [ ] Choose a cheap model for `classify` and `summarize`, and a stronger one for hard extraction.
      Use two clients if needed.
- [ ] Validate model-chosen ids against your database (schemas can't know your data).
- [ ] Offer **"paste the text instead"** for sites that block bots (e.g. HTTP 402/403).
- [ ] Keep a fixed set of test URLs and re-run them when you change models or prompts.
- [ ] Tell users that AI-generated content (summaries, substitutions) may be imperfect.
