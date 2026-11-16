/** bash — how the agent runs commands: tests, builds, git. */
import { execFile } from "node:child_process";
import type { Tool } from "../agent/types.js";

const TIMEOUT_MS = 120_000;

export const bash: Tool = {
  name: "bash",
  description:
    "Run a shell command in the project root and return its output and exit code. " +
    "Use it for tests, builds and git. Use read, glob and grep instead of cat, find and grep.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run" },
    },
    required: ["command"],
  },
  access: (input) => ({ kind: "shell", command: String(input.command) }),
  label: (input) => `Run ${String(input.command).split("\n")[0].slice(0, 80)}`,
  run(input, cwd) {
    return new Promise((resolve) => {
      execFile(
        "/bin/sh",
        ["-c", String(input.command)],
        { cwd, timeout: TIMEOUT_MS, maxBuffer: 10_000_000 },
        (error, stdout, stderr) => {
          const output = [stdout, stderr].filter(Boolean).join("\n").trim();
          if (!error) return resolve({ output: output || "(no output)" });
          const why = error.killed ? `timed out after ${TIMEOUT_MS / 1000}s` : `exit code ${error.code ?? 1}`;
          resolve({ output: `${output}\n(${why})`.trim(), isError: true });
        },
      );
    });
  },
};
