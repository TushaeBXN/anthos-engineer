import { appendEvent, getAllEvents } from "./events.js";
import { getGraph } from "./graph.js";
import type { Extractor } from "./extractor.js";
import type { SystemNode, SystemEdge } from "./schema.js";

// Re-extract a single file and emit add/remove events for the diff.
export async function localInvalidation(
  filePath: string,
  extractor: Extractor,
): Promise<{ added: { nodes: SystemNode[]; edges: SystemEdge[] }; removed: { nodeIds: string[]; edgeIds: string[] } }> {
  const graph = getGraph();

  // Snapshot existing nodes/edges for this file
  const prevNodes = graph.getNodes().filter((n) => n.filePath === filePath);
  const prevEdges = graph.getEdges().filter((e) => {
    const from = graph.getNode(e.fromId);
    return from?.filePath === filePath;
  });

  const { nodes: nextNodes, edges: nextEdges } = await extractor.extract(filePath);

  const prevNodeIds = new Set(prevNodes.map((n) => n.id));
  const nextNodeIds = new Set(nextNodes.map((n) => n.id));
  const prevEdgeIds = new Set(prevEdges.map((e) => e.id));
  const nextEdgeIds = new Set(nextEdges.map((e) => e.id));

  const addedNodes = nextNodes.filter((n) => !prevNodeIds.has(n.id));
  const removedNodeIds = prevNodes.filter((n) => !nextNodeIds.has(n.id)).map((n) => n.id);
  const addedEdges = nextEdges.filter((e) => !prevEdgeIds.has(e.id));
  const removedEdgeIds = prevEdges.filter((e) => !nextEdgeIds.has(e.id)).map((e) => e.id);

  // Emit FileChanged first
  appendEvent("FileChanged", { type: "FileChanged", filePath });

  for (const nodeId of removedNodeIds) {
    const ev = appendEvent("NodeRemoved", { type: "NodeRemoved", nodeId });
    graph.applyEvent(ev);
  }
  for (const edgeId of removedEdgeIds) {
    const ev = appendEvent("EdgeRemoved", { type: "EdgeRemoved", edgeId });
    graph.applyEvent(ev);
  }
  for (const node of addedNodes) {
    const ev = appendEvent("NodeAdded", { type: "NodeAdded", node });
    graph.applyEvent(ev);
  }
  for (const edge of addedEdges) {
    const ev = appendEvent("EdgeAdded", { type: "EdgeAdded", edge });
    graph.applyEvent(ev);
  }

  return {
    added: { nodes: addedNodes, edges: addedEdges },
    removed: { nodeIds: removedNodeIds, edgeIds: removedEdgeIds },
  };
}

// Returns all node IDs that transitively depend on nodeId.
// Lazy: backed by graph.getTransitiveDependents which caches by version.
export function dependencyInvalidation(nodeId: string): Set<string> {
  return getGraph().getTransitiveDependents(nodeId);
}

// Bulk-init: extract every file and populate the event log + graph from scratch.
export async function initFromFiles(
  filePaths: string[],
  extractor: Extractor,
  onProgress?: (file: string, idx: number, total: number) => void,
): Promise<void> {
  const graph = getGraph();

  appendEvent("ExtractorUpdated", {
    type: "ExtractorUpdated",
    extractorId: extractor.id,
    version: extractor.version,
  });

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];
    onProgress?.(filePath, i, filePaths.length);

    try {
      appendEvent("FileChanged", { type: "FileChanged", filePath });
      const { nodes, edges } = await extractor.extract(filePath);

      for (const node of nodes) {
        const ev = appendEvent("NodeAdded", { type: "NodeAdded", node });
        graph.applyEvent(ev);
      }
      for (const edge of edges) {
        const ev = appendEvent("EdgeAdded", { type: "EdgeAdded", edge });
        graph.applyEvent(ev);
      }
    } catch (err) {
      // Non-fatal: log and continue
      process.stderr.write(`  warn: skipped ${filePath}: ${(err as Error).message}\n`);
    }
  }
}

// Rebuild the in-memory graph from the full event log.
export function rebuildGraph(): void {
  const events = getAllEvents();
  getGraph().rebuild(events);
}
