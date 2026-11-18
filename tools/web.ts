/** web_search — look things up on the web. Uses DuckDuckGo's HTML endpoint: no API key. */
import type { Tool } from "../agent/types.js";

const SEARCH_URL = "https://html.duckduckgo.com/html/";
const TIMEOUT_MS = 15_000;
const MAX_RESULTS = 10;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const webSearch: Tool = {
  name: "web_search",
  description:
    "Search the web. Returns titles, URLs and snippets. Use it for documentation, error messages, " +
    "library versions, or anything not in the project. The query is sent to DuckDuckGo, so never " +
    "put secrets or private code in it.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for" },
      results: { type: "number", description: `Number of results (default 5, at most ${MAX_RESULTS})` },
    },
    required: ["query"],
  },
  access: () => ({ kind: "network", operation: "search", target: "duckduckgo.com" }),
  label: (input) => `Search  ${input.query}`,
  async run(input) {
    const query = String(input.query).trim();
    if (!query) return { output: "The query is empty.", isError: true };
    const count = Math.min(MAX_RESULTS, Math.max(1, Number(input.results ?? 5)));

    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (compatible; forge-cli)",
      },
      body: new URLSearchParams({ q: query }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { output: `Search failed: HTTP ${res.status}.`, isError: true };

    const results = parseResults(await res.text()).slice(0, count);
    if (results.length === 0) return { output: `No results for "${query}".` };
    return {
      output: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n"),
    };
  },
};

/** Pull results out of DuckDuckGo's HTML page. Exported for tests. */
export function parseResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"/).slice(1);
  for (const block of blocks) {
    const link = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const url = realUrl(decodeEntities(link[1]!));
    if (!url || block.includes("result--ad")) continue;
    const snippet = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/);
    results.push({
      title: text(link[2]!),
      url,
      snippet: snippet ? text(snippet[1]!) : "",
    });
  }
  return results;
}

/** DuckDuckGo wraps links as //duckduckgo.com/l/?uddg=<real url>. */
function realUrl(href: string): string | null {
  const absolute = href.startsWith("//") ? `https:${href}` : href;
  try {
    const url = new URL(absolute);
    const wrapped = url.searchParams.get("uddg");
    if (url.hostname.endsWith("duckduckgo.com") && wrapped) return wrapped;
    if (url.hostname.endsWith("duckduckgo.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function text(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
