import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { formatChecks, runDoctor, type Check } from "../agent/doctor.js";
import { rcProblem } from "../agent/models.js";

const NOWHERE = "http://127.0.0.1:9";

/** A fake OpenAI-compatible server: lists one model, or rejects every key with 401. */
let server: http.Server;
let base = "";
before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization === "Bearer wrong") {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: "bad key" } }));
    }
    if (req.url === "/v1/models") return res.end(JSON.stringify({ object: "list", data: [{ id: "coder:latest", object: "model" }] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => server.close());

function folder(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-doctor-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
const doctor = (env: Record<string, string>, cwd = folder()) => runDoctor({ cwd, env, mcp: false, engramUrl: NOWHERE });
const find = (checks: Check[], name: string) => checks.find((c) => c.name === name);

describe("forge doctor — the model", () => {
  test("a local server that has the model passes; ':latest' counts", async () => {
    const checks = await doctor({ FORGE_PROVIDER: "lmstudio", FORGE_MODEL: "coder", FORGE_BASE_URL: base, FORGE_CONTEXT: "32768" });
    assert.equal(find(checks, "Model server")!.state, "ok");
    assert.equal(find(checks, "API key")!.detail, "none needed");
    assert.deepEqual(find(checks, "Context window"), { name: "Context window", state: "ok", detail: "32,768 tokens" });
  });

  test("a model the local server doesn't have fails, and says how to get it", async () => {
    const checks = await doctor({ FORGE_PROVIDER: "ollama", FORGE_MODEL: "missing", FORGE_BASE_URL: base });
    const s = find(checks, "Model server")!;
    assert.equal(s.state, "fail");
    assert.match(s.detail, /has no model named missing/);
    assert.match(s.fix!, /ollama pull missing/);
    assert.equal(find(checks, "Context window"), undefined, "no window check once the server has failed");
  });

  test("a server that can't be reached fails with how to start it", async () => {
    const s = find(await doctor({ FORGE_PROVIDER: "ollama", FORGE_MODEL: "coder", FORGE_BASE_URL: `${NOWHERE}/v1` }), "Model server")!;
    assert.equal(s.state, "fail");
    assert.match(s.detail, /couldn't reach/);
    assert.match(s.fix!, /ollama serve/);
  });

  test("a rejected key fails; a missing key fails without contacting anyone", async () => {
    const rejected = await doctor({ FORGE_PROVIDER: "groq", FORGE_MODEL: "coder", FORGE_BASE_URL: base, GROQ_API_KEY: "wrong" });
    assert.match(find(rejected, "Model server")!.detail, /rejected the key \(401\)/);

    const missing = await doctor({ FORGE_PROVIDER: "groq", FORGE_MODEL: "coder", FORGE_BASE_URL: base });
    assert.equal(find(missing, "API key")!.state, "fail");
    assert.match(find(missing, "API key")!.fix!, /export GROQ_API_KEY=/);
    assert.equal(find(missing, "Model server"), undefined);
  });

  test("the key itself is never printed", async () => {
    const checks = await doctor({ FORGE_PROVIDER: "groq", FORGE_MODEL: "coder", FORGE_BASE_URL: base, GROQ_API_KEY: "gsk-secret-value" });
    assert.doesNotMatch(JSON.stringify(checks) + formatChecks(checks), /gsk-secret-value/);
  });

  test("a hosted model missing from the list is a warning, not a failure", async () => {
    const s = find(await doctor({ FORGE_PROVIDER: "groq", FORGE_MODEL: "other", FORGE_BASE_URL: base, GROQ_API_KEY: "ok" }), "Model server")!;
    assert.equal(s.state, "warn");
  });

  test("a small or unknown context window is a warning", async () => {
    const small = find(await doctor({ FORGE_PROVIDER: "lmstudio", FORGE_MODEL: "coder", FORGE_BASE_URL: base, FORGE_CONTEXT: "4096" }), "Context window")!;
    assert.equal(small.state, "warn");
    assert.match(small.detail, /4,096 tokens; too small/);

    const unknown = find(await doctor({ FORGE_PROVIDER: "groq", FORGE_MODEL: "coder", FORGE_BASE_URL: base, GROQ_API_KEY: "ok" }), "Context window")!;
    assert.match(unknown.detail, /compaction is off/);
  });
});

describe("forge doctor — the project", () => {
  const env = { FORGE_PROVIDER: "lmstudio", FORGE_MODEL: "coder", FORGE_BASE_URL: base, FORGE_CONTEXT: "32768" };

  test("no policy, no git, no index: warnings, each with a fix", async () => {
    const checks = await doctor(env);
    for (const name of ["Policy", "Git", "Project index", "Engram memory"]) {
      assert.equal(find(checks, name)!.state, "warn", name);
      assert.ok(find(checks, name)!.fix, `${name} has a fix`);
    }
  });

  test("a policy is counted; rules that can never match are named", async () => {
    const good = "version: 1\ndefault: deny\nrules:\n  - { id: reads, resource: filesystem, operation: read, target: '**', effect: allow }\n";
    assert.equal(find(await doctor(env, folder({ "forge.policy.yaml": good })), "Policy")!.detail, "1 rules, default deny");

    const odd = good + "  - { id: npm-any, resource: shell, operation: 'npm *', target: '*', effect: allow }\n  - { id: typo, resource: files, operation: read, target: '*', effect: allow }\n";
    const p = find(await doctor(env, folder({ "forge.policy.yaml": odd })), "Policy")!;
    assert.equal(p.state, "warn");
    assert.match(p.detail, /npm-any, typo/);
  });

  test("a policy that can't be read fails", async () => {
    const p = find(await doctor(env, folder({ "forge.policy.yaml": "rules:\n  - { id: x, resource: shell }\n" })), "Policy")!;
    assert.equal(p.state, "fail");
    assert.match(p.detail, /missing required fields/);
  });
});

describe("forge doctor — output", () => {
  test("rcProblem: missing and valid files are fine; broken ones say why", () => {
    const dir = folder({ ok: '{"provider":"ollama"}', bad: "{nope", list: "[]" });
    assert.equal(rcProblem(path.join(dir, "absent")), null);
    assert.equal(rcProblem(path.join(dir, "ok")), null);
    assert.match(rcProblem(path.join(dir, "bad"))!, /isn't valid JSON/);
    assert.match(rcProblem(path.join(dir, "list"))!, /isn't a JSON object/);
  });

  test("the summary counts problems and warnings; fixes show only for what isn't ok", () => {
    const text = formatChecks([
      { name: "A", state: "ok", detail: "fine", fix: "never shown" },
      { name: "B", state: "warn", detail: "meh", fix: "do b" },
      { name: "C", state: "fail", detail: "broken", fix: "do c" },
    ]);
    assert.match(text, /✓ A  fine/);
    assert.doesNotMatch(text, /never shown/);
    assert.match(text, /→ do b/);
    assert.match(text, /1 problem to fix before Forge can work, 1 warning\./);
    assert.match(formatChecks([{ name: "A", state: "ok", detail: "x" }]), /Ready\./);
  });
});
