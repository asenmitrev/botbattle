import { checkBotOutput, CONFIG, CpuBudget, type BotController, type BotState, type BotTurn } from "@arena/engine";

type OutMsg =
  | { type: "booted" }
  | { type: "ready" }
  | { type: "initError"; message: string }
  | { type: "result"; id: number; out: unknown; ms: number }
  | { type: "error"; id: number; message: string; ms: number };

/** Time allowed for the worker script itself to load (not counted against the bot). */
const BOOT_MS = 10_000;

/**
 * Local-testing sandbox: the bot runs in a Web Worker. Limits mirror the official
 * isolated-vm sandbox, but timing is wall-clock (browsers expose no CPU clock) and
 * heap size is not capped. A timed-out worker is terminated and rebuilt next tick
 * with the last good memory.
 */
export class WorkerBot implements BotController {
  private worker: Worker | null = null;
  private memoryJson = "{}";
  private seq = 0;
  private broken: string | null = null;
  private pending = new Map<number, (m: OutMsg) => void>();
  private cpu = new CpuBudget();

  private constructor(readonly name: string, private readonly source: string, private readonly seed: number) {}

  static async create(name: string, source: string, seed: number): Promise<WorkerBot> {
    const b = new WorkerBot(name, source, seed);
    await b.start();
    return b;
  }

  get initError(): string | null {
    return this.broken;
  }

  private async start(): Promise<void> {
    this.kill();
    const w = new Worker(new URL("./bot-worker.ts", import.meta.url), { type: "module", name: `bot:${this.name}` });
    this.worker = w;
    let onLife: ((m: OutMsg) => void) | null = null;
    w.onmessage = (ev: MessageEvent<OutMsg>) => {
      const m = ev.data;
      if ((m.type === "result" || m.type === "error") && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      } else onLife?.(m);
    };
    const wait = (want: OutMsg["type"][], ms: number) =>
      new Promise<OutMsg | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        onLife = (m) => {
          if (want.includes(m.type)) {
            clearTimeout(timer);
            resolve(m);
          }
        };
        w.onerror = (e) => {
          clearTimeout(timer);
          resolve({ type: "initError", message: e.message || "worker failed to load (syntax error?)" });
        };
      });
    const booted = await wait(["booted"], BOOT_MS);
    if (!booted || booted.type === "initError") {
      this.broken = `init failed: ${booted && booted.type === "initError" ? booted.message : "worker did not start"}`;
      return this.kill();
    }
    w.postMessage({ type: "init", source: this.source, seed: this.seed });
    const r = await wait(["ready", "initError"], CONFIG.bot.initMs);
    if (!r) this.broken = `init failed: timeout (top-level code exceeded ${CONFIG.bot.initMs} ms)`;
    else if (r.type === "initError") this.broken = `init failed: ${r.message}`;
    else this.broken = null;
    if (this.broken) this.kill();
  }

  async turn(view: BotState): Promise<BotTurn> {
    if (!this.worker) {
      if (this.broken) return { actions: [], error: this.broken };
      await this.start(); // rebuild after a timeout
      if (!this.worker) return { actions: [], error: this.broken ?? "sandbox unavailable" };
    }
    const id = ++this.seq;
    const w = this.worker;
    const reply = await new Promise<OutMsg | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, CONFIG.bot.tickWallMs);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      w.postMessage({ type: "tick", id, state: JSON.stringify(view), memory: this.memoryJson });
    });
    if (!reply) {
      this.kill();
      return { actions: [], error: `timeout: no reply within ${CONFIG.bot.tickWallMs} ms` };
    }
    if (reply.type === "error") return { actions: [], error: reply.message };
    if (reply.type !== "result") return { actions: [], error: "unexpected sandbox message" };
    const cpuError = this.cpu.charge(reply.ms); // wall-clock in the browser
    if (cpuError) return { actions: [], error: cpuError };
    const { turn, memoryJson } = checkBotOutput(reply.out);
    if (memoryJson !== null) this.memoryJson = memoryJson;
    return turn;
  }

  private kill(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }

  dispose(): void {
    this.kill();
  }
}
