type TaskKind = "preview" | "preload" | "metrics";
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export const GENERATION_CANCELLED = "MASON_CANCELLED";
export const isGenerationCancelled = (error: unknown) => String(error).includes(GENERATION_CANCELLED);

/** IDs belong only to preview work. Export commands never enter this registry. */
export class GenerationTasks {
  private next = 0;
  private session = globalThis.crypto.randomUUID();
  private tasks = new Map<string, { kind: TaskKind; cancelled: boolean }>();

  constructor(private invoke: Invoke) {}

  async run<T>(command: string, args: Record<string, unknown>, kind: TaskKind, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error(GENERATION_CANCELLED);
    const requestId = `${this.session}:${++this.next}`;
    const task = { kind, cancelled: false };
    this.tasks.set(requestId, task);
    const abort = () => this.cancelIds([requestId], false);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await this.invoke<T>(command, { ...args, requestId, background: kind !== "preview" });
      if (task.cancelled) throw new Error(GENERATION_CANCELLED);
      return result;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.tasks.delete(requestId);
    }
  }

  cancel(kinds: TaskKind[], interrupt = false) {
    this.cancelIds([...this.tasks].filter(([, task]) => kinds.includes(task.kind)).map(([id]) => id), interrupt);
  }

  private cancelIds(requestIds: string[], interrupt: boolean) {
    if (!requestIds.length) return;
    requestIds.forEach(id => { const task = this.tasks.get(id); if (task) task.cancelled = true; });
    void this.invoke("cancel_generation", { requestIds, interrupt }).catch(error => console.warn("[generation] cancellation failed:", error));
  }
}
