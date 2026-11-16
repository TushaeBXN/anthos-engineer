/** Every tool the agent has. To add one, write it and list it here. */
import type { Tool } from "../agent/types.js";
import { bash } from "./bash.js";
import { edit, read, write } from "./files.js";
import { findDependents, verify } from "./project.js";
import { glob, grep } from "./search.js";

export const tools: Tool[] = [read, write, edit, glob, grep, bash, findDependents, verify];
