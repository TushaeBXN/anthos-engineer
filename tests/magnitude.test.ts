import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PROVIDERS, detectContextWindow, resolveModel } from "../agent/models.js";
import { runDoctor, type Check } from "../agent/doctor.js";
import { openaiSession } from "../agent/providers/openai.js";

const MODEL = "gemma-4-e4b-it-qat:gguf:q4";

/**
 * A stand-in for Magnitude's API (magnitude.dev): the same paths, and the model list in the shape
 * its server sends (inference/service/api: OpenAiModel), with context_length.
 */
let server: http.Server;
let base = "";
const seen: Array<{ url?: string; auth?: string; body?: Record<string, unknown> }> = [];
before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
      if (req.url === "/inference/v1/models") {
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({
          object: "list",
          data: [{
            id: MODEL, object: "model", created: 0, owned_by: "magnitude", name: "Gemma 4 E4B (QAT Q4)", description: "",
            context_length: 65536, architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            supported_parameters: ["tools"], top_provider: { context_length: 65536, max_completion_tokens: 16384 },
          }],
        }));
      }
      if (req.url === "/inference/v1/chat/completions") {
        res.setHeader("Content-Type", "text/event-stream");
        const chunk = (delta: object, finish: string | null = null) =>
          res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
        chunk({ role: "assistant", content: "Hello " });
        chunk({ content: "from Magnitude." }, "stop");
        res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/inference/v1`;
});
after(() => server.close());

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), "forge-magnitude-"));
const doctor = (env: Record<string, string>) => runDoctor({ cwd: folder(), env, mcp: false, engramUrl: "http://127.0.0.1:9" });
const find = (checks: Check[], name: string) => checks.find((c) => c.name === name)!;

describe("Magnitude provider", () => {
  test("is a local, open, keyless-by-default provider at Magnitude's own address", () => {
    const info = resolveModel({ FORGE_PROVIDER: "magnitude", FORGE_MODEL: MODEL });
    assert.equal(info.runs, "local");
    assert.equal(info.weights, "open");
    assert.equal(info.baseUrl, "http://127.0.0.1:10100/inference/v1");
    assert.deepEqual(info.price, { input: 0, output: 0 });
    assert.equal(info.apiKey, undefined);
    assert.equal(PROVIDERS["magnitude"]!.keyEnv, "MAGNITUDE_API_KEY");
  });

  test("with no model chosen, doctor lists the models Magnitude has", async () => {
    const m = find(await doctor({ FORGE_PROVIDER: "magnitude", FORGE_BASE_URL: base }), "Model");
    assert.equal(m.state, "fail");
    assert.match(m.detail, new RegExp(`magnitude has: ${MODEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(m.fix!, /forge config set model/);
  });

  test("doctor: no key needed on this computer, server found, context window read from Magnitude", async () => {
    const checks = await doctor({ FORGE_PROVIDER: "magnitude", FORGE_MODEL: MODEL, FORGE_BASE_URL: base });
    assert.equal(find(checks, "API key").state, "ok");
    assert.match(find(checks, "API key").detail, /none needed on this computer.*MAGNITUDE_API_KEY/);
    assert.equal(find(checks, "Model server").state, "ok");
    assert.equal(find(checks, "Context window").detail, "65,536 tokens");
  });

  test("doctor: a model Magnitude doesn't have names the ones it does", async () => {
    const s = find(await doctor({ FORGE_PROVIDER: "magnitude", FORGE_MODEL: "qwen3:gguf:q4", FORGE_BASE_URL: base }), "Model server");
    assert.equal(s.state, "fail");
    assert.match(s.detail, /It has: gemma-4-e4b-it-qat:gguf:q4/);
    assert.match(s.fix!, /Magnitude app/);
  });

  test("doctor: no model chosen and Magnitude not running says how to start it", async () => {
    const m = find(await doctor({ FORGE_PROVIDER: "magnitude", FORGE_BASE_URL: "http://127.0.0.1:9/inference/v1" }), "Model");
    assert.match(m.detail, /No model chosen, and magnitude isn't answering/);
    assert.match(m.fix!, /magnitude serve.*forge doctor again/);
  });

  test("doctor: Magnitude not running says how to start it", async () => {
    const s = find(await doctor({ FORGE_PROVIDER: "magnitude", FORGE_MODEL: MODEL, FORGE_BASE_URL: "http://127.0.0.1:9/inference/v1" }), "Model server");
    assert.equal(s.state, "fail");
    assert.match(s.fix!, /magnitude serve/);
  });

  test("context window detection is remembered for the status line", async () => {
    assert.equal(await detectContextWindow({ FORGE_PROVIDER: "magnitude", FORGE_MODEL: MODEL, FORGE_BASE_URL: base }), 65536);
    assert.equal(resolveModel({ FORGE_PROVIDER: "magnitude", FORGE_MODEL: MODEL, FORGE_BASE_URL: base }).contextWindow, 65536);
  });

  test("a conversation streams through Magnitude's chat endpoint; a key is sent only when set", async () => {
    seen.length = 0;
    const info = resolveModel({ FORGE_PROVIDER: "magnitude", FORGE_MODEL: MODEL, FORGE_BASE_URL: base, MAGNITUDE_API_KEY: "remote-key" });
    const session = openaiSession(info.model, "Be brief.", [], info.baseUrl, info.apiKey);
    const pieces: string[] = [];
    const reply = await session.send("hi", (d) => pieces.push(d));
    assert.equal(reply.text, "Hello from Magnitude.");
    assert.ok(pieces.length >= 2, "streamed in pieces");
    const call = seen.find((r) => r.url === "/inference/v1/chat/completions")!;
    assert.equal(call.body!["model"], MODEL);
    assert.equal(call.auth, "Bearer remote-key");
  });
});
