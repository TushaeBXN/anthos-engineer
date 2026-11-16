/**
 * File history for one session. write and edit push a snapshot before every
 * change so /undo can put things back.
 *
 * Stored in memory only — the history is gone when the process exits.
 */

export interface Snapshot {
  path: string;
  /** Absolute path on disk. */
  abs: string;
  /** null means the file did not exist before this change. */
  before: string | null;
  at: Date;
}

/** One undo stack per session. The CLI creates one and shares it with the tools. */
export class UndoStack {
  private stack: Snapshot[] = [];

  push(snapshot: Snapshot): void {
    this.stack.push(snapshot);
  }

  /** Pop the most recent snapshot and return it, or null if the stack is empty. */
  pop(): Snapshot | null {
    return this.stack.pop() ?? null;
  }

  /** All snapshots, most recent first. */
  all(): Snapshot[] {
    return [...this.stack].reverse();
  }

  get size(): number {
    return this.stack.length;
  }
}
