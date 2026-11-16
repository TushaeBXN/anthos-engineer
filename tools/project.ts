/** find_dependents and verify — Forge's own knowledge of the project. */
import type { Tool } from "../agent/types.js";
import { runVerificationChain } from "../verify/chain.js";

export const findDependents: Tool = {
  name: "find_dependents",
  description:
    "List everything that depends on a function or module, directly or indirectly. " +
    "Use it before changing something to see what else could break. " +
    "Reads the index built by `forge init`, so it reflects the code as of the last index.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "A function name, or part of a file path" },
    },
    required: ["name"],
  },
  access: () => ({ kind: "none" }),
  label: (input) => `Dependents of ${input.name}`,
  async run(input) {
    // Loaded on first use: the index needs SQLite, which most turns never touch.
    const { rebuildGraph } = await import("../model/incremental.js");
    const { getGraph } = await import("../model/graph.js");
    rebuildGraph();
    const graph = getGraph();
    if (graph.nodeCount() === 0) {
      return { output: "The project has not been indexed. Run `forge init` first, or use grep.", isError: true };
    }

    const name = String(input.name);
    const matches = graph.getNodes().filter((n) => n.id === name || n.name === name || n.filePath.includes(name));
    if (matches.length === 0) return { output: `Nothing in the index matches "${name}".` };
    if (matches.length > 1 && !matches.some((n) => n.id === name)) {
      const list = matches.slice(0, 30).map((n) => `  ${n.kind} ${n.name} (${n.filePath})`).join("\n");
      return { output: `"${name}" matches ${matches.length} things. Be more specific:\n${list}` };
    }

    const node = matches.find((n) => n.id === name) ?? matches[0];
    const dependents = [...graph.getTransitiveDependents(node.id)]
      .map((id) => graph.getNode(id))
      .filter((n) => n !== undefined);
    if (dependents.length === 0) return { output: `Nothing depends on ${node.name}.` };
    const list = dependents.map((n) => `  ${n.kind} ${n.name} (${n.filePath})`).join("\n");
    return { output: `${dependents.length} things depend on ${node.name}:\n${list}` };
  },
};

export const verify: Tool = {
  name: "verify",
  description:
    "Check the project: type check, tests, then lint. Every stage runs even if an earlier one fails. " +
    "Run it after you change code, and fix what it reports.",
  inputSchema: { type: "object", properties: {}, required: [] },
  access: () => ({ kind: "none" }),
  label: () => "Verify",
  async run(_input, cwd) {
    const result = await runVerificationChain(cwd);
    const report = result.stages.map((stage) => {
      if (stage.skipped) return `${stage.stage}: skipped (${stage.skipReason})`;
      if (stage.passed) return `${stage.stage}: passed`;
      return `${stage.stage}: FAILED\n${(stage.stderr || stage.stdout).trim().slice(0, 4000)}`;
    });
    return { output: report.join("\n"), isError: !result.passed };
  },
};
