#!/usr/bin/env node
import { glob } from "glob";
import path from "node:path";
import { resetDb } from "../model/events.js";
import { resetGraph, getGraph } from "../model/graph.js";
import { initFromFiles, dependencyInvalidation } from "../model/incremental.js";
import { TypeScriptExtractor } from "../model/typescript/ts-extractor.js";

const BANNER = "Forge by Anthos Intelligence";
const SEP = "─".repeat(44);

function usage(): void {
  console.log(`\n${BANNER}\n${SEP}`);
  console.log("Commands:");
  console.log("  forge init              Index the current repo");
  console.log("  forge query <nodeId>    Show transitive dependents of a node\n");
}

async function cmdInit(): Promise<void> {
  console.log(`\n${BANNER}`);
  console.log(`${SEP}`);
  console.log("Initializing system model…\n");

  // Wipe existing state
  resetDb();
  resetGraph();

  const extractor = new TypeScriptExtractor();

  // Find all TS files, excluding node_modules, dist, .forge
  const files = await glob("**/*.{ts,tsx,mts,cts}", {
    cwd: process.cwd(),
    ignore: ["node_modules/**", "dist/**", ".forge/**", "**/*.d.ts"],
    absolute: false,
  });

  if (files.length === 0) {
    console.log("No TypeScript files found.");
    return;
  }

  console.log(`Found ${files.length} TypeScript files\n`);

  let processed = 0;
  const width = 30;

  await initFromFiles(files, extractor, (file, idx, total) => {
    processed = idx + 1;
    const pct = Math.round((processed / total) * 100);
    const filled = Math.round((processed / total) * width);
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    process.stdout.write(`\r  [${bar}] ${pct}% (${processed}/${total})`);
  });

  process.stdout.write("\n\n");

  const graph = getGraph();
  const nodes = graph.getNodes();
  const edges = graph.getEdges();

  const byKind = nodes.reduce(
    (acc, n) => {
      acc[n.kind] = (acc[n.kind] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const byEdgeKind = edges.reduce(
    (acc, e) => {
      acc[e.kind] = (acc[e.kind] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  console.log(`${SEP}`);
  console.log("SYSTEM MODEL");
  console.log(`${SEP}`);
  console.log(`  Nodes: ${nodes.length}`);
  for (const [kind, count] of Object.entries(byKind)) {
    console.log(`    ${kind.padEnd(12)} ${count}`);
  }
  console.log(`\n  Edges: ${edges.length}`);
  for (const [kind, count] of Object.entries(byEdgeKind)) {
    console.log(`    ${kind.padEnd(12)} ${count}`);
  }
  console.log(`${SEP}\n`);
  console.log(`Done. Model written to .forge/events.db\n`);
}

async function cmdQuery(nodeId: string): Promise<void> {
  // Rebuild graph from disk first
  const { rebuildGraph } = await import("../model/incremental.js");
  rebuildGraph();

  const graph = getGraph();
  const node = graph.getNode(nodeId);

  if (!node) {
    // Try fuzzy match by name
    const matches = graph.getNodes().filter(
      (n) =>
        n.name === nodeId ||
        n.id.includes(nodeId) ||
        n.filePath.includes(nodeId),
    );
    if (matches.length === 0) {
      console.error(`No node found matching: ${nodeId}`);
      process.exit(1);
    }
    if (matches.length === 1) {
      runQuery(matches[0].id);
      return;
    }
    console.log("Multiple matches:");
    for (const m of matches) console.log(`  ${m.id}`);
    return;
  }

  runQuery(nodeId);
}

function runQuery(nodeId: string): void {
  const graph = getGraph();
  const node = graph.getNode(nodeId)!;
  const dependents = dependencyInvalidation(nodeId);

  console.log(`\n${BANNER}`);
  console.log(SEP);
  console.log(`Node: ${node.name} (${node.kind})`);
  console.log(`ID:   ${node.id}`);
  console.log(SEP);

  if (dependents.size === 0) {
    console.log("No dependents.\n");
    return;
  }

  console.log(`Transitive dependents (${dependents.size}):\n`);
  for (const depId of dependents) {
    const depNode = graph.getNode(depId);
    if (depNode) {
      console.log(`  ${depNode.kind.padEnd(10)} ${depNode.name}  (${depNode.filePath})`);
    } else {
      console.log(`  [unknown]  ${depId}`);
    }
  }
  console.log();
}

// ── Main ──
const [, , command, ...args] = process.argv;

if (!command || command === "help" || command === "--help" || command === "-h") {
  usage();
} else if (command === "init") {
  cmdInit().catch((err) => {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  });
} else if (command === "query") {
  const nodeId = args.join(" ");
  if (!nodeId) {
    console.error("Usage: forge query <nodeId>");
    process.exit(1);
  }
  cmdQuery(nodeId).catch((err) => {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${command}`);
  usage();
  process.exit(1);
}
