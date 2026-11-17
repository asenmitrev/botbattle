import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG,
  countTotal,
  matchStats,
  matrixTotal,
  MatchStatsTracker,
  runMatch,
  STRUCTURE_TYPES,
  UNIT_TYPES,
  type GameEvent,
  type GameState,
  type PlayerMatchStats,
  type MatchStats,
  type PlayerId,
  type Replay,
} from "@arena/engine";
import { loadLocalBot } from "../src/local-bot.js";

const BOTS = path.resolve(__dirname, "../../bots");
const bot = (name: string, tag: string) => loadLocalBot(path.join(BOTS, `${name}.js`), tag);

async function play(a: string, b: string, seed: number) {
  return runMatch([await bot(a, `${a}-ms-${seed}-1-${Math.random()}`), await bot(b, `${b}-ms-${seed}-2-${Math.random()}`)], { seed });
}

const allEvents = (r: Replay): GameEvent[] => r.ticks.flatMap((t) => [...(t.runnerEvents ?? []), ...t.events]);

/** Invariants that tie the stats to the replay's events and final state. */
function checkConsistency(replay: Replay, st: MatchStats, state: GameState): void {
  const ev = allEvents(replay);
  expect(st.ticks).toBe(replay.ticks.length);
  for (const p of [1, 2] as PlayerId[]) {
    const me = st.players[p - 1]!;
    const them = st.players[2 - p]!;
    // Every death is classified, and one side's kills are the other's non-zone losses.
    expect(matrixTotal(me.losses)).toBe(ev.filter((e) => e.type === "death" && e.owner === p).length);
    expect(Object.values(me.losses).some((row) => row?.unknown)).toBe(false);
    const zoneLosses = Object.values(me.losses).reduce((n, row) => n + (row?.zone ?? 0), 0);
    expect(matrixTotal(them.kills)).toBe(matrixTotal(me.losses) - zoneLosses);
    // Damage: what one side dealt is what the other took from non-zone sources.
    const takenFromEnemy = countTotal(me.damageTaken) - (me.damageTaken.zone ?? 0);
    expect(countTotal(them.damageDealt)).toBe(takenFromEnemy);
    expect(countTotal(them.damageDealtTo)).toBe(takenFromEnemy);
    // Counts match the raw events.
    expect(countTotal(me.spawned)).toBe(ev.filter((e) => e.type === "spawn" && e.player === p).length);
    expect(countTotal(me.built)).toBe(ev.filter((e) => e.type === "build" && e.player === p).length);
    expect(me.invalidActions).toBe(ev.filter((e) => e.type === "invalid_action" && e.player === p).length);
    expect(me.botErrors).toBe(ev.filter((e) => e.type === "bot_error" && e.player === p).length);
    expect(me.upgrades.map((u) => u.upgrade)).toEqual(state.players[p - 1]!.upgrades);
    // Economy: banked = start + deposited - spent; you can't deposit more than you harvested.
    expect(state.players[p - 1]!.energy).toBe(CONFIG.match.startEnergy + me.deposited.energy - me.spent.energy);
    expect(state.players[p - 1]!.crystal).toBe(CONFIG.match.startCrystal + me.deposited.crystal - me.spent.crystal);
    expect(me.harvested.energy).toBeGreaterThanOrEqual(me.deposited.energy);
    expect(me.harvested.crystal).toBeGreaterThanOrEqual(me.deposited.crystal);
    checkFinal(state, p, me);
  }
}

/** Living units/structures at the end = start + made - lost, per type. */
function checkFinal(state: GameState, p: PlayerId, me: PlayerMatchStats): void {
  for (const type of UNIT_TYPES) {
    const start = type === "worker" ? CONFIG.match.startWorkers : 0;
    const alive = state.units.filter((u) => u.owner === p && u.type === type).length;
    expect(alive, `P${p} ${type}s`).toBe(start + (me.spawned[type] ?? 0) - countTotal(me.losses[type]));
    expect(me.peakUnits).toBeGreaterThanOrEqual(alive);
  }
  for (const type of STRUCTURE_TYPES) {
    const alive = state.structures.filter((s) => s.owner === p && s.type === type).length;
    expect(alive, `P${p} ${type}s`).toBe((me.built[type] ?? 0) - countTotal(me.losses[type]));
  }
}

describe("match stats on real matches", () => {
  for (const [a, b, seed] of [["balanced", "rusher", 3], ["aggressor", "greedy", 7], ["rusher", "idle", 5], ["balanced", "balanced", 12]] as const) {
    it(`${a} vs ${b} (seed ${seed}) stats agree with the events and the final state`, async () => {
      const { state, replay } = await play(a, b, seed);
      const st = matchStats(JSON.parse(JSON.stringify(replay)));
      checkConsistency(replay, st, state);
      if (a === "rusher" && b === "idle") {
        // A rush that wins by killing the base: the base kill is credited to the rusher.
        expect(state.result!.reason).toBe("base_destroyed");
        expect(matrixTotal(st.players[0].kills, ["base"])).toBeGreaterThanOrEqual(1);
        expect(st.players[1].losses.base).toBeDefined();
        expect(st.firstContactTick).not.toBeNull();
      }
    });
  }

  it("the tracker fed tick by tick matches matchStats() at every prefix", async () => {
    const { replay } = await play("balanced", "rusher", 4);
    const tracker = new MatchStatsTracker(replay.snapshots[0]!.state);
    replay.ticks.forEach((rec, i) => {
      if (i % 37 === 0) expect(tracker.snapshot()).toEqual(matchStats(replay, i));
      tracker.add(rec.tick, [...(rec.runnerEvents ?? []), ...rec.events]);
    });
    expect(tracker.snapshot()).toEqual(matchStats(replay));
  });

  it("counts bot errors from runner events", async () => {
    const thrower = { name: "thrower", turn: () => { throw new Error("boom"); } };
    const { replay } = await runMatch([await bot("idle", "ms-f1"), thrower], { seed: 1 });
    const st = matchStats(replay);
    expect(st.players[1].botErrors).toBe(CONFIG.bot.maxConsecutiveFailures);
    expect(st.players[0].botErrors).toBe(0);
  });
});
