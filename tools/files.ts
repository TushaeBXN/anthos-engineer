/** read, write and edit — how the agent sees and changes files. */
import fs from "node:fs/promises";
import path from "node:path";
import type { UndoStack } from "../agent/undo.js";
import type { Tool } from "../agent/types.js";

const MAX_READ_LINES = 2000;

export const read: Tool = {
  name: "read",
  description:
    "Read a text file. Returns numbered lines. Read a file before you edit it. " +
    "For long files pass offset (first line, from 1) and limit (number of lines).",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the project root" },
      offset: { type: "number", description: "First line to return, starting at 1" },
      limit: { type: "number", description: `Number of lines to return (at most ${MAX_READ_LINES})` },
    },
    required: ["path"],
  },
  access: (input) => ({ kind: "read", path: String(input.path) }),
  label: (input) => `Read ${input.path}`,
  async run(input, cwd) {
    const text = await fs.readFile(path.resolve(cwd, String(input.path)), "utf8");
    const all = text.split("\n");
    const start = Math.max(1, Number(input.offset ?? 1));
    const count = Math.min(MAX_READ_LINES, Number(input.limit ?? MAX_READ_LINES));
    const shown = all.slice(start - 1, start - 1 + count);
    const body = shown.map((line, i) => `${String(start + i).padStart(5)}  ${line}`).join("\n");
    const end = start - 1 + shown.length;
    const more = end < all.length ? `\n(lines ${end + 1}–${all.length} not shown; pass offset to read them)` : "";
    return { output: body + more };
  },
};

/** Call this to get write/edit tools wired up to an undo stack. */
export function makeWriteTools(undo?: UndoStack): { write: Tool; edit: Tool } {
  const write: Tool = {
    name: "write",
    description:
      "Create a file, or replace a whole file, with the given content. " +
      "To change part of an existing file, use edit instead.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the project root" },
        content: { type: "string", description: "The complete file content" },
      },
      required: ["path", "content"],
    },
    access: (input) => ({ kind: "write", path: String(input.path) }),
    label: (input) => `Write ${input.path}`,
    async run(input, cwd) {
      const file = path.resolve(cwd, String(input.path));
      const content = String(input.content);
      const before = await fs.readFile(file, "utf8").catch(() => null);
      undo?.push({ path: String(input.path), abs: file, before, at: new Date() });
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, "utf8");
      return {
        output: `${before === null ? "Created" : "Replaced"} ${input.path}`,
        lines: { file: String(input.path), ...countChangedLines(before ?? "", content) },
      };
    },
  };

  const edit: Tool = {
    name: "edit",
    description:
      "Replace an exact piece of text in a file. old_string must match the file exactly, " +
      "including indentation, and must appear only once unless replace_all is true.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the project root" },
        old_string: { type: "string", description: "The exact text to replace" },
        new_string: { type: "string", description: "The text to put in its place" },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
      },
      required: ["path", "old_string", "new_string"],
    },
    access: (input) => ({ kind: "write", path: String(input.path) }),
    label: (input) => `Edit ${input.path}`,
    async run(input, cwd) {
      const file = path.resolve(cwd, String(input.path));
      const oldText = String(input.old_string);
      const newText = String(input.new_string);
      const before = await fs.readFile(file, "utf8");
      undo?.push({ path: String(input.path), abs: file, before, at: new Date() });

      const found = before.split(oldText).length - 1;
      if (oldText === "" || found === 0) {
        return { output: `old_string was not found in ${input.path}. Read the file and copy the text exactly.`, isError: true };
      }
      if (found > 1 && input.replace_all !== true) {
        return {
          output: `old_string appears ${found} times in ${input.path}. Add surrounding lines to make it unique, or set replace_all.`,
          isError: true,
        };
      }

      // split/join rather than replace(): "$" in new_string must stay literal.
      const after = input.replace_all === true
        ? before.split(oldText).join(newText)
        : before.replace(oldText, () => newText);
      await fs.writeFile(file, after, "utf8");
      return {
        output: `Edited ${input.path} (${found} replacement${found === 1 ? "" : "s"})`,
        lines: { file: String(input.path), ...countChangedLines(before, after) },
      };
    },
  };

  return { write, edit };
}

/** Default tools without an undo stack (used by tests and the demo). */
export const { write, edit } = makeWriteTools();

/**
 * Lines added and removed between two versions of a file. Each line of the old
 * version is paired with an identical line of the new one; what is left over
 * on either side was removed or added. A changed line counts as one of each.
 */
export function countChangedLines(before: string, after: string): { added: number; removed: number } {
  const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
  const remaining = new Map<string, number>();
  for (const line of lines(before)) remaining.set(line, (remaining.get(line) ?? 0) + 1);

  let added = 0;
  for (const line of lines(after)) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) remaining.set(line, left - 1);
    else added++;
  }
  let removed = 0;
  for (const left of remaining.values()) removed += left;
  return { added, removed };
}
