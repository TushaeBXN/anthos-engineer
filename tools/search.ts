/** glob and grep — how the agent finds files and code. */
import fs from "node:fs/promises";
import path from "node:path";
import { glob as globFiles } from "glob";
import type { Tool } from "../agent/types.js";

const IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.forge/**"];
const MAX_FILES = 200;
const MAX_MATCHES = 100;
const MAX_FILE_BYTES = 1_000_000;

export const glob: Tool = {
  name: "glob",
  description: 'Find files by name pattern, for example "src/**/*.ts" or "**/package.json".',
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, relative to the project root" },
    },
    required: ["pattern"],
  },
  access: () => ({ kind: "read", path: "." }),
  label: (input) => `Find ${input.pattern}`,
  async run(input, cwd) {
    const files = (await globFiles(String(input.pattern), { cwd, ignore: IGNORE, nodir: true })).sort();
    if (files.length === 0) return { output: "No files match." };
    const more = files.length > MAX_FILES ? `\n(${files.length - MAX_FILES} more not shown; narrow the pattern)` : "";
    return { output: files.slice(0, MAX_FILES).join("\n") + more };
  },
};

export const grep: Tool = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns matching lines as path:line: text. " +
    'Limit the search with files, for example "src/**/*.ts".',
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression (JavaScript syntax)" },
      files: { type: "string", description: 'Glob of files to search (default "**/*")' },
    },
    required: ["pattern"],
  },
  access: () => ({ kind: "read", path: "." }),
  label: (input) => `Search ${input.pattern}`,
  async run(input, cwd) {
    let regex: RegExp;
    try {
      regex = new RegExp(String(input.pattern));
    } catch (err) {
      return { output: `Invalid regular expression: ${(err as Error).message}`, isError: true };
    }

    const files = (await globFiles(String(input.files ?? "**/*"), { cwd, ignore: IGNORE, nodir: true })).sort();
    const matches: string[] = [];
    for (const file of files) {
      const full = path.resolve(cwd, file);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat || stat.size > MAX_FILE_BYTES) continue;
      const text = await fs.readFile(full, "utf8").catch(() => "");
      if (text.includes("\0")) continue; // binary file
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i])) continue;
        matches.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (matches.length >= MAX_MATCHES) {
          return { output: matches.join("\n") + `\n(stopped at ${MAX_MATCHES} matches; narrow the search)` };
        }
      }
    }
    return { output: matches.length > 0 ? matches.join("\n") : "No matches." };
  },
};
