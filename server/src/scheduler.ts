import type { Ladder } from "./ladder.js";

export interface Job {
  p1: string;
  p2: string;
  seed: number;
  reason: "placement" | "background";
}

export interface SchedulerOptions {
  /** Matches played at the same time (each bot runs in its own isolate). Default 1. */
  concurrency?: number;
  /** Pause between matches (ms). Keeps the host responsive. */
  idleDelayMs?: number;
  /** Play background games when the queue is empty. */
  autoplay?: boolean;
  /** Window of recent matches used to find under-played bots and stale pairings. */
  fairnessWindow?: number;
  /** Random source in [0, 1). Injectable for tests. */
  random?: () => number;
  onMatch?: (matchId: string) => void;
  onError?: (err: unknown, job: Job) => void;
}

/**
 * Up to `concurrency` matches at a time, in-process. Placement games for new/updated bots jump ahead
 * of background games: the bot plays every other bot, in random order, both sides.
 * Background: a random bot (weighted toward the least-played in the recent window)
 * vs a randomly sampled opponent (weighted toward pairings not played recently),
 * both sides on one seed. No deterministic "closest Elo", so the top never locks in.
 */
export class Scheduler {
  readonly queue: Job[] = [];
  /** Jobs currently being played. */
  private readonly inFlight = new Set<Job>();
  private workers = 0;
  private stopped = true;
  private wakers: (() => void)[] = [];
  private idleWaiters: (() => void)[] = [];
  private readonly opts: Required<Omit<SchedulerOptions, "onMatch" | "onError">> & Pick<SchedulerOptions, "onMatch" | "onError">;

  constructor(private readonly ladder: Ladder, opts: SchedulerOptions = {}) {
    this.opts = {
      concurrency: Math.max(1, Math.floor(opts.concurrency ?? 1)),
      idleDelayMs: opts.idleDelayMs ?? 500,
      autoplay: opts.autoplay ?? true,
      fairnessWindow: opts.fairnessWindow ?? 60,
      random: opts.random ?? Math.random,
      onMatch: opts.onMatch,
      onError: opts.onError,
    };
  }

  get busy(): boolean {
    return this.inFlight.size > 0;
  }

  /** Number of matches being played right now. */
  get running(): number {
    return this.inFlight.size;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    for (let i = 0; i < this.opts.concurrency; i++) void this.worker();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake();
    while (this.workers > 0) await sleep(10);
  }

  private wake(): void {
    for (const r of this.wakers.splice(0)) r();
  }

  private notifyIfIdle(): void {
    if (this.queue.length === 0 && this.inFlight.size === 0) for (const r of this.idleWaiters.splice(0)) r();
  }

  /**
   * Placement: the bot plays every other bot, both sides, one seed per pair, in random
   * order (so early results aren't biased by who is on top). Returns the number of games.
   */
  enqueuePlacement(botId: string): number {
    // Drop stale queued games for this bot (it has a new version).
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const j = this.queue[i]!;
      if (j.reason === "placement" && (j.p1 === botId || j.p2 === botId)) this.queue.splice(i, 1);
    }
    const me = this.ladder.bot(botId);
    if (!me) return 0;
    const opponents = shuffle(this.ladder.data.bots.filter((b) => b.id !== botId), this.opts.random);
    const jobs: Job[] = [];
    for (const o of opponents) {
      const seed = this.ladder.nextSeed();
      jobs.push({ p1: botId, p2: o.id, seed, reason: "placement" }, { p1: o.id, p2: botId, seed, reason: "placement" });
    }
    // Placement goes ahead of background games but behind earlier placements.
    const firstBackground = this.queue.findIndex((j) => j.reason === "background");
    this.queue.splice(firstBackground === -1 ? this.queue.length : firstBackground, 0, ...jobs);
    this.wake();
    return jobs.length;
  }

  /** Drop queued games involving a (deleted) bot. A game already running is discarded by Ladder.playGame. */
  dropBot(botId: string): number {
    let n = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const j = this.queue[i]!;
      if (j.p1 === botId || j.p2 === botId) {
        this.queue.splice(i, 1);
        n++;
      }
    }
    return n;
  }

  /** Resolves once the queue is empty and no game is running. */
  whenIdle(): Promise<void> {
    if (this.inFlight.size === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private backgroundPair(): Job[] {
    const bots = this.ladder.data.bots;
    if (bots.length < 2) return [];
    const recent = this.ladder.data.matches.slice(-this.opts.fairnessWindow);
    const played = new Map<string, number>();
    const pairs = new Map<string, number>();
    for (const m of recent) {
      played.set(m.p1.id, (played.get(m.p1.id) ?? 0) + 1);
      played.set(m.p2.id, (played.get(m.p2.id) ?? 0) + 1);
      const k = pairKey(m.p1.id, m.p2.id);
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
    // Games being played right now count too, so parallel slots don't all pick the same bot or pairing.
    for (const j of this.inFlight) {
      played.set(j.p1, (played.get(j.p1) ?? 0) + 1);
      played.set(j.p2, (played.get(j.p2) ?? 0) + 1);
      const k = pairKey(j.p1, j.p2);
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
    // Who plays: anyone can, but under-played bots are much more likely.
    const me = pick(bots, (b) => 1 / (1 + (played.get(b.id) ?? 0)) ** 2, this.opts.random);
    // Against whom: uniform over the ladder, except pairings played recently are damped.
    const opp = pick(
      bots.filter((b) => b.id !== me.id),
      (b) => 1 / (1 + (pairs.get(pairKey(me.id, b.id)) ?? 0)) ** 2,
      this.opts.random,
    );
    const seed = this.ladder.nextSeed();
    return [
      { p1: me.id, p2: opp.id, seed, reason: "background" },
      { p1: opp.id, p2: me.id, seed, reason: "background" },
    ];
  }

  /** One playing slot. `concurrency` of these run side by side, sharing the queue. */
  private async worker(): Promise<void> {
    this.workers++;
    try {
      while (!this.stopped) {
        if (this.queue.length === 0 && this.opts.autoplay) this.queue.push(...this.backgroundPair());
        const job = this.queue.shift();
        if (!job) {
          this.notifyIfIdle();
          await new Promise<void>((r) => this.wakers.push(r));
          continue;
        }
        this.inFlight.add(job);
        try {
          if (this.ladder.bot(job.p1) && this.ladder.bot(job.p2)) {
            const m = await this.ladder.playGame(job.p1, job.p2, job.seed);
            if (m) this.opts.onMatch?.(m.id);
          }
        } catch (e) {
          this.opts.onError?.(e, job);
        } finally {
          this.inFlight.delete(job);
        }
        this.notifyIfIdle();
        await sleep(this.opts.idleDelayMs);
      }
    } finally {
      this.workers--;
      if (this.workers === 0) for (const r of this.idleWaiters.splice(0)) r();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Weighted random choice. `items` must be non-empty. */
function pick<T>(items: readonly T[], weight: (t: T) => number, random: () => number): T {
  const ws = items.map(weight);
  let r = random() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) {
    r -= ws[i]!;
    if (r < 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}
