/** web_search and web_fetch — the agent's view of the web. Search uses DuckDuckGo's HTML endpoint: no API key. */
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

const MAX_FETCH_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;

export const webFetch: Tool = {
  name: "web_fetch",
  description:
    "Fetch a web page and return it as readable text (HTML is converted; JSON and plain text are returned as is). " +
    "Use it to read documentation or a URL from web_search. Only http and https. " +
    "Redirects to a different host are not followed; the new URL is returned so you can fetch it.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The full URL, starting with http:// or https://" },
    },
    required: ["url"],
  },
  access: (input) => ({ kind: "network", operation: "fetch", target: hostOf(String(input.url)) }),
  label: (input) => `Fetch  ${input.url}`,
  async run(input) {
    let url: URL;
    try {
      url = new URL(String(input.url));
    } catch {
      return { output: `Not a valid URL: ${input.url}`, isError: true };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { output: `Only http and https URLs can be fetched, not ${url.protocol}`, isError: true };
    }

    // Follow redirects by hand, so the policy check on the host still means something.
    let res: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetch(url, {
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; forge-cli)", Accept: "text/html,text/plain,application/json,*/*;q=0.5" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      const next = new URL(location, url);
      if (next.host !== url.host) {
        return { output: `${url} redirects to a different host: ${next}\nFetch that URL if you want to follow it.` };
      }
      url = next;
      if (hop === MAX_REDIRECTS) return { output: `Too many redirects from ${input.url}.`, isError: true };
    }
    if (!res) return { output: "No response.", isError: true };
    if (!res.ok) return { output: `HTTP ${res.status} from ${url}.`, isError: true };

    const type = res.headers.get("content-type") ?? "";
    if (!/^(text\/|application\/(json|xml|xhtml|javascript|x-ndjson))|\+json|\+xml/.test(type) && type !== "") {
      return { output: `${url} is ${type}, not text. Forge only reads text pages.`, isError: true };
    }

    const body = await readCapped(res);
    const output = /html/.test(type) || (type === "" && /<html|<body/i.test(body)) ? htmlToText(body) : body;
    return { output: `${url}\n\n${output.trim() || "(the page has no text)"}` };
  },
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_FETCH_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_FETCH_BYTES));
}

/** Turn a page into plain text with light markdown: headings, links, list items, code. Exported for tests. */
export function htmlToText(html: string): string {
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html;
  return decodeEntities(
    main
      .replace(/<(script|style|noscript|svg|nav|footer|header|iframe|template)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => `\n\`\`\`\n${code.replace(/<[^>]+>/g, "")}\n\`\`\`\n`)
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`)
      .replace(/<a[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, t: string) => {
        const label = t.replace(/<[^>]+>/g, "").trim();
        return label ? `[${label}](${href})` : "";
      })
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|tr|ul|ol|table|blockquote)>/gi, "\n\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

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
