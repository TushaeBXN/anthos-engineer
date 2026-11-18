import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveModel } from "../agent/models.js";
import { UsageTracker } from "../agent/usage.js";

describe("resolveModel", () => {
  test("defaults to Anthropic's current Opus: closed, hosted, priced", () => {
    const model = resolveModel({});
    assert.equal(model.provider, "anthropic");
    assert.equal(model.model, "claude-opus-5-5");
    assert.equal(model.weights, "closed");
    assert.equal(model.runs, "hosted");
    assert.equal(model.contextWindow, 1_000_000);
    assert.deepEqual(model.price, { input: 4, output: 20 });
  });

  test("ollama is open, local and free, with its own address", () => {
    const model = resolveModel({ FORGE_PROVIDER: "ollama", FORGE_MODEL: "gemma" });
    assert.equal(model.weights, "open");
    assert.equal(model.runs, "local");
    assert.deepEqual(model.price, { input: 0, output: 0 });
    assert.equal(model.baseUrl, "http://localhost:11434/v1");
    assert.equal(model.contextWindow, null);
  });

  test("groq is open weights but hosted", () => {
    const model = resolveModel({ FORGE_PROVIDER: "groq" });
    assert.equal(model.weights, "open");
    assert.equal(model.runs, "hosted");
    assert.equal(model.price, null);
  });

  test("an unknown provider is hosted with unknown weights", () => {
    const model = resolveModel({ FORGE_PROVIDER: "acme", FORGE_MODEL: "m1", FORGE_BASE_URL: "https://acme.test/v1" });
    assert.equal(model.weights, "unknown");
    assert.equal(model.runs, "hosted");
    assert.equal(model.baseUrl, "https://acme.test/v1");
  });

  test("a provider without a default model asks for one", () => {
    assert.throws(() => resolveModel({ FORGE_PROVIDER: "lmstudio" }), /forge config set model/);
  });

  test("each provider reads only its own key", () => {
    const env = { OPENAI_API_KEY: "sk-openai", OPENROUTER_API_KEY: "sk-or" };
    const openrouter = resolveModel({ ...env, FORGE_PROVIDER: "openrouter", FORGE_MODEL: "x" });
    assert.equal(openrouter.keyEnv, "OPENROUTER_API_KEY");
    assert.equal(openrouter.apiKey, "sk-or");
    assert.equal(openrouter.baseUrl, "https://openrouter.ai/api/v1");

    const groq = resolveModel({ ...env, FORGE_PROVIDER: "groq" });
    assert.equal(groq.apiKey, undefined, "the OpenAI key is never sent to Groq");
  });

  test("local providers need no key; unknown ones use FORGE_API_KEY", () => {
    assert.equal(resolveModel({ FORGE_PROVIDER: "ollama", FORGE_MODEL: "m" }).keyEnv, null);
    const custom = resolveModel({ FORGE_PROVIDER: "acme", FORGE_MODEL: "m", FORGE_API_KEY: "k" });
    assert.equal(custom.keyEnv, "FORGE_API_KEY");
    assert.equal(custom.apiKey, "k");
  });

  test("context size and prices can be set by hand", () => {
    const model = resolveModel({
      FORGE_PROVIDER: "ollama", FORGE_MODEL: "gemma", FORGE_CONTEXT: "8192",
      FORGE_PRICE_INPUT: "1", FORGE_PRICE_OUTPUT: "2",
    });
    assert.equal(model.contextWindow, 8192);
    assert.deepEqual(model.price, { input: 1, output: 2 });
  });
});

describe("UsageTracker", () => {
  test("a hosted, closed model with a budget: used and left for both context and money", () => {
    const usage = new UsageTracker(resolveModel({}), 5);
    usage.addReply({ inputTokens: 50_000, cachedTokens: 10_000, outputTokens: 1_000 });
    usage.addLines("src/a.ts", 120, 30);
    usage.addLines("src/a.ts", 4, 1);
    usage.addLines("src/b.ts", 1, 0);

    // 50k × $4 + 10k × $4 × 0.1 + 1k × $20, per million = $0.224
    assert.equal(usage.costUsd?.toFixed(3), "0.224");
    assert.deepEqual(usage.statusParts(), [
      "claude-opus-5-5 · closed · hosted",
      "61k used, 939k left",
      "$0.22 used, $4.78 left",
      "+125 −31 in 2 files",
    ]);
  });

  test("without a budget, only what was spent is shown", () => {
    const usage = new UsageTracker(resolveModel({}));
    usage.addReply({ inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0 });
    assert.equal(usage.statusParts()[2], "$4.00 used");
  });

  test("a local open model: free, and no 'left' when the context size is unknown", () => {
    const usage = new UsageTracker(resolveModel({ FORGE_PROVIDER: "ollama", FORGE_MODEL: "gemma" }));
    usage.addReply({ inputTokens: 1_500, cachedTokens: 0, outputTokens: 300 });
    assert.deepEqual(usage.statusParts(), ["gemma · open · local", "1.8k used", "free"]);
  });

  test("unknown price: no money part at all rather than a guess", () => {
    const usage = new UsageTracker(resolveModel({ FORGE_PROVIDER: "groq" }));
    usage.addReply({ inputTokens: 10, cachedTokens: 0, outputTokens: 5 });
    assert.equal(usage.costUsd, null);
    assert.deepEqual(usage.statusParts(), ["llama-3.3-70b-versatile · open · hosted", "15 used"]);
  });

  test("context shows the size of the latest request; totals keep adding up", () => {
    const usage = new UsageTracker(resolveModel({}));
    usage.addReply({ inputTokens: 1_000, cachedTokens: 0, outputTokens: 100 });
    usage.addReply({ inputTokens: 200, cachedTokens: 1_100, outputTokens: 50 });
    assert.equal(usage.contextUsed, 1_350);
    assert.equal(usage.inputTokens, 1_200);
    assert.equal(usage.outputTokens, 150);
  });

  test("overBudget turns true when spending reaches the budget", () => {
    const usage = new UsageTracker(resolveModel({}), 0.01);
    assert.equal(usage.overBudget, false);
    usage.addReply({ inputTokens: 10_000, cachedTokens: 0, outputTokens: 0 });
    assert.equal(usage.overBudget, true);
  });
});
