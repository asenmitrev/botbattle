import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBotView, createInitialState, hashState, runMatch, type BotController } from "@arena/engine";
import { IsolatedBot, type SandboxOptions } from "../src/index.js";
import { loadLocalBot } from "../../cli/src/local-bot.js";

const BOTS = path.resolve(__dirname, "../../bots");
const FIX = path.resolve(__dirname, "fixtures");
const created: IsolatedBot[] = [];
afterEach(() => {
  for (const b of created.splice(0)) b.dispose();
});

async function sandboxed(source: string, opts: SandboxOptions = {}) {
  const b = await IsolatedBot.create({ source, name: "test" }, opts);
  created.push(b);
  return b;
}
async function fileBot(file: string, opts: SandboxOptions = {}) {
  const b = await IsolatedBot.create({ file }, opts);
  created.push(b);
  return b;
}
const view = () => buildBotView(createInitialState(1), 1);
const idle = async (): Promise<BotController> => loadLocalBot(path.join(BOTS, "idle.js"), `idle-${Math.random()}`);

describe("normal operation", () => {
  it("runs a pasted bot, persists memory, exposes helpers as global Arena and as import 'arena'", async () => {
    const bot = await sandboxed(`
      import { distance } from "arena";
      const topLevel = typeof Arena.nearest;
      export function onTick(state, memory) {
        memory.n = (memory.n || 0) + 1;
        return [{ type: "log", text: [memory.n, distance({x:0,y:0},{x:3,y:1}), Arena.manhattan({x:0,y:0},{x:3,y:1}), topLevel].join(",") }];
      }`);
    expect(bot.initError).toBeNull();
    expect((await bot.turn(view())).actions).toEqual([{ type: "log", text: "1,3,4,function" }]);
    expect((await bot.turn(view())).actions).toEqual([{ type: "log", text: "2,3,4,function" }]);
  });

  it("sample bots produce exactly the same match sandboxed as in-process", async () => {
    const seed = 21;
    const local = await runMatch(
      [await loadLocalBot(path.join(BOTS, "balanced.js"), `a${Math.random()}`), await loadLocalBot(path.join(BOTS, "rusher.js"), `b${Math.random()}`)],
      { seed },
    );
    const iso = await runMatch([await fileBot(path.join(BOTS, "balanced.js")), await fileBot(path.join(BOTS, "rusher.js"))], { seed });
    expect(iso.replay.ticks.flatMap((t) => t.runnerEvents ?? [])).toEqual([]);
    expect(hashState(iso.state)).toBe(hashState(local.state));
  });

  it("Math.random is seeded: reproducible per seed", async () => {
    const src = `export function onTick() { return [{ type: "log", text: String(Math.random()) }]; }`;
    const a = await (await sandboxed(src, { seed: 7 })).turn(view());
    const b = await (await sandboxed(src, { seed: 7 })).turn(view());
    const c = await (await sandboxed(src, { seed: 8 })).turn(view());
    expect(a.actions).toEqual(b.actions);
    expect(a.actions).not.toEqual(c.actions);
  });
});

