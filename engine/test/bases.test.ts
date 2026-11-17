import { describe, expect, it } from "vitest";
import {
  ADJ8, buildBotView, cloneState, computeScore, computeVisibility, CONFIG, createInitialState,
  occupancy, ReplayRecorder, step, verifyReplay,
} from "../src/index.js";
import type { Base, GameState, PlayerId } from "../src/types.js";
import { canAfford, enemyBasePos, freeNeighbors, pathTo } from "../../bots/lib/helpers.js";
import { addNode, addUnit, testState, unit } from "./util.js";

function addBase(s: GameState, owner: PlayerId, x: number, y: number, hp: number = CONFIG.base.hp): Base {
  const base = { id: s.nextId++, owner, x, y, hp };
  s.bases.push(base);
  return base;
}

describe("additional bases", () => {
  it.each([
    { energy: 99, crystal: 50, ok: false },
    { energy: 100, crystal: 49, ok: false },
    { energy: 100, crystal: 0, ok: false },
    { energy: 100, crystal: 50, ok: true },
  ])("building a base requires 100 energy + 50 crystals ($energy E, $crystal C available)", ({ energy, crystal, ok }) => {
    const s = testState();
    s.players[0].energy = energy;
    s.players[0].crystal = crystal;
    const worker = addUnit(s, 1, "worker", 20, 20);
    const before = JSON.stringify(s);
    const { state, events } = step(s, [
      { type: "build", unitId: worker.id, structure: "base", x: 21, y: 20 },
    ], []);
    expect(state.bases).toHaveLength(ok ? 3 : 2);
    expect(state.players[0].energy).toBe(ok ? energy - 100 : energy);
    expect(state.players[0].crystal).toBe(ok ? crystal - 50 : crystal);
    expect(state.structures).toHaveLength(0);
    expect(JSON.stringify(s)).toBe(before);
    expect(canAfford(buildBotView(s, 1), "base")).toBe(ok);
    if (ok) {
      expect(state.bases[2]).toMatchObject({ owner: 1, x: 21, y: 20, hp: 200 });
      expect(events).toContainEqual(expect.objectContaining({ type: "build", structure: "base" }));
    } else {
      expect(events).toContainEqual(expect.objectContaining({ type: "invalid_action", reason: "not enough resources" }));
    }
  });

  it("deducts both energy and crystals when a base is built", () => {
    const s = testState();
    const worker = addUnit(s, 1, "worker", 20, 20);
    const { state } = step(s, [
      { type: "build", unitId: worker.id, structure: "base", x: 21, y: 20 },
    ], []);
    expect(state.bases).toHaveLength(3);
    expect(state.players[0]).toMatchObject({ energy: 900, crystal: 950 });
  });

  it("rejects non-workers, distant sites, occupied sites, and terrain walls", () => {
    const s = testState({ walls: [[21, 20]] });
    const worker = addUnit(s, 1, "worker", 20, 20);
    const scout = addUnit(s, 1, "scout", 10, 10);
    for (const action of [
      { type: "build", unitId: scout.id, structure: "base", x: 11, y: 10 },
      { type: "build", unitId: worker.id, structure: "base", x: 23, y: 20 },
      { type: "build", unitId: worker.id, structure: "base", x: 21, y: 20 },
      { type: "build", unitId: worker.id, structure: "base", x: 20, y: 20 },
    ]) {
      const { state, events } = step(s, [action], []);
      expect(state.bases).toHaveLength(2);
      expect(state.players[0].energy).toBe(1000);
      expect(events.some((e) => e.type === "invalid_action")).toBe(true);
    }
  });

  it("both players building a base on the same tile both fail without payment", () => {
    const s = testState();
    const a = addUnit(s, 1, "worker", 19, 20);
    const b = addUnit(s, 2, "worker", 21, 20);
    const { state, events } = step(s, [
      { type: "build", unitId: a.id, structure: "base", x: 20, y: 20 },
    ], [{ type: "build", unitId: b.id, structure: "base", x: 20, y: 20 }]);
    expect(state.bases).toHaveLength(2);
    expect(state.players.map((p) => [p.energy, p.crystal])).toEqual([[1000, 1000], [1000, 1000]]);
    expect(events.filter((e) => e.type === "invalid_action")).toHaveLength(2);
  });

  it("deposits energy and crystal at an expansion into the shared balance", () => {
    const s = testState();
    addBase(s, 1, 20, 20);
    const worker = addUnit(s, 1, "worker", 19, 20, { cargo: { energy: 12, crystal: 8 } });
    const { state } = step(s, [{ type: "deposit", unitId: worker.id }], []);
    expect(state.players[0]).toMatchObject({ energy: 1012, crystal: 1008 });
    expect(unit(state, worker.id)!.cargo).toEqual({ energy: 0, crystal: 0 });
  });

  it("harvests a nearby node and then deposits at an expansion", () => {
    const s = testState();
    addBase(s, 1, 20, 20);
    const node = addNode(s, "energy", 18, 20);
    const worker = addUnit(s, 1, "worker", 19, 20);
    const harvested = step(s, [{ type: "harvest", unitId: worker.id, nodeId: node.id }], []).state;
    const deposited = step(harvested, [{ type: "deposit", unitId: worker.id }], []).state;
    expect(deposited.players[0].energy).toBe(1005);
    expect(unit(deposited, worker.id)!.cargo.energy).toBe(0);
  });

  it.each([0, 200])("cannot deposit at an enemy base with %i HP", (hp) => {
    const s = testState();
    addBase(s, 2, 20, 20, hp);
    const worker = addUnit(s, 1, "worker", 19, 20, { cargo: { energy: 20, crystal: 0 } });
    const { state, events } = step(s, [{ type: "deposit", unitId: worker.id }], []);
    expect(unit(state, worker.id)!.cargo.energy).toBe(20);
    expect(events).toContainEqual(expect.objectContaining({ reason: "not adjacent to base" }));
  });

  it("cannot deposit at a destroyed friendly expansion", () => {
    const s = testState();
    addBase(s, 1, 20, 20, 0);
    const worker = addUnit(s, 1, "worker", 19, 20, { cargo: { energy: 20, crystal: 0 } });
    const { state } = step(s, [{ type: "deposit", unitId: worker.id }], []);
    expect(unit(state, worker.id)!.cargo.energy).toBe(20);
  });

  it.each([8, 9])("turret placement uses distance %i from a living friendly expansion", (distance) => {
    const s = testState();
    addBase(s, 1, 20, 20);
    const worker = addUnit(s, 1, "worker", 20 + distance, 19);
    const { state } = step(s, [
      { type: "build", unitId: worker.id, structure: "turret", x: 20 + distance, y: 20 },
    ], []);
    expect(state.structures).toHaveLength(distance === 8 ? 1 : 0);
  });

  it("enemy and destroyed friendly bases do not support turret construction", () => {
    const s = testState();
    addBase(s, 2, 20, 20);
    addBase(s, 1, 25, 20, 0);
    const worker = addUnit(s, 1, "worker", 23, 20);
    const { state } = step(s, [
      { type: "build", unitId: worker.id, structure: "turret", x: 23, y: 21 },
    ], []);
    expect(state.structures).toHaveLength(0);
  });

  it("spawns at a selected expansion with the same one-spawn-per-player limit", () => {
    const s = testState();
    const base = addBase(s, 1, 20, 20);
    const { state, events } = step(s, [
      { type: "spawn", unit: "worker", baseId: base.id },
      { type: "spawn", unit: "scout", baseId: 1 },
    ], []);
    expect(state.units).toHaveLength(1);
    expect(state.units[0]).toMatchObject({ owner: 1, x: 21, y: 21 });
    expect(events).toContainEqual(expect.objectContaining({ reason: "only one spawn per tick" }));
  });

  it("a newly built base supports deposits and turret construction starting next tick", () => {
    const s = testState();
    const builder = addUnit(s, 1, "worker", 19, 20);
    const depositor = addUnit(s, 1, "worker", 21, 20, { cargo: { energy: 20, crystal: 0 } });
    const turretBuilder = addUnit(s, 1, "worker", 22, 21);
    const buildTurret = { type: "build", unitId: turretBuilder.id, structure: "turret", x: 21, y: 21 };
    const deposit = { type: "deposit", unitId: depositor.id };
    const first = step(s, [
      { type: "build", unitId: builder.id, structure: "base", x: 20, y: 20 },
      deposit, buildTurret,
    ], []).state;
    expect(first.bases).toHaveLength(3);
    expect(first.structures).toHaveLength(0);
    expect(unit(first, depositor.id)!.cargo.energy).toBe(20);
    const second = step(first, [deposit, buildTurret], []).state;
    expect(unit(second, depositor.id)!.cargo.energy).toBe(0);
    expect(second.structures).toHaveLength(1);
    expect(second.players[0].energy).toBe(820);
    expect(second.players[0].crystal).toBe(950);
  });

  it("resources deposited this tick can pay for building an additional base", () => {
    const s = testState();
    s.players[0].energy = 80;
    s.players[0].crystal = 30;
    const depositor = addUnit(s, 1, "worker", 5, 4, { cargo: { energy: 20, crystal: 20 } });
    const builder = addUnit(s, 1, "worker", 20, 20);
    const { state } = step(s, [
      { type: "build", unitId: builder.id, structure: "base", x: 21, y: 20 },
      { type: "deposit", unitId: depositor.id },
    ], []);
    expect(state.bases).toHaveLength(3);
    expect(state.players[0].energy).toBe(0);
    expect(state.players[0].crystal).toBe(0);
  });

  it.each(["enemy", "destroyed", "missing"])("rejects spawning at a %s base", (kind) => {
    const s = testState();
    const base = addBase(s, kind === "enemy" ? 2 : 1, 20, 20, kind === "destroyed" ? 0 : 200);
    const { state, events } = step(s, [
      { type: "spawn", unit: "worker", baseId: kind === "missing" ? -1 : base.id },
    ], []);
    expect(state.units).toHaveLength(0);
    expect(state.players[0].energy).toBe(1000);
    expect(events).toContainEqual(expect.objectContaining({ reason: "no such living base (or not yours)" }));
  });

  it("default spawning falls back to an expansion when the starting base is surrounded", () => {
    const s = testState();
    addBase(s, 1, 20, 20);
    for (const d of ADJ8) addUnit(s, 1, "worker", 4 + d.x, 4 + d.y);
    const { state } = step(s, [{ type: "spawn", unit: "scout" }], []);
    expect(state.units.find((u) => u.type === "scout")).toMatchObject({ x: 21, y: 21 });
  });

  it("adds expansion vision and reports all visible living enemy bases", () => {
    const s = testState();
    const mine = addBase(s, 1, 20, 20);
    const enemy = addBase(s, 2, 26, 20);
    addBase(s, 2, 27, 20, 0);
    addBase(s, 2, 28, 20);
    expect(computeVisibility(s, 1)[20 * 40 + 27]).toBe(1);
    expect(computeVisibility(s, 1)[20 * 40 + 28]).toBe(0);
    const view = buildBotView(s, 1);
    expect(view.myBases.map((b) => b.id)).toEqual([1, mine.id]);
    expect(view.myStructures).toHaveLength(0);
    expect(view.visibleEnemies.filter((e) => e.kind === "base").map((b) => b.id)).toEqual([enemy.id]);
    const cloned = cloneState(s);
    cloned.bases[2].hp = 0;
    expect(mine.hp).toBe(200);
  });

  it("losing the starting base keeps the player alive with vision and spawning at the expansion", () => {
    const s = testState();
    const base = addBase(s, 1, 20, 20);
    s.bases[0].hp = 6;
    const enemy = addUnit(s, 2, "fighter", 5, 5);
    const { state, events } = step(s, [], [{ type: "attack", unitId: enemy.id, targetId: 1 }]);
    expect(state.result).toBeNull();
    expect(events.filter((e) => e.type === "base_destroyed")).toEqual([{ type: "base_destroyed", player: 1, baseId: 1 }]);
    const view = buildBotView(state, 1);
    expect(view.myBase.id).toBe(base.id);
    expect(view.myBases.map((b) => b.id)).toEqual([base.id]);
    expect(enemyBasePos(view)).toEqual({ x: 35, y: 35 });
    expect(computeVisibility(state, 1)[4 * 40 + 4]).toBe(0);
    expect(occupancy(state)[4 * 40 + 4]).toBe(0);
    const next = step(state, [{ type: "spawn", unit: "worker" }], []);
    expect(next.state.units.find((u) => u.owner === 1)).toMatchObject({ x: 21, y: 21 });
    expect(next.events.filter((e) => e.type === "base_destroyed")).toHaveLength(0);
    const lost = cloneState(state);
    lost.bases.find((b) => b.id === base.id)!.hp = 6;
    const attacker = addUnit(lost, 2, "fighter", 21, 20);
    const final = step(lost, [], [{ type: "attack", unitId: attacker.id, targetId: base.id }]).state;
    expect(final.result).toMatchObject({ winner: 2, reason: "base_destroyed" });
    expect(buildBotView(final, 1).myBases).toHaveLength(0);
  });

  it("building an expansion saves a player when its starting base is destroyed that tick", () => {
    const s = testState();
    s.bases[0].hp = 6;
    const worker = addUnit(s, 1, "worker", 20, 20);
    const enemy = addUnit(s, 2, "fighter", 5, 5);
    const { state } = step(s, [
      { type: "build", unitId: worker.id, structure: "base", x: 21, y: 20 },
    ], [{ type: "attack", unitId: enemy.id, targetId: 1 }]);
    expect(state.result).toBeNull();
    expect(buildBotView(state, 1).myBase).toMatchObject({ x: 21, y: 20, hp: 200 });
  });

  it("expansion bases can be attacked on their build tick", () => {
    const s = testState();
    const worker = addUnit(s, 1, "worker", 20, 20);
    const enemy = addUnit(s, 2, "fighter", 22, 20);
    const { state } = step(s, [
      { type: "build", unitId: worker.id, structure: "base", x: 21, y: 20 },
    ], [{ type: "attack", unitId: enemy.id, targetId: s.nextId }]);
    expect(state.bases[2].hp).toBe(194);
  });

  it("both players losing all bases on the same tick uses the existing tiebreaker", () => {
    const s = testState();
    s.bases.forEach((b) => { b.hp = 0; });
    const a = addBase(s, 1, 15, 15, 6);
    const b = addBase(s, 2, 25, 25, 6);
    const f1 = addUnit(s, 1, "fighter", 24, 25);
    const f2 = addUnit(s, 2, "fighter", 16, 15);
    const { state } = step(s, [{ type: "attack", unitId: f1.id, targetId: b.id }],
      [{ type: "attack", unitId: f2.id, targetId: a.id }]);
    expect(state.result).toMatchObject({ winner: "draw", reason: "score", units: [1, 1] });
  });

  it("surviving turrets keep firing after their supporting base is destroyed", () => {
    const s = testState();
    const base = addBase(s, 1, 20, 20, 6);
    s.structures.push({ upgraded: false, id: s.nextId++, owner: 1, type: "turret", x: 19, y: 20, hp: 50 });
    const enemy = addUnit(s, 2, "fighter", 21, 20);
    const dead = step(s, [], [{ type: "attack", unitId: enemy.id, targetId: base.id }]).state;
    const next = step(dead, [], []).state;
    expect(unit(next, enemy.id)!.hp).toBe(22);
    expect(next.structures).toHaveLength(1);
  });

  it("scores all surviving base HP and keeps additional bases immune to the zone", () => {
    const s = testState({ tick: 499 });
    addBase(s, 1, 1, 1, 150);
    addBase(s, 1, 10, 10, 0);
    expect(computeScore(s, 1)).toBe(1000 + 3000 + 2 * 350);
    const { state } = step(s, [], []);
    expect(state.bases.map((b) => b.hp)).toEqual([200, 200, 150, 0]);
    expect(state.result).toMatchObject({ winner: 1, reason: "score", units: [0, 0] });
  });

  it("movement and bot pathfinding treat living expansions as blocked tiles", () => {
    const s = testState();
    const base = addBase(s, 1, 20, 20);
    const worker = addUnit(s, 1, "worker", 19, 20);
    const view = buildBotView(s, 1);
    expect(pathTo(view, worker, { x: 21, y: 20 }).some((p) => p.x === 20 && p.y === 20)).toBe(false);
    expect(freeNeighbors(view, worker).some((p) => p.x === 20 && p.y === 20)).toBe(false);
    const blocked = step(s, [{ type: "move", unitId: worker.id, dir: "E" }], []).state;
    expect(unit(blocked, worker.id)!.x).toBe(19);
    base.hp = 0;
    const moved = step(s, [{ type: "move", unitId: worker.id, dir: "E" }], []).state;
    expect(unit(moved, worker.id)!.x).toBe(20);
  });

  it("permits rebuilding on a destroyed base tile", () => {
    const s = testState();
    addBase(s, 1, 20, 20, 0);
    const worker = addUnit(s, 1, "worker", 19, 20);
    const { state } = step(s, [
      { type: "build", unitId: worker.id, structure: "base", x: 20, y: 20 },
    ], []);
    expect(state.bases.filter((b) => b.x === 20 && b.y === 20 && b.hp > 0)).toHaveLength(1);
  });

  it("replay verification reproduces base construction and selected-base spawning", () => {
    const { startEnergy, startCrystal } = CONFIG.match;
    CONFIG.match.startEnergy = CONFIG.base.costEnergy + CONFIG.units.worker.costEnergy;
    CONFIG.match.startCrystal = CONFIG.base.costCrystal;
    try {
    let s = createInitialState(42);
    const recorder = new ReplayRecorder(42, ["builder", "idle"], s);
    const worker = s.units.find((u) => u.owner === 1)!;
    const occ = occupancy(s);
    const d = ADJ8.find((d) => !occ[(worker.y + d.y) * 40 + worker.x + d.x])!;
    const build = [{ type: "build", unitId: worker.id, structure: "base", x: worker.x + d.x, y: worker.y + d.y }];
    const first = step(s, build, []);
    recorder.record(s, [build, []], first.events);
    s = first.state;
    const spawn = [{ type: "spawn", unit: "worker", baseId: s.bases[2].id }];
    const second = step(s, spawn, []);
    recorder.record(s, [spawn, []], second.events);
    expect(verifyReplay(recorder.finish(second.state)).ok).toBe(true);
    } finally {
      CONFIG.match.startEnergy = startEnergy;
      CONFIG.match.startCrystal = startCrystal;
    }
  });
});
