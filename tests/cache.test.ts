import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "../src/cache.js";

describe("TtlCache", () => {
  it("expires values", () => {
    vi.useFakeTimers();
    const cache = new TtlCache<string>(1000);
    cache.set("x", "value");
    expect(cache.get("x")).toBe("value");
    vi.advanceTimersByTime(1001);
    expect(cache.get("x")).toBeUndefined();
    vi.useRealTimers();
  });

  it("evicts the least recently used entry", () => {
    const cache = new TtlCache<number>(60_000, 2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });
});
