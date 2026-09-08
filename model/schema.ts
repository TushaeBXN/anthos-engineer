export type NodeKind = "function" | "module" | "dependency";
export type EdgeKind = "calls" | "imports";

export interface SystemNode {
  id: string;
  kind: NodeKind;
  name: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  metadata?: Record<string, unknown>;
}

export interface SystemEdge {
  id: string;
  kind: EdgeKind;
  fromId: string;
  toId: string;
  confidence: number;
  metadata?: Record<string, unknown>;
}

export type ForgeEventType =
  | "FileChanged"
  | "NodeAdded"
  | "NodeRemoved"
  | "EdgeAdded"
  | "EdgeRemoved"
  | "ExtractorUpdated";

export type ForgeEventPayload =
  | { type: "FileChanged"; filePath: string }
  | { type: "NodeAdded"; node: SystemNode }
  | { type: "NodeRemoved"; nodeId: string }
  | { type: "EdgeAdded"; edge: SystemEdge }
  | { type: "EdgeRemoved"; edgeId: string }
  | { type: "ExtractorUpdated"; extractorId: string; version: string };

export interface StoredEvent {
  id: number;
  type: ForgeEventType;
  payload: ForgeEventPayload;
  timestamp: string;
  commitSha: string | null;
}
