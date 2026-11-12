import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashState, runMatch, simulateReplay, stableStringify, verifyReplay, type BotController, type BotState, type GameState } from "@arena/engine";
import { loadLocalBot } from "../src/local-bot.js";

const BOTS = path.resolve(__dirname, "../../bots");
const bot = (name: string, tag: string) => loadLocalBot(path.join(BOTS, `${name}.js`), tag);

async function play(a: string, b: string, seed: number) {
  return runMatch([await bot(a, `${a}-${seed}-1-${Math.random()}`), await bot(b, `${b}-${seed}-2-${Math.random()}`)], { seed });
}

describe("determinism", () => {
  it("same seed + same bots → byte-identical replay", async () => {
    const r1 = await play("balanced", "rusher", 42);
    const r2 = await play("balanced", "rusher", 42);
    expect(JSON.stringify(r1.replay)).toBe(JSON.stringify(r2.replay));
    expect(hashState(r1.state)).toBe(hashState(r2.state));
  });

  it("different seeds give different matches", async () => {
    const r1 = await play("greedy", "greedy", 1);
    const r2 = await play("greedy", "greedy", 2);
    expect(r1.replay.finalStateHash).not.toBe(r2.replay.finalStateHash);
  });

  it("engine is side-neutral: a mirror-consistent bot vs itself stays point-symmetric every tick", async () => {
    for (const seed of [9, 10, 11]) {
      let asymmetricAt = -1;
      const { state } = await runMatch([symmetricBot(), symmetricBot()], {
        seed,
        onTick: (s) => {
          if (asymmetricAt === -1 && !isPointSymmetric(s)) asymmetricAt = s.tick;
        },
      });
      expect(asymmetricAt).toBe(-1);
      expect(state.result!.winner).toBe("draw");
    }
  });
});

describe("replays", () => {
  for (const [a, b, seed] of [["balanced", "rusher", 3], ["greedy", "balanced", 4], ["rusher", "idle", 5]] as const) {
    it(`re-simulating ${a} vs ${b} (seed ${seed}) reproduces the final state`, async () => {
      const { state, replay } = await play(a, b, seed);
      const roundTripped = JSON.parse(JSON.stringify(replay));
      const res = verifyReplay(roundTripped);
      expect(res.ok).toBe(true);
      expect(stableStringify(simulateReplay(roundTripped))).toBe(stableStringify(state));
    });
  }

  it("seeking via snapshots matches a full re-simulation", async () => {
    const { replay } = await play("balanced", "greedy", 11);
    expect(replay.snapshots.length).toBeGreaterThan(5);
    for (const t of [0, 13, 25, 26, 99, 150, 237]) {
      const viaSnapshot = simulateReplay(replay, t);
      const r = { ...replay, snapshots: [replay.snapshots[0]!] };
      expect(hashState(viaSnapshot)).toBe(hashState(simulateReplay(r, t)));
      expect(viaSnapshot.tick).toBe(t);
    }
  });
});

describe("bot failures (in-process runner)", () => {
  const throwing: BotController = { name: "thrower", turn: () => { throw new Error("boom"); } };
  const erroring: BotController = { name: "erroring", turn: () => ({ actions: [{ type: "spawn", unit: "worker" }], error: "timeout" }) };

  it("10 consecutive failures → forfeit, and the replay still verifies", async () => {
    const { state, replay } = await runMatch([await bot("idle", "f1"), throwing], { seed: 1 });
    expect(state.result).toMatchObject({ winner: 1, reason: "forfeit" });
    expect(state.tick).toBe(10);
    expect(replay.ticks[0]!.runnerEvents?.[0]).toMatchObject({ type: "bot_error", player: 2 });
    expect(verifyReplay(JSON.parse(JSON.stringify(replay))).ok).toBe(true);
  });

  it("a failed tick's actions are ignored", async () => {
    const { replay } = await runMatch([erroring, await bot("idle", "f2")], { seed: 1 });
    expect(replay.ticks.flatMap((t) => t.events).some((e) => e.type === "spawn")).toBe(false);
  });
});

