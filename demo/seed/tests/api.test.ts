import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleCreate, handleGet, handleList, handleComplete, handleDelete } from "../src/api.js";

describe("handleCreate", () => {
  test("creates a task with the given title", () => {
    const task = handleCreate({ title: "Buy milk" });
    assert.equal(task.title, "Buy milk");
    assert.equal(task.done, false);
    assert.ok(task.id);
    assert.ok(task.createdAt);
  });

  test("throws when title is empty", () => {
    assert.throws(() => handleCreate({ title: "" }), /title is required/);
  });
});

describe("handleGet", () => {
  test("returns the task by id", () => {
    const created = handleCreate({ title: "Get test task" });
    const found = handleGet(created.id);
    assert.equal(found.id, created.id);
  });

  test("throws when task does not exist", () => {
    assert.throws(() => handleGet("999999"), /not found/);
  });
});

describe("handleList", () => {
  test("returns an array", () => {
    const list = handleList();
    assert.ok(Array.isArray(list));
  });
});

describe("handleComplete", () => {
  test("marks the task done", () => {
    const task = handleCreate({ title: "Finish demo" });
    const updated = handleComplete(task.id);
    assert.equal(updated.done, true);
  });
});

describe("handleDelete", () => {
  test("deletes the task", () => {
    const task = handleCreate({ title: "Delete me" });
    const result = handleDelete(task.id);
    assert.equal(result.deleted, true);
    assert.throws(() => handleGet(task.id), /not found/);
  });
});
