/** Every tool the agent has. To add one, write it and list it here. */
import type { UndoStack } from "../agent/undo.js";
import type { Tool } from "../agent/types.js";
import { bash } from "./bash.js";
import { makeWriteTools, read } from "./files.js";
import { findDependents, verify } from "./project.js";
import { glob, grep } from "./search.js";

export { read } from "./files.js";

/** Build the tool list. Pass an undo stack to enable /undo in the CLI. */
export function makeTools(undo?: UndoStack): Tool[] {
  const { write, edit } = makeWriteTools(undo);
  return [read, write, edit, glob, grep, bash, findDependents, verify];
}

/** Default tool list without undo (tests, demo). */
export const tools: Tool[] = makeTools();
