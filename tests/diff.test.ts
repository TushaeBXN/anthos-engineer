import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SystemGraph } from "../model/graph.js";
import { inferCategory, computeSemanticDiff } from "../diff/semantic.js";
import type { StoredEvent } from "../model/schema.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let eventId = 0;
function makeEvent(payload: StoredEvent["payload"]): StoredEvent {
  return {
    id: ++eventId,
    type: payload.type,
    payload,
    timestamp: new Date().toISOString(),
    commitSha: null,
  };
}

function addedNode(
  id: string,
  kind: "function" | "module" | "dependency",
  name: string,
  filePath: string,
): StoredEvent {
  return makeEvent({
    type: "NodeAdded",
    node: { id, kind, name, filePath },
  });
}

function removedNode(nodeId: string): StoredEvent {
  return makeEvent({ type: "NodeRemoved", nodeId });
}

// ── Category inference ────────────────────────────────────────────────────────

describe("inferCategory", () => {
  test("test files → Tests", () => {
    assert.equal(inferCategory("src/auth.test.ts"), "Tests");
    assert.equal(inferCategory("tests/policy.test.ts"), "Tests");
    assert.equal(inferCategory("__tests__/util.ts"), "Tests");
    assert.equal(inferCategory("spec/model.spec.ts"), "Tests");
  });

  test("route/api files → API", () => {
    assert.equal(inferCategory("src/api/health.ts"), "API");
    assert.equal(inferCategory("src/routes/user.ts"), "API");
    assert.equal(inferCategory("src/handlers/auth.ts"), "API");
  });

  test("db/model files → Database", () => {
    assert.equal(inferCategory("src/db/connection.ts"), "Database");
    assert.equal(inferCategory("src/models/user.ts"), "Database");
    assert.equal(inferCategory("src/migrations/001_init.ts"), "Database");
  });

  test("auth files → Authentication", () => {
    assert.equal(inferCategory("src/auth/jwt.ts"), "Authentication");
    assert.equal(inferCategory("src/sessions/store.ts"), "Authentication");
  });

  test("cli files → CLI", () => {
    assert.equal(inferCategory("cli/index.ts"), "CLI");
    assert.equal(inferCategory("src/commands/deploy.ts"), "CLI");
  });

  test("util/lib files → Utilities", () => {
    assert.equal(inferCategory("src/utils/logger.ts"), "Utilities");
    assert.equal(inferCategory("src/helpers/format.ts"), "Utilities");
    assert.equal(inferCategory("lib/common.ts"), "Utilities");
  });

  test("unmatched paths → Core", () => {
    assert.equal(inferCategory("src/index.ts"), "Core");
    assert.equal(inferCategory("server.ts"), "Core");
  });
});

// ── computeSemanticDiff ───────────────────────────────────────────────────────

describe("computeSemanticDiff — grouping", () => {
  test("NodeAdded events are grouped by inferred category", () => {
    const graph = new SystemGraph();
    const events = [
      addedNode("function:src/api/health.ts:getHealth", "function", "getHealth", "src/api/health.ts"),
      addedNode("function:tests/health.test.ts:testHealth", "function", "testHealth", "tests/health.test.ts"),
    ];

    const diff = computeSemanticDiff(events, graph);

    const api = diff.groups.find((g) => g.category === "API");
    const tests = diff.groups.find((g) => g.category === "Tests");

    assert.ok(api, "API group should exist");
    assert.equal(api!.changes.length, 1);
    assert.equal(api!.changes[0].name, "getHealth");
    assert.equal(api!.changes[0].kind, "added");

    assert.ok(tests, "Tests group should exist");
    assert.equal(tests!.changes.length, 1);
    assert.equal(tests!.changes[0].name, "testHealth");
  });

  test("dependency nodes are excluded (external packages are noise)", () => {
    const graph = new SystemGraph();
    const events = [
      addedNode("dep:express", "dependency", "express", ""),
      addedNode("function:src/index.ts:start", "function", "start", "src/index.ts"),
    ];

    const diff = computeSemanticDiff(events, graph);
    const allNames = diff.groups.flatMap((g) => g.changes.map((c) => c.name));
    assert.ok(!allNames.includes("express"), "dependency nodes must be excluded");
    assert.ok(allNames.includes("start"), "non-dependency node must appear");
  });

  test("NodeRemoved events are decoded from node ID convention", () => {
    const graph = new SystemGraph();
    // "function:src/api/health.ts:getHealth"
    const events = [removedNode("function:src/api/health.ts:getHealth")];

    const diff = computeSemanticDiff(events, graph);

    const api = diff.groups.find((g) => g.category === "API");
    assert.ok(api, "API group should exist for removed API node");
    assert.equal(api!.changes[0].kind, "removed");
    assert.equal(api!.changes[0].name, "getHealth");
  });

  test("groups are sorted alphabetically", () => {
    const graph = new SystemGraph();
    const events = [
      addedNode("function:tests/x.test.ts:t", "function", "t", "tests/x.test.ts"),
      addedNode("function:src/api/x.ts:a", "function", "a", "src/api/x.ts"),
      addedNode("function:src/db/x.ts:d", "function", "d", "src/db/x.ts"),
    ];

    const diff = computeSemanticDiff(events, graph);
    const cats = diff.groups.map((g) => g.category);
    assert.deepEqual(cats, [...cats].sort());
  });
});

