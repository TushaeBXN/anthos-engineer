import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { check } from "../policy/check.js";
import type { ForgePolicy } from "../policy/schema.js";
import { parseResults, webSearch } from "../tools/web.js";

const WHO = { agentId: "test", sessionId: "s1" };

const PAGE = `
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffetch.html&amp;rut=abc">Node.js <b>fetch</b> API</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">The <b>fetch</b>() API &amp; friends.</a>
</div>
<div class="result result--ad">
  <a class="result__a" href="//duckduckgo.com/y.js?ad_provider=x">Sponsored</a>
</div>
<div class="result results_links web-result ">
  <a class="result__a" href="https://example.com/direct">Direct &quot;link&quot;</a>
</div>`;

describe("web_search — parsing", () => {
  test("unwraps DuckDuckGo redirect links and strips tags and entities", () => {
    const [first] = parseResults(PAGE);
    assert.deepEqual(first, {
      title: "Node.js fetch API",
      url: "https://nodejs.org/api/fetch.html",
      snippet: "The fetch() API & friends.",
    });
  });

  test("skips ads and keeps direct links", () => {
    const results = parseResults(PAGE);
    assert.equal(results.length, 2);
    assert.equal(results[1]!.url, "https://example.com/direct");
    assert.equal(results[1]!.title, 'Direct "link"');
  });

  test("an empty page gives no results", () => {
    assert.deepEqual(parseResults("<html></html>"), []);
  });
});

describe("web_search — policy", () => {
  const access = webSearch.access({ query: "x" });

  test("is network access to duckduckgo.com", () => {
    assert.deepEqual(access, { kind: "network", operation: "search", target: "duckduckgo.com" });
  });

  test("no rule → ask", () => {
    const policy: ForgePolicy = { version: 1, default: "deny", rules: [] };
    assert.equal(check(access, policy, WHO).decision, "ask");
  });

  test("an allow rule lets it run without asking", () => {
    const policy: ForgePolicy = {
      version: 1,
      default: "deny",
      rules: [{ id: "allow-search", resource: "network", operation: "search", target: "*", effect: "allow" }],
    };
    assert.equal(check(access, policy, WHO).decision, "allow");
  });

  test("a deny rule blocks it", () => {
    const policy: ForgePolicy = {
      version: 1,
      default: "deny",
      rules: [{ id: "no-network", resource: "network", operation: "*", target: "*", effect: "deny" }],
    };
    assert.equal(check(access, policy, WHO).decision, "deny");
  });
});