describe("sample bot sanity", () => {
  it("the BOT_API.md example is bots/starter.js verbatim and beats idle", async () => {
    const fs = await import("node:fs");
    const doc = fs.readFileSync(path.join(BOTS, "../BOT_API.md"), "utf8");
    const code = /## Minimal working bot \(no imports\)\n\n```js\n([\s\S]*?)```/.exec(doc)![1]!;
    expect(fs.readFileSync(path.join(BOTS, "starter.js"), "utf8")).toContain(code);
    const { state, replay } = await play("starter", "idle", 3);
    expect(state.result!.winner).toBe(1);
    expect(replay.ticks.flatMap((t) => t.events).filter((e) => e.type === "invalid_action")).toHaveLength(0);
  });

  it("balanced beats idle on several seeds", async () => {
    for (const seed of [1, 2, 3, 4]) {
      const { state } = await play("balanced", "idle", seed);
      expect(state.result!.winner).toBe(1);
    }
  });
});

// ---------------------------------------------------------------- symmetry helpers

/** Bot whose every decision is computed in its own canonical frame (base at top-left), so P1 and P2 play identically. */
function symmetricBot(): BotController {
  return {
    name: "sym",
    turn(view: BotState) {
      const N = view.mapSize - 1;
      const flip = view.player === 2;
      const c = (p: { x: number; y: number }) => (flip ? { x: N - p.x, y: N - p.y } : { x: p.x, y: p.y });
      const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      const base = view.myBase;
      const nodes = view.visibleNodes
        .filter((n) => n.type === "energy" && n.amount >= 5)
        .sort((a, b) => cheb(a, base) - cheb(b, base) || c(a).y - c(b).y || c(a).x - c(b).x);
      const actions: unknown[] = [];
      const workers = view.myUnits.filter((u) => u.type === "worker");
      if (workers.length < 10 && view.energy >= 50) actions.push({ type: "spawn", unit: view.tick % 7 === 3 ? "scout" : "worker" });
      workers.forEach((u, k) => {
        const node = nodes[k % Math.max(1, nodes.length)];
        const carried = u.cargo.energy + u.cargo.crystal;
        if (carried >= u.cargoCapacity || (carried > 0 && !node)) {
          actions.push(cheb(u, base) === 1 ? { type: "deposit", unitId: u.id } : { type: "moveTo", unitId: u.id, x: base.x, y: base.y });
        } else if (node) {
          actions.push(cheb(u, node) === 1 ? { type: "harvest", unitId: u.id, nodeId: node.id } : { type: "moveTo", unitId: u.id, x: node.x, y: node.y });
        }
      });
      for (const u of view.myUnits.filter((u) => u.type === "scout")) {
        const t = c({ x: 19, y: 19 });
        actions.push({ type: "moveTo", unitId: u.id, x: t.x, y: t.y });
      }
      return { actions };
    },
  };
}

function isPointSymmetric(s: GameState): boolean {
  const N = s.map.size - 1;
  if (s.players[0].energy !== s.players[1].energy || s.players[0].crystal !== s.players[1].crystal) return false;
  if (s.bases[0].hp !== s.bases[1].hp) return false;
  const key = (u: GameState["units"][number], mirror: boolean) =>
    `${u.type}:${mirror ? N - u.x : u.x},${mirror ? N - u.y : u.y}:${u.hp}:${u.cargo.energy}:${u.cargo.crystal}`;
  const a = s.units.filter((u) => u.owner === 1).map((u) => key(u, false)).sort();
  const b = s.units.filter((u) => u.owner === 2).map((u) => key(u, true)).sort();
  if (a.join("|") !== b.join("|")) return false;
  const byPos = new Map(s.nodes.map((n) => [`${n.x},${n.y}`, n.amount]));
  return s.nodes.every((n) => byPos.get(`${N - n.x},${N - n.y}`) === n.amount);
}
