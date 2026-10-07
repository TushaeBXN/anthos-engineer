import type { Task } from "./types.js";

const tasks: Task[] = [];
let nextId = 1;

export function createTask(title: string): Task {
  const task: Task = {
    id: String(nextId++),
    title,
    done: false,
    createdAt: new Date().toISOString(),
  };
  tasks.push(task);
  return task;
}

export function getTask(id: string): Task | undefined {
  return tasks.find((t) => t.id === id);
}

export function listTasks(): Task[] {
  return [...tasks];
}

export function completeTask(id: string): Task | undefined {
  const task = tasks.find((t) => t.id === id);
  if (task) task.done = true;
  return task;
}

export function deleteTask(id: string): boolean {
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  tasks.splice(idx, 1);
  return true;
}
