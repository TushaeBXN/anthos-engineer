import type { SystemNode, SystemEdge } from "./schema.js";

export interface ExtractionResult {
  nodes: SystemNode[];
  edges: SystemEdge[];
}

export interface Extractor {
  readonly id: string;
  readonly version: string;
  /** File extensions this extractor handles, e.g. [".ts", ".tsx"] */
  readonly extensions: string[];
  extract(filePath: string): Promise<ExtractionResult>;
}
