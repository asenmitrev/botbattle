import { CONFIG } from "./config.js";
import type { BotTurn } from "./runner.js";

export interface OutputLimits {
  outputLimitBytes: number;
  memoryLimitBytes: number;
}

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = {
  outputLimitBytes: CONFIG.bot.outputLimitBytes,
  memoryLimitBytes: CONFIG.bot.memoryLimitBytes,
};

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Shared by every sandbox (isolated-vm in Node, Web Worker in the browser).
 * `raw` is what the sandboxed tick function returned: [actionsJson, memoryJson].
 * Returns the turn plus the new memory JSON to persist (null = keep previous memory).
 */
export function checkBotOutput(raw: unknown, limits: OutputLimits = DEFAULT_OUTPUT_LIMITS): { turn: BotTurn; memoryJson: string | null } {
  const fail = (error: string) => ({ turn: { actions: [], error }, memoryJson: null });
  if (!Array.isArray(raw) || typeof raw[0] !== "string" || typeof raw[1] !== "string") return fail("sandbox returned an unexpected value");
  const [actionsJson, memoryJson] = raw as [string, string];
  if (actionsJson.length + memoryJson.length > limits.outputLimitBytes) return fail(`output exceeds ${limits.outputLimitBytes} bytes`);
  const memBytes = utf8Length(memoryJson);
  if (memBytes > limits.memoryLimitBytes) return fail(`memory exceeds ${limits.memoryLimitBytes} bytes (${memBytes})`);
  let actions: unknown;
  try {
    actions = JSON.parse(actionsJson);
    JSON.parse(memoryJson);
  } catch {
    return fail("bot output is not valid JSON");
  }
  return { turn: { actions }, memoryJson };
}

/**
 * Source of the in-sandbox tick wrapper body, shared by both sandboxes.
 * Given captured `parse`/`stringify` and the bot's `onTick`, returns [actionsJson, memoryJson].
 */
export function makeTickFunction(
  onTick: (state: unknown, memory: unknown) => unknown,
  parse: (s: string) => unknown = JSON.parse,
  stringify: (v: unknown) => string | undefined = JSON.stringify,
) {
  return function tick(stateJson: string, memoryJson: string): [string, string] {
    const state = parse(stateJson);
    const memory = parse(memoryJson);
    const actions = onTick(state, memory);
    const a = stringify(actions === undefined ? [] : actions);
    const m = stringify(memory);
    return [a === undefined ? "[]" : a, m === undefined ? "{}" : m];
  };
}

/** mulberry32 as a standalone function, used to seed Math.random inside sandboxes. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return function random() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-bot CPU accounting with a burst bank (see CONFIG.bot.cpuBankMs). */
export class CpuBudget {
  private bank: number;
  constructor(
    private readonly perTickMs: number = CONFIG.bot.tickCpuMs,
    private readonly bankCapMs: number = CONFIG.bot.cpuBankMs,
  ) {
    this.bank = bankCapMs;
  }
  /** Banked CPU currently available on top of the per-tick budget. */
  get banked(): number {
    return this.bank;
  }
  /** Record a tick's CPU use. Returns an error message if the tick must fail. */
  charge(usedMs: number): string | null {
    const allowed = this.perTickMs + this.bank;
    if (usedMs > allowed) {
      this.bank = 0;
      return `CPU budget exceeded: ${usedMs.toFixed(1)} ms > ${allowed.toFixed(1)} ms (${this.perTickMs} ms/tick + ${(allowed - this.perTickMs).toFixed(1)} ms banked)`;
    }
    this.bank = Math.min(this.bankCapMs, this.bank + this.perTickMs - usedMs);
    return null;
  }
}
