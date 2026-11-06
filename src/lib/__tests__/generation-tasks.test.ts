import { describe, expect, it, vi } from "vitest";
import { GenerationTasks, isGenerationCancelled } from "../generation-tasks";

function setup() {
  const pending: Array<(value: unknown) => void> = [];
  const invoke = vi.fn((command: string, _args?: Record<string, unknown>) => command === "cancel_generation"
    ? Promise.resolve(undefined)
    : new Promise(resolve => pending.push(resolve)));
  const tasks = new GenerationTasks(invoke as <T>(command: string, args?: Record<string, unknown>) => Promise<T>);
  return { tasks, invoke, pending };
}

describe("generation task ownership", () => {
  it("cancels obsolete preview work without including unrelated tasks", async () => {
    const { tasks, invoke, pending } = setup();
    const first = tasks.run("generate_stl", { part: "base" }, "preview").catch(error => error);
    const latest = tasks.run("generate_stl", { part: "top_cover" }, "preload");
    const firstId = invoke.mock.calls[0][1]!.requestId;
    tasks.cancel(["preview"]);
    expect(invoke).toHaveBeenLastCalledWith("cancel_generation", { requestIds: [firstId], interrupt: false });
    pending[0](new ArrayBuffer(4));
    pending[1](new ArrayBuffer(8));
    expect(isGenerationCancelled(await first)).toBe(true);
    expect((await latest as ArrayBuffer).byteLength).toBe(8);
  });

  it("explicit cancellation interrupts all registered preview work and permits a fresh request", async () => {
    const { tasks, invoke, pending } = setup();
    const old = tasks.run("part_metrics", {}, "metrics").catch(error => error);
    tasks.cancel(["preview", "preload", "metrics"], true);
    expect(invoke.mock.calls[1][1]!.interrupt).toBe(true);
    const next = tasks.run("generate_stl", {}, "preview");
    pending[0]({ volume_mm3: 10 });
    pending[1]("new");
    expect(isGenerationCancelled(await old)).toBe(true);
    expect(await next).toBe("new");
    const count = invoke.mock.calls.length;
    tasks.cancel(["preview", "metrics"], true);
    expect(invoke.mock.calls.length).toBe(count);
  });

  it("aborting metrics never interrupts an active preview and skips already aborted requests", async () => {
    const { tasks, invoke, pending } = setup();
    const controller = new AbortController();
    const metrics = tasks.run("part_metrics", {}, "metrics", controller.signal).catch(error => error);
    controller.abort();
    expect(invoke).toHaveBeenLastCalledWith("cancel_generation", { requestIds: [invoke.mock.calls[0][1]!.requestId], interrupt: false });
    pending[0]({});
    expect(isGenerationCancelled(await metrics)).toBe(true);
    const count = invoke.mock.calls.length;
    await expect(tasks.run("part_metrics", {}, "metrics", controller.signal)).rejects.toThrow("MASON_CANCELLED");
    expect(invoke.mock.calls.length).toBe(count);
  });
});
