import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config.js";
import { matrixTotal, MatchStatsTracker, step, type GameEvent, type GameState } from "../src/index.js";
import { addUnit, testState } from "./util.js";

/** Tracker over a test state with known entities: P1 fighters 100/101, P1 turret 102, P2 workers 200/201, P2 scout 202. */
function arena(): { s: GameState; tracker: MatchStatsTracker } {
  const s = testState();
  s.units.push(
    { id: 100, owner: 1, type: "fighter", x: 10, y: 10, hp: 30, cargo: { energy: 0, crystal: 0 }, upgraded: false },
    { id: 101, owner: 1, type: "fighter", x: 12, y: 10, hp: 30, cargo: { energy: 0, crystal: 0 }, upgraded: false },
    { id: 200, owner: 2, type: "worker", x: 11, y: 10, hp: 10, cargo: { energy: 0, crystal: 0 }, upgraded: false },
    { id: 201, owner: 2, type: "worker", x: 11, y: 11, hp: 10, cargo: { energy: 0, crystal: 0 }, upgraded: false },
    { id: 202, owner: 2, type: "scout", x: 11, y: 12, hp: 5, cargo: { energy: 0, crystal: 0 }, upgraded: false },
  );
  s.structures.push({ id: 102, owner: 1, type: "turret", x: 9, y: 9, hp: 50, upgraded: false });
  return { s, tracker: new MatchStatsTracker(s) };
}

const death = (id: number, owner: 1 | 2, kind: "unit" | "structure" | "base" = "unit"): GameEvent => ({ type: "death", id, kind, owner, x: 0, y: 0 });
const attack = (attackerId: number, targetId: number, damage: number): GameEvent => ({ type: "attack", attackerId, targetId, damage });

describe("kill attribution", () => {
  it("credits the attacker that dealt the most damage that tick", () => {
    const { tracker } = arena();
    tracker.add(5, [attack(102, 200, 4), attack(100, 200, 6), death(200, 2)]);
    const st = tracker.snapshot();
    expect(st.players[0].kills).toEqual({ worker: { fighter: 1 } });
    expect(st.players[1].losses).toEqual({ worker: { fighter: 1 } });
    expect(st.players[0].firstKillTick).toBe(5);
    expect(st.firstDeathTick).toBe(5);
  });

  it("breaks damage ties by event order (first attacker wins)", () => {
    const { tracker } = arena();
    tracker.add(0, [attack(102, 200, 6), attack(100, 200, 6), death(200, 2)]);
    expect(tracker.snapshot().players[0].kills).toEqual({ worker: { turret: 1 } });
  });

  it("sums several hits by the same attacker within a tick", () => {
    const { tracker } = arena();
    tracker.add(0, [attack(100, 202, 3), attack(102, 202, 4), attack(100, 202, 3), death(202, 2)]);
    expect(tracker.snapshot().players[0].kills).toEqual({ scout: { fighter: 1 } });
  });

  it("damage from earlier ticks earns no kill credit", () => {
    const { tracker } = arena();
    tracker.add(0, [attack(100, 200, 6)]);
    tracker.add(1, [attack(102, 200, 4), death(200, 2)]);
    const st = tracker.snapshot();
    expect(st.players[0].kills).toEqual({ worker: { turret: 1 } });
    expect(st.players[0].damageDealt).toEqual({ fighter: 6, turret: 4 });
  });

  it("zone damage before the death is the killing blow, even after combat hits", () => {
    const { tracker } = arena();
    tracker.add(420, [attack(100, 201, 6), { type: "zone_damage", targetId: 201, damage: 3 }, death(201, 2)]);
    const st = tracker.snapshot();
    expect(st.players[0].kills).toEqual({});
    expect(st.players[1].losses).toEqual({ worker: { zone: 1 } });
    expect(st.players[1].damageTaken).toEqual({ fighter: 6, zone: 3 });
    expect(st.players[0].firstKillTick).toBeNull();
  });

  it("a death with no recorded damage is 'unknown'", () => {
    const { tracker } = arena();
    tracker.add(0, [death(200, 2)]);
    expect(tracker.snapshot().players[1].losses).toEqual({ worker: { unknown: 1 } });
  });

  it("kills of structures and bases, by victim type", () => {
    const { tracker } = arena();
    tracker.add(0, [attack(202, 102, 50), death(102, 1, "structure")]);
    tracker.add(1, [attack(202, 1, 200), { type: "base_destroyed", player: 1, baseId: 1 }, death(1, 1, "base")]);
    const st = tracker.snapshot();
    expect(st.players[1].kills).toEqual({ turret: { scout: 1 }, base: { scout: 1 } });
    expect(st.players[0].losses).toEqual({ turret: { scout: 1 }, base: { scout: 1 } });
    expect(st.players[1].damageDealtTo).toEqual({ turret: 50, base: 200 });
    expect(matrixTotal(st.players[1].kills, ["base"])).toBe(1);
    expect(matrixTotal(st.players[1].kills)).toBe(2);
  });

  it("entities spawned or built during the match are attributed by type", () => {
    const { tracker } = arena();
    tracker.add(0, [
      { type: "spawn", player: 2, unitId: 300, unit: "fighter", x: 30, y: 30 },
      { type: "build", player: 1, unitId: 100, structureId: 301, structure: "wall", x: 13, y: 13 },
    ]);
    tracker.add(1, [attack(300, 301, 6), attack(300, 100, 6), death(301, 1, "structure")]);
    const st = tracker.snapshot();
    expect(st.players[1].kills).toEqual({ wall: { fighter: 1 } });
    expect(st.players[0].damageTaken).toEqual({ fighter: 12 });
    expect(st.firstContactTick).toBe(1);
  });
});

