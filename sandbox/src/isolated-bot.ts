import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ivm from "isolated-vm";
import { checkBotOutput, CONFIG, CpuBudget, type BotController, type BotState, type BotTurn } from "@arena/engine";

/** Canonical helper library, exposed to bots as the global `Arena` and as `import ... from "arena"`. */
export const HELPERS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bots/lib/helpers.js");

export type BotSource =
  | { file: string; name?: string }
  /** Pasted code: a single ES module; only `import ... from "arena"` is allowed. */
  | { source: string; name: string };

export interface SandboxOptions {
  /** Seeds the bot's Math.random so matches are reproducible. */
  seed?: number;
  memoryMb?: number;
  tickCpuMs?: number;
  tickWallMs?: number;
  initMs?: number;
  outputLimitBytes?: number;
  memoryLimitBytes?: number;
  cpuBankMs?: number;
}

/**
 * Runs inside the isolate before any bot code. It captures pristine JSON functions,
 * removes globals that could block or escape limits, seeds Math.random and installs
 * the two entry points the host keeps references to.
 */
const BOOTSTRAP = `
(function (seed) {
  "use strict";
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const g = globalThis;
  for (const k of ["Atomics", "SharedArrayBuffer", "WebAssembly"]) {
    try { delete g[k]; } catch (e) {}
  }
  let s = seed >>> 0;
  Math.random = function random() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let onTick = null;
  g.__arenaSetBot = function (fn) {
    if (typeof fn !== "function") throw new TypeError("bot must export a function onTick(state, memory)");
    onTick = fn;
  };
  g.__arenaTick = function (stateJson, memoryJson) {
    const state = parse(stateJson);
    const memory = parse(memoryJson);
    const actions = onTick(state, memory);
    const a = stringify(actions === undefined ? [] : actions);
    const m = stringify(memory);
    return [a === undefined ? "[]" : a, m === undefined ? "{}" : m];
  };
})
`;

const GLOBALS = `
import * as arena from "arena";
globalThis.Arena = Object.freeze({ ...arena });
`;

// Module evaluation follows import order: Arena is installed before the bot's top-level code runs.
const ENTRY = `
import "arena:globals";
import * as bot from "__bot__";
const fn = typeof bot.onTick === "function" ? bot.onTick : bot.default && bot.default.onTick;
globalThis.__arenaSetBot(fn);
delete globalThis.__arenaSetBot;
delete globalThis.__arenaTick;
`;

class SandboxError extends Error {}

/**
 * A bot running in its own isolated-vm isolate: 64 MB heap, 50 ms CPU per tick,
 * 1000 ms init, no fs / network / timers / require. Failures are reported as
 * BotTurn errors and never thrown; after an out-of-memory disposal the isolate is
 * rebuilt on the next tick (memory reverts to the last good tick).
 */
export class IsolatedBot implements BotController {
  readonly name: string;
  private isolate: ivm.Isolate | null = null;
  private tickRef: ivm.Reference<(s: string, m: string) => [string, string]> | null = null;
  private memoryJson = "{}";
  private broken: string | null = null;
  private readonly opts: Required<SandboxOptions>;
  private readonly cpu: CpuBudget;

  private constructor(private readonly src: BotSource, opts: SandboxOptions) {
    this.name = src.name ?? path.basename((src as { file: string }).file).replace(/\.[cm]?js$/, "");
    const b = CONFIG.bot;
    this.opts = {
      seed: opts.seed ?? 0,
      memoryMb: opts.memoryMb ?? b.isolateMemoryMb,
      tickCpuMs: opts.tickCpuMs ?? b.tickCpuMs,
      tickWallMs: opts.tickWallMs ?? b.tickWallMs,
      initMs: opts.initMs ?? b.initMs,
      outputLimitBytes: opts.outputLimitBytes ?? b.outputLimitBytes,
      memoryLimitBytes: opts.memoryLimitBytes ?? b.memoryLimitBytes,
      cpuBankMs: opts.cpuBankMs ?? b.cpuBankMs,
    };
    this.cpu = new CpuBudget(this.opts.tickCpuMs, this.opts.cpuBankMs);
  }

  /** Never throws for bad bot code: a bot that fails to initialize fails every turn (and forfeits). */
  static async create(src: BotSource, opts: SandboxOptions = {}): Promise<IsolatedBot> {
    const bot = new IsolatedBot(src, opts);
    await bot.init();
    return bot;
  }

  /** Error from initialization, if any. */
  get initError(): string | null {
    return this.broken;
  }

