/**
 * Repo map: a short outline of the project for the system prompt, so the
 * model knows where things live before it reads a single file.
 *
 *   1. Find the names each source file defines (functions, classes, types).
 *   2. A file that mentions a name defined elsewhere points at that file.
 *   3. PageRank over those pointers: files many others depend on rank first.
 *   4. Print files and their names, best first, until the budget is spent.
 *
 * Works on any language with a regex below; no index or `forge init` needed.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";

const MAX_FILES = 3_000;
const MAX_FILE_BYTES = 200_000;
const CHARS_PER_TOKEN = 4;

const DEFINITIONS: Record<string, RegExp[]> = {
  ts: [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  ],
  py: [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^class\s+([A-Za-z_]\w*)/gm],
  go: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, /^type\s+([A-Za-z_]\w*)/gm],
  rs: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)/gm],
  java: [/^\s*(?:public|protected|private|abstract|final|static|sealed|data|open|\s)*(?:class|interface|enum|record|object)\s+([A-Za-z_]\w*)/gm],
  rb: [/^\s*(?:def\s+(?:self\.)?|class\s+|module\s+)([A-Za-z_]\w*[?!]?)/gm],
};

const LANGUAGE: Record<string, keyof typeof DEFINITIONS> = {
  ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts", ".js": "ts", ".jsx": "ts", ".mjs": "ts", ".cjs": "ts",
  ".py": "py", ".go": "go", ".rs": "rs", ".java": "java", ".kt": "java", ".cs": "java", ".scala": "java", ".rb": "rb",
};

const IGNORE = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**", "**/.forge/**", "**/vendor/**", "**/target/**", "**/*.d.ts", "**/*.min.js"];

/** Names too common to say anything about which file is meant. */
const NOISE = new Set(["main", "init", "test", "run", "get", "set", "new", "self", "this", "type", "data", "value", "name", "default", "index", "error", "result", "string", "number", "object"]);

export interface RepoMap {
  text: string;
  files: number;
  shown: number;
}

/** Build the map for cwd, at most budgetTokens long. Empty text when there is nothing to map. */
export function buildRepoMap(cwd: string, budgetTokens: number): RepoMap {
  if (budgetTokens <= 0) return { text: "", files: 0, shown: 0 };

  const files = sourceFiles(cwd);
  const defs = new Map<string, string[]>();
  const sources = new Map<string, string>();
  for (const file of files) {
    let text: string;
    try {
      const abs = path.join(cwd, file);
      if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    sources.set(file, text);
    defs.set(file, definitions(text, LANGUAGE[path.extname(file)]!));
  }
  if (sources.size === 0) return { text: "", files: 0, shown: 0 };

  const words = new Map<string, Set<string>>();
  // Skip words after a dot: `.trim()` is a method on something else, not a use of a function named trim.
  for (const [file, text] of sources) words.set(file, new Set(text.match(/(?<![.\w$])[A-Za-z_$][\w$]*/g) ?? []));

  // Which files define each name. Tests define helpers nobody imports, so they don't count.
  const definedIn = new Map<string, string[]>();
  for (const [file, names] of defs) {
    if (isTest(file)) continue;
    for (const name of names) {
      if (name.length < 4 || NOISE.has(name.toLowerCase())) continue;
      definedIn.set(name, [...(definedIn.get(name) ?? []), file]);
    }
  }
  // A name defined in many files, or mentioned almost everywhere, says little about which file is meant.
  const mentions = new Map<string, number>();
  for (const set of words.values()) for (const w of set) if (definedIn.has(w)) mentions.set(w, (mentions.get(w) ?? 0) + 1);
  for (const [name, where] of definedIn) {
    if (where.length > 5 || (sources.size >= 10 && (mentions.get(name) ?? 0) > sources.size * 0.4)) definedIn.delete(name);
  }

  // file → files it uses, weighted by how many distinct names it uses from each.
  const edges = new Map<string, Map<string, number>>();
  for (const [file, set] of words) {
    const out = new Map<string, number>();
    for (const word of set) {
      for (const target of definedIn.get(word) ?? []) {
        if (target !== file) out.set(target, (out.get(target) ?? 0) + 1);
      }
    }
    edges.set(file, out);
  }

  const rank = pageRank([...sources.keys()], edges);
  const score = (f: string) => rank.get(f)! * (isTest(f) ? 0.01 : 1);
  const ordered = [...sources.keys()].sort((a, b) => score(b) - score(a) || a.localeCompare(b));

  const budget = budgetTokens * CHARS_PER_TOKEN;
  const lines: string[] = [];
  let used = 0;
  for (const file of ordered) {
    const names = defs.get(file) ?? [];
    const line = names.length > 0 ? `${file}: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""}` : file;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  const rest = ordered.length - lines.length;
  if (rest > 0) lines.push(`(${rest} more files not shown)`);
  return { text: lines.join("\n"), files: ordered.length, shown: ordered.length - rest };
}

function isTest(file: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//.test(file) || /[._-](test|spec)\.\w+$/.test(file) || /(^|\/)test_[^/]+\.py$/.test(file);
}

function sourceFiles(cwd: string): string[] {
  const wanted = (f: string) => LANGUAGE[path.extname(f)] !== undefined;
  try {
    const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 50_000_000,
    });
    return listed.split("\n").filter((f) => f && wanted(f) && !f.endsWith(".d.ts")).slice(0, MAX_FILES);
  } catch {
    const patterns = Object.keys(LANGUAGE).map((ext) => `**/*${ext}`);
    return globSync(patterns, { cwd, ignore: IGNORE, nodir: true }).sort().slice(0, MAX_FILES);
  }
}

/** Names a file defines, in the order they appear, without repeats. */
export function definitions(text: string, language: keyof typeof DEFINITIONS): string[] {
  const found: { name: string; at: number }[] = [];
  for (const pattern of DEFINITIONS[language]!) {
    for (const match of text.matchAll(pattern)) found.push({ name: match[1]!, at: match.index ?? 0 });
  }
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((f) => f.name))];
}

function pageRank(nodes: string[], edges: Map<string, Map<string, number>>, damping = 0.85, rounds = 30): Map<string, number> {
  const n = nodes.length;
  let rank = new Map(nodes.map((f) => [f, 1 / n]));
  for (let i = 0; i < rounds; i++) {
    const next = new Map(nodes.map((f) => [f, (1 - damping) / n]));
    let dangling = 0;
    for (const from of nodes) {
      const out = edges.get(from)!;
      const total = [...out.values()].reduce((a, b) => a + b, 0);
      if (total === 0) {
        dangling += rank.get(from)!;
        continue;
      }
      for (const [to, weight] of out) next.set(to, next.get(to)! + (damping * rank.get(from)! * weight) / total);
    }
    for (const f of nodes) next.set(f, next.get(f)! + (damping * dangling) / n);
    rank = next;
  }
  return rank;
}