describe("computeSemanticDiff — blast radius", () => {
  test("blast radius is 0 when nothing depends on changed nodes", () => {
    const graph = new SystemGraph();
    // Add an isolated node to the graph
    graph.applyEvent({
      id: 999, type: "NodeAdded", payload: {
        type: "NodeAdded",
        node: { id: "function:src/index.ts:main", kind: "function", name: "main", filePath: "src/index.ts" },
      }, timestamp: new Date().toISOString(), commitSha: null,
    });

    const events = [addedNode("function:src/index.ts:main", "function", "main", "src/index.ts")];
    const diff = computeSemanticDiff(events, graph);
    assert.equal(diff.blastRadius, 0);
  });

  test("blast radius counts transitive dependents", () => {
    // Graph: A → B → C (A depends on B; B depends on C)
    // If we change C, blast radius should include B and A.
    const graph = new SystemGraph();
    graph.applyEvent({
      id: 1, type: "NodeAdded", payload: {
        type: "NodeAdded",
        node: { id: "function:src/a.ts:A", kind: "function", name: "A", filePath: "src/a.ts" },
      }, timestamp: "", commitSha: null,
    });
    graph.applyEvent({
      id: 2, type: "NodeAdded", payload: {
        type: "NodeAdded",
        node: { id: "function:src/b.ts:B", kind: "function", name: "B", filePath: "src/b.ts" },
      }, timestamp: "", commitSha: null,
    });
    graph.applyEvent({
      id: 3, type: "NodeAdded", payload: {
        type: "NodeAdded",
        node: { id: "function:src/c.ts:C", kind: "function", name: "C", filePath: "src/c.ts" },
      }, timestamp: "", commitSha: null,
    });
    // A → B (A imports B)
    graph.applyEvent({
      id: 4, type: "EdgeAdded", payload: {
        type: "EdgeAdded",
        edge: { id: "e1", kind: "calls", fromId: "function:src/a.ts:A", toId: "function:src/b.ts:B", confidence: 1.0 },
      }, timestamp: "", commitSha: null,
    });
    // B → C (B imports C)
    graph.applyEvent({
      id: 5, type: "EdgeAdded", payload: {
        type: "EdgeAdded",
        edge: { id: "e2", kind: "calls", fromId: "function:src/b.ts:B", toId: "function:src/c.ts:C", confidence: 1.0 },
      }, timestamp: "", commitSha: null,
    });

    // Change: C was added
    const events = [addedNode("function:src/c.ts:C", "function", "C", "src/c.ts")];
    const diff = computeSemanticDiff(events, graph);

    // Dependents of C: B (direct) and A (transitive)
    assert.equal(diff.blastRadius, 2);
    assert.ok(diff.blastRadiusNodeIds.includes("function:src/a.ts:A"), "A must be in blast radius");
    assert.ok(diff.blastRadiusNodeIds.includes("function:src/b.ts:B"), "B must be in blast radius");
    // C itself must NOT be in blast radius
    assert.ok(!diff.blastRadiusNodeIds.includes("function:src/c.ts:C"), "C must not be in its own blast radius");
  });
});

describe("computeSemanticDiff — no events", () => {
  test("empty event list produces empty diff with 0 blast radius", () => {
    const graph = new SystemGraph();
    const diff = computeSemanticDiff([], graph);
    assert.equal(diff.groups.length, 0);
    assert.equal(diff.blastRadius, 0);
  });
});
