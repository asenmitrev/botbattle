import os from "node:os";
import { Worker } from "node:worker_threads";
import { runMatch, type MatchResult, type Replay } from "@arena/engine";
import { IsolatedBot, type BotSource } from "@arena/sandbox";

/** Everything needed to play one match, plain data so it can cross a thread boundary. */
export interface MatchSpec {
  seed: number;
  bots: [MatchBot, MatchBot];
}
export interface MatchBot {
  src: BotSource;
  /** Seeds the bot's Math.random. */
  rngSeed: number;
}
export interface MatchRun {
  result: MatchResult;
  replay: Replay;
}

/** Plays a match: in this thread, or on a worker pool. */
export type MatchRunner = (spec: MatchSpec) => Promise<MatchRun>;

/** Play a match on the calling thread (the engine runs here; bots run in their isolates). */
export async function playMatch(spec: MatchSpec): Promise<MatchRun> {
  const [a, b] = spec.bots;
  const ca = await IsolatedBot.create(a.src, { seed: a.rngSeed });
  try {
    const cb = await IsolatedBot.create(b.src, { seed: b.rngSeed });
    try {
      const { state, replay } = await runMatch([ca, cb], { seed: spec.seed });
      return { result: state.result!, replay };
    } finally {
      cb.dispose();
    }
  } finally {
    ca.dispose();
  }
}

export const inProcessRunner: MatchRunner = playMatch;

interface Pending {
  spec: MatchSpec;
  resolve: (r: MatchRun) => void;
  reject: (e: Error) => void;
}

/**
 * A fixed pool of worker threads, each playing one match at a time. Moves the engine
 * (simulation, fog views, replay recording) off the main thread, so parallel matches
 * use several cores and the HTTP API stays responsive.
 */
export class MatchPool {
  private readonly idle: Worker[] = [];
  private readonly busy = new Map<Worker, Pending>();
  private readonly waiting: Pending[] = [];
  private closed = false;

  constructor(readonly size: number = Math.max(1, os.availableParallelism() - 1)) {
    for (let i = 0; i < size; i++) this.spawn();
  }

  readonly run: MatchRunner = (spec) =>
    new Promise<MatchRun>((resolve, reject) => {
      if (this.closed) return reject(new Error("match pool closed"));
      this.waiting.push({ spec, resolve, reject });
      this.dispatch();
    });

  private spawn(): void {
    const w = new Worker(new URL("./match-worker.mjs", import.meta.url));
    w.on("message", (msg: { ok: true; run: MatchRun } | { ok: false; error: string }) => {
      const p = this.busy.get(w);
      this.busy.delete(w);
      this.idle.push(w);
      if (p) {
        if (msg.ok) p.resolve(msg.run);
        else p.reject(new Error(msg.error));
      }
      this.dispatch();
    });
    const fail = (err: Error) => {
      const p = this.busy.get(w);
      this.busy.delete(w);
      const i = this.idle.indexOf(w);
      if (i !== -1) this.idle.splice(i, 1);
      p?.reject(err);
      if (!this.closed) {
        this.spawn(); // replace the dead worker
        this.dispatch();
      }
    };
    w.on("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));
    w.on("exit", (code) => {
      if (this.busy.has(w) || this.idle.includes(w)) fail(new Error(`match worker exited (code ${code})`));
    });
    this.idle.push(w);
  }

  private dispatch(): void {
    while (this.idle.length > 0 && this.waiting.length > 0) {
      const w = this.idle.shift()!;
      const p = this.waiting.shift()!;
      this.busy.set(w, p);
      w.postMessage(p.spec);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.waiting.splice(0)) p.reject(new Error("match pool closed"));
    const all = [...this.idle, ...this.busy.keys()];
    for (const p of this.busy.values()) p.reject(new Error("match pool closed"));
    this.idle.length = 0;
    this.busy.clear();
    await Promise.all(all.map((w) => w.terminate()));
  }
}
