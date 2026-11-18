import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { check } from "../policy/check.js";
import type { ForgePolicy } from "../policy/schema.js";
import { htmlToText, parseResults, webFetch, webSearch } from "../tools/web.js";

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

describe("web_fetch — converting pages", () => {
  test("keeps headings, links, lists and code; drops scripts and navigation", () => {
    const text = htmlToText(`<html><body>
      <nav><a href="https://x.com/home">Home</a></nav>
      <script>alert(1)</script>
      <h2>Install &amp; run</h2>
      <p>See <a href="https://docs.example.com/start">the guide</a> and run <code>npm i</code>.</p>
      <ul><li>one</li><li>two</li></ul>
      <pre><span>const a = 1;</span></pre>
    </body></html>`);
    assert.match(text, /## Install & run/);
    assert.match(text, /\[the guide\]\(https:\/\/docs\.example\.com\/start\)/);
    assert.match(text, /`npm i`/);
    assert.match(text, /- one\n- two/);
    assert.match(text, /```\nconst a = 1;\n```/);
    assert.doesNotMatch(text, /alert|Home/);
  });

  test("prefers <main> when the page has one", () => {
    const text = htmlToText("<body><div>sidebar junk</div><main><p>The article.</p></main></body>");
    assert.match(text, /The article\./);
    assert.doesNotMatch(text, /sidebar/);
  });
});

describe("web_fetch — requests", () => {
  let server: http.Server;
  let port = 0;

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body><h1>Hello</h1><p>World</p></body></html>");
      } else if (req.url === "/same-host") {
        res.writeHead(302, { location: "/page" });
        res.end();
      } else if (req.url === "/other-host") {
        res.writeHead(302, { location: `http://localhost:${port}/page` });
        res.end();
      } else if (req.url === "/image") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.from([0x89, 0x50]));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(() => server.close());

  const base = () => `http://127.0.0.1:${port}`;

  test("policy target is the host being contacted", () => {
    assert.deepEqual(webFetch.access({ url: "https://docs.example.com/a?b=c" }), {
      kind: "network",
      operation: "fetch",
      target: "docs.example.com",
    });
  });

  test("fetches HTML as text", async () => {
    const result = await webFetch.run({ url: `${base()}/page` }, ".");
    assert.equal(result.isError, undefined);
    assert.match(result.output, /# Hello/);
    assert.match(result.output, /World/);
  });

  test("follows a redirect on the same host", async () => {
    const result = await webFetch.run({ url: `${base()}/same-host` }, ".");
    assert.match(result.output, /# Hello/);
  });

  test("does not follow a redirect to another host, so the policy can check it", async () => {
    const result = await webFetch.run({ url: `${base()}/other-host` }, ".");
    assert.match(result.output, /redirects to a different host: http:\/\/localhost:\d+\/page/);
    assert.doesNotMatch(result.output, /# Hello/);
  });

  test("refuses binary content", async () => {
    const result = await webFetch.run({ url: `${base()}/image` }, ".");
    assert.equal(result.isError, true);
    assert.match(result.output, /image\/png/);
  });

  test("reports HTTP errors", async () => {
    const result = await webFetch.run({ url: `${base()}/missing` }, ".");
    assert.equal(result.isError, true);
    assert.match(result.output, /HTTP 404/);
  });

  test("refuses anything but http and https", async () => {
    const result = await webFetch.run({ url: "file:///etc/passwd" }, ".");
    assert.equal(result.isError, true);
    assert.match(result.output, /Only http and https/);
  });
});
