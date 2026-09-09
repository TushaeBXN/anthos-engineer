/**
 * Semantic diff — turns a set of graph events into a human-readable summary
 * grouped by inferred category (API, Tests, Database, etc.).
 * Blast radius is the count of nodes that transitively depend on any changed node.
 */
import type { StoredEvent } from "../model/schema.js";
import type { SystemGraph } from "../model/graph.js";

export interface DiffChange {
  kind: "added" | "removed";
  nodeKind: string;
  name: string;
  filePath: string;
}

export interface DiffGroup {
  category: string;
  changes: DiffChange[];
}

export interface SemanticDiff {
  groups: DiffGroup[];
  blastRadius: number;
  blastRadiusNodeIds: string[];
}

// Infer a display category from a file path using naming conventions.
export function inferCategory(filePath: string): string {
  const p = filePath.toLowerCase().replace(/\\/g, "/");
  const seg = (re: RegExp) => re.test(p);
  if (seg(/(^|\/)(tests?|spec|__tests?__)\//)) return "Tests";
  if (/\.(test|spec)\.[tj]sx?$/.test(p)) return "Tests";
  if (seg(/(^|\/)(api|routes?|handlers?|endpoints?|controllers?)\//)) return "API";
  if (seg(/(^|\/)(db|database|models?|schemas?|migrations?|repositories?)\//)) return "Database";
  if (seg(/(^|\/)(auth|authentication|sessions?|tokens?|jwt)\//)) return "Authentication";
  if (seg(/(^|\/)(cli|cmd|commands?)\//)) return "CLI";
  if (seg(/(^|\/)(utils?|helpers?|lib|common|shared|hooks?)\//)) return "Utilities";
  return "Core";
}

export function computeSemanticDiff(
  events: StoredEvent[],
  graph: SystemGraph,
): SemanticDiff {
  const byCategory = new Map<string, DiffChange[]>();
  const affectedNodeIds = new Set<string>();

  for (const event of events) {
    const p = event.payload;

    if (p.type === "NodeAdded") {
      const { node } = p;
      if (node.kind === "dependency") continue; // external packages are noise
      affectedNodeIds.add(node.id);
      const cat = inferCategory(node.filePath);
      const list = byCategory.get(cat) ?? [];
      list.push({ kind: "added", nodeKind: node.kind, name: node.name, filePath: node.filePath });
      byCategory.set(cat, list);
    }

    if (p.type === "NodeRemoved") {
      // Reconstruct metadata from ID convention: "kind:filePath[:name]"
      affectedNodeIds.add(p.nodeId);
      const parts = p.nodeId.split(":");
      if (parts.length < 2) continue;
      const kind = parts[0];
      if (kind === "dependency") continue;
      const filePath = parts[1];
      const name = parts[2] ?? filePath;
      const cat = inferCategory(filePath);
      const list = byCategory.get(cat) ?? [];
      list.push({ kind: "removed", nodeKind: kind, name, filePath });
      byCategory.set(cat, list);
    }
  }

  // Blast radius: union of transitive dependents across all affected nodes,
  // minus the affected nodes themselves.
  const blastSet = new Set<string>();
  for (const nodeId of affectedNodeIds) {
    for (const dep of graph.getTransitiveDependents(nodeId)) {
      blastSet.add(dep);
    }
  }
  for (const id of affectedNodeIds) blastSet.delete(id);

  const groups: DiffGroup[] = [];
  for (const [category, changes] of byCategory) {
    groups.push({ category, changes });
  }
  groups.sort((a, b) => a.category.localeCompare(b.category));

  return { groups, blastRadius: blastSet.size, blastRadiusNodeIds: [...blastSet] };
}

export function printSemanticDiff(diff: SemanticDiff): void {
  const SEP = "─".repeat(44);
  console.log("\nSYSTEM CHANGE");
  console.log(SEP);

  if (diff.groups.length === 0) {
    console.log("  (no structural changes)");
  } else {
    for (const group of diff.groups) {
      console.log(`\n${group.category}`);
      for (const ch of group.changes) {
        const prefix = ch.kind === "added" ? "+" : "-";
        const verb = ch.kind === "added" ? "Added" : "Removed";
        console.log(`${prefix} ${verb} ${ch.nodeKind} ${ch.name}`);
      }
    }
  }

  console.log(`\nBLAST RADIUS`);
  console.log(`${diff.blastRadius} node${diff.blastRadius !== 1 ? "s" : ""}\n`);
}