  private async init(): Promise<void> {
    this.disposeIsolate();
    try {
      const isolate = new ivm.Isolate({ memoryLimit: this.opts.memoryMb });
      this.isolate = isolate;
      const context = await isolate.createContext();
      const boot = await isolate.compileScript(BOOTSTRAP);
      const bootFn = (await boot.run(context, { reference: true })) as ivm.Reference<(seed: number) => void>;
      await bootFn.apply(undefined, [this.opts.seed >>> 0], { timeout: 100 });
      this.tickRef = (await context.global.get("__arenaTick", { reference: true })) as typeof this.tickRef;

      const cache = new Map<string, ivm.Module>();
      const helpers = await isolate.compileModule(fs.readFileSync(HELPERS_PATH, "utf8"), { filename: "arena:helpers" });
      const userModule = await this.compileUser(isolate, cache);
      const globals = await isolate.compileModule(GLOBALS, { filename: "arena:globals" });
      const entry = await isolate.compileModule(ENTRY, { filename: "arena:entry" });

      const resolve = async (spec: string, referrer: ivm.Module): Promise<ivm.Module> => {
        if (spec === "arena") return helpers;
        if (spec === "arena:globals" && referrer === entry) return globals;
        if (spec === "__bot__" && referrer === entry) return userModule;
        const from = this.moduleFiles.get(referrer);
        if (!from || !(spec.startsWith("./") || spec.startsWith("../"))) {
          throw new SandboxError(`import "${spec}" is not allowed (only "arena" and relative files)`);
        }
        const abs = path.resolve(path.dirname(from), spec);
        if (!abs.startsWith(this.rootDir + path.sep)) throw new SandboxError(`import "${spec}" escapes the bot directory`);
        let m = cache.get(abs);
        if (!m) {
          m = await isolate.compileModule(fs.readFileSync(abs, "utf8"), { filename: abs });
          cache.set(abs, m);
          this.moduleFiles.set(m, abs);
        }
        return m;
      };
      await entry.instantiate(context, resolve);
      const before = isolate.cpuTime;
      await entry.evaluate({ timeout: this.opts.initMs });
      const cpuMs = Number(isolate.cpuTime - before) / 1e6;
      if (cpuMs > this.opts.initMs) throw new SandboxError(`init exceeded ${this.opts.initMs} ms CPU (${cpuMs.toFixed(0)} ms)`);
      this.broken = null;
    } catch (e) {
      this.broken = `init failed: ${describeError(e, this.isolate)}`;
      this.disposeIsolate();
    }
  }

  private moduleFiles = new Map<ivm.Module, string>();
  private rootDir = "";

  private async compileUser(isolate: ivm.Isolate, cache: Map<string, ivm.Module>): Promise<ivm.Module> {
    if ("file" in this.src) {
      const abs = path.resolve(this.src.file);
      this.rootDir = path.dirname(abs);
      const m = await isolate.compileModule(fs.readFileSync(abs, "utf8"), { filename: abs });
      cache.set(abs, m);
      this.moduleFiles.set(m, abs);
      return m;
    }
    return isolate.compileModule(this.src.source, { filename: `bot:${this.src.name}` });
  }

  async turn(view: BotState): Promise<BotTurn> {
    if (!this.isolate || this.isolate.isDisposed || !this.tickRef) {
      if (this.broken) return { actions: [], error: this.broken };
      await this.init(); // recover after an out-of-memory disposal
      if (this.broken || !this.tickRef) return { actions: [], error: this.broken ?? "sandbox unavailable" };
    }
    const isolate = this.isolate!;
    const before = isolate.cpuTime;
    let out: unknown;
    try {
      out = await this.tickRef!.apply(undefined, [JSON.stringify(view), this.memoryJson], {
        timeout: this.opts.tickWallMs,
        result: { copy: true },
      });
    } catch (e) {
      const msg = describeError(e, isolate);
      if (isolate.isDisposed) this.disposeIsolate();
      return { actions: [], error: msg };
    }
    const cpuError = this.cpu.charge(Number(isolate.cpuTime - before) / 1e6);
    if (cpuError) return { actions: [], error: cpuError };
    const { turn, memoryJson } = checkBotOutput(out, this.opts);
    if (memoryJson !== null) this.memoryJson = memoryJson;
    return turn;
  }

  private disposeIsolate(): void {
    this.tickRef?.release();
    this.tickRef = null;
    if (this.isolate && !this.isolate.isDisposed) this.isolate.dispose();
    this.isolate = null;
    this.moduleFiles = new Map();
  }

  dispose(): void {
    this.disposeIsolate();
  }
}

function describeError(e: unknown, isolate: ivm.Isolate | null): string {
  if (isolate?.isDisposed) return `out of memory (isolate limit exceeded): ${errText(e)}`;
  const t = errText(e);
  if (/execution timed out/i.test(t)) return `timeout: ${t}`;
  return t;
}

function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 500);
  return String(e).slice(0, 500);
}
