import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ThinkFilter, looksLikeReasoningModel, stripThinking } from "../agent/providers/think.js";
import { collect } from "../agent/providers/openai.js";

/** Feed a reply in pieces; returns what was shown and the answer kept. */
function run(pieces: string[], expect: boolean) {
  const f = new ThinkFilter(expect);
  let shown = pieces.map((p) => f.push(p)).join("");
  shown += f.end();
  return { shown, text: f.text, sawClose: f.sawClose };
}

describe("model thinking in replies", () => {
  test("a reply that starts mid-thought (only </think>) shows and keeps just the answer, when expected", () => {
    const r = run(["I should look at ", "the loop.</th", "ink>\n\nThe loop ", "is wrong."], true);
    assert.equal(r.shown, "The loop is wrong.");
    assert.equal(r.text, "The loop is wrong.");
    assert.ok(r.sawClose);
  });

  test("when expected but the model doesn't think, the whole reply is the answer", () => {
    const r = run(["Just ", "an answer."], true);
    assert.equal(r.shown, "Just an answer.");
    assert.ok(!r.sawClose);
  });

  test("<think>…</think> blocks are cut out while streaming, even split across pieces", () => {
    const r = run(["Before <thi", "nk>secret plan</think>", " after."], false);
    assert.equal(r.shown, "Before  after.");
    assert.equal(r.text, "Before  after.");
  });

  test("an unexpected </think> drops what came before from the answer kept, and is learned", () => {
    const r = run(["Hmm, thinking. ", "</think>\nThe answer."], false);
    assert.equal(r.text, "The answer.");
    assert.ok(r.sawClose);
    assert.doesNotMatch(r.shown, /<\/?think>/);
  });

  test("a reply cut off mid-thought shows nothing of the thinking", () => {
    assert.equal(run(["<think>still going"], false).shown, "");
  });

  test("ordinary text with angle brackets is untouched", () => {
    assert.equal(stripThinking("Use a < b and <div> tags; x <thinking-cap>"), "Use a < b and <div> tags; x <thinking-cap>");
  });

  test("reasoning models are recognised by name", () => {
    for (const m of ["forge-deepseek", "deepseek-r1:14b", "qwq", "qwen3:8b", "phi4-reasoning"]) assert.ok(looksLikeReasoningModel(m), m);
    for (const m of ["llama3.1", "gpt-5", "qwen2.5-coder", "mistral-large", "gemma3:r12"]) assert.ok(!looksLikeReasoningModel(m), m);
  });

  test("collect streams only the answer and keeps only the answer", async () => {
    const chunks = ["Let me think.", "</think>", "Answer", " here."].map((content, i, all) => ({
      choices: [{ index: 0, delta: { content }, finish_reason: i === all.length - 1 ? "stop" : null }],
    }));
    async function* stream() { for (const c of chunks) yield c; }
    const seen: string[] = [];
    const { ThinkFilter: F } = await import("../agent/providers/think.js");
    const reply = await collect(stream() as never, (d) => seen.push(d), new F(true));
    assert.equal(seen.join(""), "Answer here.");
    assert.equal(reply.text, "Answer here.");
  });

  test("when the server sends reasoning in its own field, the answer streams straight away", async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { reasoning: "thinking…" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "Ans" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "wer." }, finish_reason: "stop" }] },
    ];
    const seen: string[] = [];
    let shownBeforeEnd = "";
    async function* stream() { for (const c of chunks) { yield c; shownBeforeEnd = seen.join(""); } }
    const reply = await collect(stream() as never, (d) => seen.push(d), new ThinkFilter(true));
    assert.equal(reply.text, "Answer.");
    assert.equal(seen[0], "Ans", "the first piece was shown as it arrived, not held to the end");
  });
});