describe("malicious and broken bots", () => {
  it("infinite loop in onTick: times out each tick, forfeits after 10, engine keeps going", async () => {
    const bot = await sandboxed(`export function onTick() { for (;;) {} }`);
    const t0 = Date.now();
    const { state, replay } = await runMatch([bot, await idle()], { seed: 1 });
    expect(state.result).toMatchObject({ winner: 2, reason: "forfeit" });
    expect(state.tick).toBe(10);
    const errs = replay.ticks.flatMap((t) => t.runnerEvents ?? []);
    expect(errs).toHaveLength(10);
    expect(errs[0]).toMatchObject({ type: "bot_error", player: 1 });
    expect((errs[0] as { message: string }).message).toMatch(/timeout/);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it("infinite loop at top level: init fails within the 1000 ms budget and the bot forfeits", async () => {
    const t0 = Date.now();
    const bot = await sandboxed(`for (;;) {} export function onTick() { return []; }`);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(bot.initError).toMatch(/init failed: timeout/);
    const { state } = await runMatch([await idle(), bot], { seed: 1 });
    expect(state.result).toMatchObject({ winner: 1, reason: "forfeit" });
  });

  it("CPU bank: spikes are absorbed, sustained use over 50 ms/tick fails within a few ticks", async () => {
    // ~120 ms per tick: under the 500 ms wall cutoff, over the 50 ms average.
    const bot = await sandboxed(`export function onTick() { const t = Date.now(); while (Date.now() - t < 120) {} return [{ type: "log", text: "done" }]; }`);
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await bot.turn(view()));
    expect(results[0]!.error).toBeUndefined(); // 120 <= 50 + 250 banked
    const failed = results.filter((r) => r.error);
    expect(failed.length).toBeGreaterThanOrEqual(2);
    expect(failed[0]!.error).toMatch(/CPU budget exceeded/);
  });

  it("huge heap allocation: isolate dies, host survives, bot recovers next tick with last good memory", async () => {
    // OOMs only on game tick 1 (driven by state, not memory), so recovery is observable.
    const bot = await sandboxed(`
      export function onTick(state, memory) {
        memory.calls = (memory.calls || 0) + 1;
        if (state.tick === 1) { const a = []; for (;;) a.push(new Array(1000).fill(memory.calls)); }
        return [{ type: "log", text: "calls" + memory.calls }];
      }`, { tickWallMs: 10_000 });
    const v0 = view();
    expect((await bot.turn(v0)).actions).toEqual([{ type: "log", text: "calls1" }]);
    const oom = await bot.turn({ ...v0, tick: 1 });
    expect(oom.error).toMatch(/out of memory/i);
    // Fresh isolate, memory reverted to the last good tick ({calls:1}).
    const rec = await bot.turn({ ...v0, tick: 2 });
    expect(rec.error).toBeUndefined();
    expect(rec.actions).toEqual([{ type: "log", text: "calls2" }]);
  });

  it("huge ArrayBuffer / typed array allocations fail inside the isolate", async () => {
    const bot = await sandboxed(`export function onTick() { const b = new ArrayBuffer(2 ** 31); new Uint8Array(b).fill(1); return []; }`);
    const turn = await bot.turn(view());
    expect(turn.error).toBeTruthy();
  });

  it("throwing (Error, primitives, hostile objects) is a failed tick", async () => {
    for (const src of [
      `export function onTick() { throw new Error("boom"); }`,
      `export function onTick() { throw 42; }`,
      `export function onTick() { throw { toString() { for(;;){} } }; }`,
      `export function onTick() { return null.x; }`,
    ]) {
      const t = await (await sandboxed(src)).turn(view());
      expect(t.error).toBeTruthy();
      expect(t.actions).toEqual([]);
    }
  });

  it("no access to require, process, fs, network, timers, or dynamic import", async () => {
    const bot = await sandboxed(`
      export function onTick() {
        const probe = (f) => { try { return String(f()); } catch (e) { return "blocked"; } };
        return [{ type: "log", text: JSON.stringify({
          require: typeof require, process: typeof process, fetch: typeof fetch, setTimeout: typeof setTimeout,
          setInterval: typeof setInterval, queueMicrotask: typeof queueMicrotask, Buffer: typeof Buffer,
          WebAssembly: typeof WebAssembly, Atomics: typeof Atomics, SharedArrayBuffer: typeof SharedArrayBuffer,
          ctor: probe(() => (function(){}).constructor("return typeof process")()),
          globalProcess: probe(() => typeof globalThis.process),
        }) }];
      }`);
    const t = await bot.turn(view());
    expect(t.error).toBeUndefined();
    const info = JSON.parse((t.actions as { text: string }[])[0]!.text);
    for (const k of ["require", "process", "fetch", "setTimeout", "setInterval", "Buffer", "WebAssembly", "Atomics", "SharedArrayBuffer"]) {
      expect(info[k], k).toBe("undefined");
    }
    expect(info.ctor).toBe("undefined");
    expect(info.globalProcess).toBe("undefined");

    // Dynamic import can only yield a rejected promise (or throw); bots are synchronous, so nothing ever loads.
    const dyn = await sandboxed(`
      export function onTick(state, memory) {
        let kind;
        try { const p = import("fs"); p.catch(() => {}); kind = typeof p.then; } catch (e) { kind = "threw"; }
        return [{ type: "log", text: kind + ":" + typeof globalThis.fs }];
      }`);
    const r = await dyn.turn(view());
    expect(r.error).toBeUndefined();
    expect((r.actions as { text: string }[])[0]!.text).toMatch(/^(function|threw):undefined$/);
  });

  it("static imports other than 'arena' are rejected at init; file bots cannot import outside their directory", async () => {
    for (const spec of ["fs", "node:child_process", "./other.js", "https://example.com/x.js"]) {
      const bot = await sandboxed(`import x from "${spec}"; export function onTick() { return []; }`);
      expect(bot.initError, spec).toMatch(/not allowed/);
    }
    const esc = await fileBot(path.join(FIX, "nested/escape.js"));
    expect(esc.initError).toMatch(/escapes the bot directory/);
  });

  it("missing onTick is an init failure", async () => {
    const bot = await sandboxed(`export const x = 1;`);
    expect(bot.initError).toMatch(/onTick/);
  });

  it("bad return values: non-arrays, garbage actions, cyclic objects, getter bombs, huge outputs", async () => {
    const ok = async (src: string) => (await sandboxed(src)).turn(view());
    expect((await ok(`export function onTick() { return "hello"; }`)).actions).toBe("hello"); // engine drops it
    expect((await ok(`export function onTick() { return undefined; }`)).actions).toEqual([]);
    expect((await ok(`export function onTick() { const a = []; a.push(a); return a; }`)).error).toMatch(/circular|cyclic/i);
    expect((await ok(`export function onTick() { return [{ get type() { for(;;){} } }]; }`)).error).toMatch(/timeout/);
    expect((await ok(`export function onTick() { return [{ type: "log", text: "x".repeat(2 * 1024 * 1024) }]; }`)).error).toMatch(/output exceeds/);

    // Garbage actions reach the engine, which drops them as invalid_action events.
    const garbage = await sandboxed(`export function onTick(s) { return [null, 1, { type: "move", unitId: -5, dir: "UP" }, { type: "spawn", unit: "tank" }]; }`);
    const { replay } = await runMatch([garbage, await idle()], { seed: 1 });
    expect(replay.ticks[0]!.events.filter((e) => e.type === "invalid_action")).toHaveLength(4);
    expect(replay.result).toBeTruthy();
  });

  it("memory over 100 KB is a failure and the previous memory is kept", async () => {
    const bot = await sandboxed(`
      export function onTick(state, memory) {
        memory.t = (memory.t || 0) + 1;
        if (memory.t === 2) memory.big = "x".repeat(200 * 1024);
        return [{ type: "log", text: String(memory.t) + ":" + (memory.big ? "big" : "small") }];
      }`);
    expect((await bot.turn(view())).actions).toEqual([{ type: "log", text: "1:small" }]);
    expect((await bot.turn(view())).error).toMatch(/memory exceeds/);
    expect((await bot.turn(view())).error).toMatch(/memory exceeds/); // t=2 again from reverted memory
  });

  it("tampering with globals only affects the bot itself", async () => {
    const bot = await sandboxed(`
      JSON.stringify = () => "pwned"; JSON.parse = () => ({}); Object.prototype.evil = 1; Array.prototype.push = null;
      export function onTick(state) { return [{ type: "log", text: String(state.tick) }]; }`);
    const t = await bot.turn(view());
    expect(t.error).toBeUndefined();
    expect(t.actions).toEqual([{ type: "log", text: "0" }]);
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });

  it("a sandboxed match with one hostile bot never crashes the host", async () => {
    const chaos = await sandboxed(`
      export function onTick(state, memory) {
        const t = state.tick % 5;
        if (t === 0) throw new Error("x");
        if (t === 1) for(;;){}
        if (t === 2) return [{ type: "spawn", unit: "fighter" }, { type: "attack", unitId: 1, targetId: 2 }];
        if (t === 3) return 5;
        return state.myUnits.map(u => ({ type: "moveTo", unitId: u.id, x: 20, y: 20 }));
      }`);
    const { state } = await runMatch([chaos, await fileBot(path.join(BOTS, "rusher.js"))], { seed: 4 });
    expect(state.result).not.toBeNull();
  });
});