describe("economy, errors and peaks", () => {
  it("counts spawns, builds, upgrades, spending, harvests, deposits, invalid actions and bot errors", () => {
    const { tracker } = arena();
    tracker.add(3, [
      { type: "bot_error", player: 2, message: "timeout" },
      { type: "upgrade", player: 1, upgrade: "fighter" },
      { type: "spawn", player: 1, unitId: 300, unit: "fighter", x: 5, y: 5 },
      { type: "spawn", player: 2, unitId: 301, unit: "worker", x: 34, y: 34 },
      { type: "harvest", player: 2, unitId: 200, nodeId: 7, resource: "energy", amount: 5 },
      { type: "harvest", player: 2, unitId: 201, nodeId: 8, resource: "crystal", amount: 5 },
      { type: "deposit", player: 2, unitId: 200, energy: 20, crystal: 5 },
      { type: "build", player: 1, unitId: 100, structureId: 302, structure: "turret", x: 6, y: 6 },
      { type: "invalid_action", player: 1, action: {}, reason: "cargo empty" },
      { type: "invalid_action", player: 1, action: {}, reason: "cargo empty" },
    ]);
    const [p1, p2] = tracker.snapshot().players;
    const U = CONFIG.units;
    expect(p1.spawned).toEqual({ fighter: 1 });
    expect(p1.built).toEqual({ turret: 1 });
    expect(p1.upgrades).toEqual([{ upgrade: "fighter", tick: 3 }]);
    expect(p1.spent).toEqual({
      energy: U.fighter.costEnergy + CONFIG.structures.turret.costEnergy + CONFIG.upgrades.fighter.costEnergy,
      crystal: U.fighter.costCrystal + CONFIG.structures.turret.costCrystal + CONFIG.upgrades.fighter.costCrystal,
    });
    expect(p1.invalidActions).toBe(2);
    expect(p1.invalidReasons).toEqual({ "cargo empty": 2 });
    expect(p2.spent).toEqual({ energy: U.worker.costEnergy, crystal: U.worker.costCrystal });
    expect(p2.harvested).toEqual({ energy: 5, crystal: 5 });
    expect(p2.deposited).toEqual({ energy: 20, crystal: 5 });
    expect(p2.botErrors).toBe(1);
    expect(p1.peakUnits).toBe(3);
    expect(p1.peakArmy).toBe(3);
    expect(p2.peakUnits).toBe(4);
    expect(p2.peakArmy).toBe(1); // only the scout; workers deal no damage
  });

  it("peaks keep their maximum after units die", () => {
    const { tracker } = arena();
    tracker.add(0, [attack(100, 200, 10), attack(101, 201, 10), death(200, 2), death(201, 2)]);
    const st = tracker.snapshot();
    expect(st.players[1].peakUnits).toBe(3);
    expect(st.ticks).toBe(1);
  });

  it("snapshots are independent copies", () => {
    const { tracker } = arena();
    const before = tracker.snapshot();
    tracker.add(0, [{ type: "spawn", player: 1, unitId: 300, unit: "worker", x: 5, y: 5 }]);
    expect(before.players[0].spawned).toEqual({});
    expect(tracker.snapshot().players[0].spawned).toEqual({ worker: 1 });
  });
});

describe("with real engine steps", () => {
  it("attributes a kill from step() events: two fighters vs one scout, turret vs worker", () => {
    const s = testState();
    const f1 = addUnit(s, 1, "fighter", 10, 10);
    const sc = addUnit(s, 2, "scout", 11, 10);
    const f2 = addUnit(s, 1, "fighter", 12, 10);
    s.structures.push({ id: s.nextId++, owner: 2, type: "turret", x: 30, y: 30, hp: 50, upgraded: false });
    const w = addUnit(s, 1, "worker", 31, 30);
    const tracker = new MatchStatsTracker(s);
    const { events } = step(s, [{ type: "attack", unitId: f1.id, targetId: sc.id }, { type: "attack", unitId: f2.id, targetId: sc.id }], []);
    tracker.add(0, events);
    const st = tracker.snapshot();
    expect(st.players[0].kills).toEqual({ scout: { fighter: 1 } });
    expect(st.players[1].losses).toEqual({ scout: { fighter: 1 } });
    expect(st.players[0].damageDealt).toEqual({ fighter: 2 * CONFIG.units.fighter.damage });
    expect(st.players[1].damageDealt).toEqual({ turret: CONFIG.structures.turret.damage });
    expect(st.players[0].damageTaken).toEqual({ turret: CONFIG.structures.turret.damage });
    expect(w.hp).toBe(CONFIG.units.worker.hp); // input state untouched
  });

  it("zone kills come from step() too", () => {
    const s = testState({ tick: 499 });
    addUnit(s, 1, "scout", 0, 0, { hp: 1 });
    const tracker = new MatchStatsTracker(s);
    const { events } = step(s, [], []);
    tracker.add(499, events);
    expect(tracker.snapshot().players[0].losses).toEqual({ scout: { zone: 1 } });
  });
});
