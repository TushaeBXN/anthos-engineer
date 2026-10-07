import {
  createTask,
  getTask,
  listTasks,
  completeTask,
  deleteTask,
} from "./store.js";
import type { Task } from "./types.js";

export function handleCreate(body: { title: string }): Task {
  if (!body.title || typeof body.title !== "string") {
    throw new Error("title is required");
  }
  return createTask(body.title.trim());
}

export function handleGet(id: string): Task {
  const task = getTask(id);
  if (!task) throw new Error(`Task ${id} not found`);
  return task;
}

export function handleList(): Task[] {
  return listTasks();
}

export function handleComplete(id: string): Task {
  const task = completeTask(id);
  if (!task) throw new Error(`Task ${id} not found`);
  return task;
}

export function handleDelete(id: string): { deleted: boolean } {
  if (!deleteTask(id)) throw new Error(`Task ${id} not found`);
  return { deleted: true };
}
