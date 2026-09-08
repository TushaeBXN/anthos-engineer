import type { SystemNode, SystemEdge, StoredEvent } from "./schema.js";

export class SystemGraph {
  private nodes = new Map<string, SystemNode>();
  private edges = new Map<string, SystemEdge>();
  private edgesByNode = new Map<string, Set<string>>();
  version = 0;

  // Cache for transitive dependent lookups: nodeId -> { graphVersion, result }
  private dependentsCache = new Map<string, { version: number; result: Set<string> }>();

  applyEvent(event: StoredEvent): void {
    const p = event.payload;
    this.dependentsCache.clear();

    if (p.type === "NodeAdded") {
      this.nodes.set(p.node.id, p.node);
    } else if (p.type === "NodeRemoved") {
      this.nodes.delete(p.nodeId);
      const edgeIds = this.edgesByNode.get(p.nodeId);
      if (edgeIds) {
        for (const eid of edgeIds) this.edges.delete(eid);
        this.edgesByNode.delete(p.nodeId);
      }
    } else if (p.type === "EdgeAdded") {
      this.edges.set(p.edge.id, p.edge);
      this._indexEdge(p.edge);
    } else if (p.type === "EdgeRemoved") {
      const edge = this.edges.get(p.edgeId);
      if (edge) {
        this.edges.delete(p.edgeId);
        this._unindexEdge(edge);
      }
    }

    this.version++;
  }

  rebuild(events: StoredEvent[]): void {
    this.nodes.clear();
    this.edges.clear();
    this.edgesByNode.clear();
    this.dependentsCache.clear();
    this.version = 0;
    for (const event of events) this.applyEvent(event);
  }

  getNode(id: string): SystemNode | undefined {
    return this.nodes.get(id);
  }

  getNodes(): SystemNode[] {
    return Array.from(this.nodes.values());
  }

  getEdge(id: string): SystemEdge | undefined {
    return this.edges.get(id);
  }

  getEdges(): SystemEdge[] {
    return Array.from(this.edges.values());
  }

  getEdgesFrom(nodeId: string): SystemEdge[] {
    const ids = this.edgesByNode.get(nodeId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.edges.get(id))
      .filter((e): e is SystemEdge => e !== undefined && e.fromId === nodeId);
  }

  getEdgesTo(nodeId: string): SystemEdge[] {
    const ids = this.edgesByNode.get(nodeId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.edges.get(id))
      .filter((e): e is SystemEdge => e !== undefined && e.toId === nodeId);
  }

  // Returns all node IDs that (directly or transitively) depend on nodeId.
  // Lazy: result cached by nodeId + graph version.
  getTransitiveDependents(nodeId: string): Set<string> {
    const cached = this.dependentsCache.get(nodeId);
    if (cached && cached.version === this.version) return cached.result;

    const result = new Set<string>();
    const queue = [nodeId];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of this.getEdgesTo(current)) {
        if (!result.has(edge.fromId)) {
          result.add(edge.fromId);
          queue.push(edge.fromId);
        }
      }
    }

    this.dependentsCache.set(nodeId, { version: this.version, result });
    return result;
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  edgeCount(): number {
    return this.edges.size;
  }

  private _indexEdge(edge: SystemEdge): void {
    for (const nodeId of [edge.fromId, edge.toId]) {
      if (!this.edgesByNode.has(nodeId)) this.edgesByNode.set(nodeId, new Set());
      this.edgesByNode.get(nodeId)!.add(edge.id);
    }
  }

  private _unindexEdge(edge: SystemEdge): void {
    for (const nodeId of [edge.fromId, edge.toId]) {
      this.edgesByNode.get(nodeId)?.delete(edge.id);
    }
  }
}

// Singleton graph for CLI use
let _graph: SystemGraph | null = null;

export function getGraph(): SystemGraph {
  if (!_graph) _graph = new SystemGraph();
  return _graph;
}

export function resetGraph(): void {
  _graph = null;
}
