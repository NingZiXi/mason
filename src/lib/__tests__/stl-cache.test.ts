import { describe, expect, it, vi } from "vitest";
import { cacheStlPart, clearStlCache } from "../stl-cache";

describe("STL cache geometry ownership", () => {
  it("keeps parsed geometry and its bytes when duplicate preload finishes", () => {
    const geometry = { dispose: vi.fn() };
    const entries = { insert: { bytes: new ArrayBuffer(8), paramsHash: "a", geometry } };
    const result = cacheStlPart(entries, "insert", new ArrayBuffer(16), "a");
    expect(result).toBe(entries);
    expect(result.insert.geometry).toBe(geometry);
    expect(geometry.dispose).not.toHaveBeenCalled();
  });

  it("releases replaced geometry and preserves other parts", () => {
    const geometry = { dispose: vi.fn() };
    const other = { bytes: new ArrayBuffer(8), paramsHash: "a", geometry: { dispose: vi.fn() } };
    const entries = { insert: { bytes: new ArrayBuffer(8), paramsHash: "a", geometry }, base: other };
    const bytes = new ArrayBuffer(16);
    const result = cacheStlPart(entries, "insert", bytes, "b");
    expect(geometry.dispose).toHaveBeenCalledTimes(1);
    expect(result.insert).toEqual({ bytes, paramsHash: "b" });
    expect(result.base).toBe(other);
    expect(other.geometry.dispose).not.toHaveBeenCalled();
  });

  it("releases every unique geometry once on reset, including shared entries", () => {
    const first = { dispose: vi.fn() };
    const second = { dispose: vi.fn() };
    clearStlCache({
      insert: { bytes: new ArrayBuffer(8), paramsHash: "a", geometry: first },
      base: { bytes: new ArrayBuffer(8), paramsHash: "a", geometry: second },
      shared: { bytes: new ArrayBuffer(8), paramsHash: "a", geometry: first },
      unparsed: { bytes: new ArrayBuffer(8), paramsHash: "a" },
    });
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).toHaveBeenCalledTimes(1);
  });
});
