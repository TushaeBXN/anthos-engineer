import { test } from "node:test";
import assert from "node:assert";
import { resolveModel, type ForgeRc } from "../agent/models.js";

const ollama: ForgeRc = { provider: "ollama", model: "forge-deepseek", context: 32768, baseUrl: "http://localhost:11434/v1" };

test("~/.forgerc's model is used for its own provider", () => {
  const info = resolveModel({}, ollama);
  assert.strictEqual(info.provider, "ollama");
  assert.strictEqual(info.model, "forge-deepseek");
  assert.strictEqual(info.contextWindow, 32768);
});

test("FORGE_PROVIDER for another provider uses that provider's default model, not the saved one", () => {
  const info = resolveModel({ FORGE_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test" }, ollama);
  assert.strictEqual(info.provider, "anthropic");
  assert.strictEqual(info.model, "claude-opus-5-5");
  assert.strictEqual(info.baseUrl, undefined);
  assert.strictEqual(info.weights, "closed");
  assert.notStrictEqual(info.contextWindow, 32768);
});

test("FORGE_PROVIDER naming the saved provider keeps the saved model, in any case", () => {
  assert.strictEqual(resolveModel({ FORGE_PROVIDER: "Ollama" }, ollama).model, "forge-deepseek");
});

test("FORGE_MODEL still wins over everything", () => {
  assert.strictEqual(resolveModel({ FORGE_PROVIDER: "anthropic", FORGE_MODEL: "claude-sonnet-5-5" }, ollama).model, "claude-sonnet-5-5");
});
