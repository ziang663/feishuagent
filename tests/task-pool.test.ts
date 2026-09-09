import { describe, expect, it } from "vitest";
import { TaskPool } from "../src/task-pool.js";

describe("TaskPool", () => {
  it("bounds active and queued tasks", async () => {
    const pool = new TaskPool(1, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = pool.submit(async () => gate);
    const second = pool.submit(async () => "second");
    const rejected = pool.submit(async () => "third");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(rejected).toBeNull();
    expect(pool.snapshot()).toEqual({ active: 1, queued: 1 });
    release();
    await Promise.all([first, second]);
    expect(pool.snapshot()).toEqual({ active: 0, queued: 0 });
  });
});
