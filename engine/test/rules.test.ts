import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config.js";
import { buildBotView, computeScore, CpuBudget, step, zoneRadius } from "../src/index.js";
import type { GameEvent } from "../src/types.js";
import { addNode, addUnit, testState, unit } from "./util.js";

const invalid = (events: GameEvent[]) => events.filter((e) => e.type === "invalid_action");

describe("movement", () => {
  it("moves one tile per tick in the given direction", () => {
    const s = testState();
    const u = addUnit(s, 1, "worker", 10, 10);
    const { state } = step(s, [{ type: "move", unitId: u.id, dir: "E" }], []);
    expect(unit(state, u.id)).toMatchObject({ x: 11, y: 10 });
  });

  it("does not mutate the input state", () => {
    const s = testState();
    const u = addUnit(s, 1, "worker", 10, 10);
    const before = JSON.stringify(s);
    step(s, [{ type: "move", unitId: u.id, dir: "E" }], []);
    expect(JSON.stringify(s)).toBe(before);
  });

  it("is blocked by terrain walls and map edges", () => {
    const s = testState({ walls: [[11, 10]] });
    const a = addUnit(s, 1, "worker", 10, 10);
    const b = addUnit(s, 1, "worker", 0, 0);
    const { state } = step(s, [
      { type: "move", unitId: a.id, dir: "E" },
      { type: "move", unitId: b.id, dir: "N" },
    ], []);
    expect(unit(state, a.id)).toMatchObject({ x: 10, y: 10 });
    expect(unit(state, b.id)).toMatchObject({ x: 0, y: 0 });
  });

  it("two units targeting the same tile: neither moves (across players too)", () => {
    const s = testState();
    const a = addUnit(s, 1, "worker", 10, 10);
    const b = addUnit(s, 2, "worker", 12, 10);
    const { state } = step(s, [{ type: "move", unitId: a.id, dir: "E" }], [{ type: "move", unitId: b.id, dir: "W" }]);
    expect(unit(state, a.id)).toMatchObject({ x: 10, y: 10 });
    expect(unit(state, b.id)).toMatchObject({ x: 12, y: 10 });
  });

  it("swaps are blocked", () => {
    const s = testState();
    const a = addUnit(s, 1, "worker", 10, 10);
    const b = addUnit(s, 1, "worker", 11, 10);
    const { state } = step(s, [
      { type: "move", unitId: a.id, dir: "E" },
      { type: "move", unitId: b.id, dir: "W" },
    ], []);
    expect(unit(state, a.id)).toMatchObject({ x: 10, y: 10 });
    expect(unit(state, b.id)).toMatchObject({ x: 11, y: 10 });
  });

  it("rotations of 3+ units are blocked like swaps", () => {
    const s = testState();
    // (10,10)->E, (11,10)->S, (11,11)->W, (10,11)->N : a 4-cycle
    const a = addUnit(s, 1, "worker", 10, 10);
    const b = addUnit(s, 1, "worker", 11, 10);
    const c = addUnit(s, 1, "worker", 11, 11);
    const d = addUnit(s, 1, "worker", 10, 11);
    const { state } = step(s, [
      { type: "move", unitId: a.id, dir: "E" },
      { type: "move", unitId: b.id, dir: "S" },
      { type: "move", unitId: c.id, dir: "W" },
      { type: "move", unitId: d.id, dir: "N" },
    ], []);
    for (const u of [a, b, c, d]) expect(unit(state, u.id)).toMatchObject({ x: u.x, y: u.y });
  });

  it("a unit can follow into a tile being vacated in the same tick (chains)", () => {
    const s = testState();
    const a = addUnit(s, 1, "worker", 10, 10);
    const b = addUnit(s, 1, "worker", 11, 10);
    const c = addUnit(s, 1, "worker", 12, 10);
    // Order of actions must not matter.
    const { state } = step(s, [
      { type: "move", unitId: a.id, dir: "E" },
      { type: "move", unitId: b.id, dir: "E" },
      { type: "move", unitId: c.id, dir: "E" },
    ].reverse(), []);
    expect([unit(state, a.id)!.x, unit(state, b.id)!.x, unit(state, c.id)!.x]).toEqual([11, 12, 13]);
  });

  it("a chain behind a blocked unit stays put", () => {
    const s = testState({ walls: [[12, 10]] });
    const a = addUnit(s, 1, "worker", 10, 10);
    const b = addUnit(s, 1, "worker", 11, 10);
    const { state } = step(s, [
      { type: "move", unitId: a.id, dir: "E" },
      { type: "move", unitId: b.id, dir: "E" },
    ], []);
    expect(unit(state, a.id)!.x).toBe(10);
    expect(unit(state, b.id)!.x).toBe(11);
  });

  it("scouts move two tiles, step by step", () => {
    const s = testState({ walls: [[13, 10]] });
    const sc = addUnit(s, 1, "scout", 10, 10);
    const sc2 = addUnit(s, 1, "scout", 10, 20);
    const { state } = step(s, [
      { type: "move", unitId: sc.id, dir: "E" },
      { type: "move", unitId: sc2.id, dir: "E" },
    ], []);
    expect(unit(state, sc.id)).toMatchObject({ x: 12, y: 10 });
    expect(unit(state, sc2.id)).toMatchObject({ x: 12, y: 20 });
    const { state: s2 } = step(state, [{ type: "move", unitId: sc.id, dir: "E" }], []);
    expect(unit(s2, sc.id)).toMatchObject({ x: 12, y: 10 }); // wall right after
  });

  it.each(["move", "moveTo"] as const)("the scout upgrade doubles all your scouts' speed for %s on the purchase tick", (type) => {
    const s = testState();
    const scout = addUnit(s, 1, "scout", 10, 10);
    const scout2 = addUnit(s, 1, "scout", 10, 16);
    const worker = addUnit(s, 1, "worker", 10, 12);
    const fighter = addUnit(s, 1, "fighter", 10, 14);
    const enemy = addUnit(s, 2, "scout", 10, 20);
    const move = (id: number, y: number) => type === "move"
      ? { type, unitId: id, dir: "E" as const }
      : { type, unitId: id, x: 18, y };
    const { state, events } = step(s, [
      { type: "upgrade", upgrade: "scout" },
      move(scout.id, 10), move(scout2.id, 16), move(worker.id, 12), move(fighter.id, 14),
    ], [move(enemy.id, 20)]);
    expect(unit(state, scout.id)).toMatchObject({ x: 14, y: 10 });
    expect(unit(state, scout2.id)).toMatchObject({ x: 14, y: 16 });
    expect(unit(state, worker.id)!.x).toBe(11);
    expect(unit(state, fighter.id)!.x).toBe(11);
    expect(unit(state, enemy.id)!.x).toBe(12);
    expect(invalid(events)).toHaveLength(0);
    expect(buildBotView(state, 1).myUnits.find((u) => u.id === scout.id)).toMatchObject({ upgraded: true, hp: 10, maxHp: 10 });
    expect(buildBotView(state, 2).myUnits[0]!.upgraded).toBe(false);
    expect(buildBotView(state, 1).myUpgrades).toEqual({ scout: true, wall: false, fighter: false });
    expect(buildBotView(state, 2).myUpgrades).toEqual({ scout: false, wall: false, fighter: false });
  });

  it("upgraded scouts still stop at obstacles and map edges", () => {
    const s = testState({ walls: [[13, 10]] });
    const scout = addUnit(s, 1, "scout", 10, 10, { upgraded: true });
    const edge = addUnit(s, 1, "scout", 38, 20, { upgraded: true });
    const { state } = step(s, [
      { type: "move", unitId: scout.id, dir: "E" },
      { type: "move", unitId: edge.id, dir: "E" },
    ], []);
    expect(unit(state, scout.id)).toMatchObject({ x: 12, y: 10 });
    expect(unit(state, edge.id)).toMatchObject({ x: 39, y: 20 });
  });

  it("upgraded scouts stop at occupied tiles on later sub-steps", () => {
    const s = testState();
    const scout = addUnit(s, 1, "scout", 10, 10, { upgraded: true });
    addUnit(s, 2, "worker", 13, 10);
    const { state } = step(s, [{ type: "move", unitId: scout.id, dir: "E" }], []);
    expect(unit(state, scout.id)).toMatchObject({ x: 12, y: 10 });
  });

  it("upgraded moveTo stops at its target without overshooting", () => {
    const s = testState();
    const scout = addUnit(s, 1, "scout", 10, 10, { upgraded: true });
    const { state } = step(s, [{ type: "moveTo", unitId: scout.id, x: 12, y: 10 }], []);
    expect(unit(state, scout.id)).toMatchObject({ x: 12, y: 10 });
  });

  it("moveTo takes one shortest-path step around obstacles", () => {
    // Wall column at x=11, y=8..12; unit at (10,10) going to (12,10).
    const s = testState({ walls: [8, 9, 10, 11, 12].map((y) => [11, y] as [number, number]) });
    const u = addUnit(s, 1, "worker", 10, 10);
    let st = s;
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      st = step(st, [{ type: "moveTo", unitId: u.id, x: 12, y: 10 }], []).state;
      const p = unit(st, u.id)!;
      seen.push(`${p.x},${p.y}`);
    }
    expect(seen.at(-1)).toBe("12,10");
    // Shortest path length is 8 (around a 5-tall wall); arrive at step 8 then stay.
    expect(seen.indexOf("12,10")).toBe(7);
  });

  it("moveTo a blocked tile stops adjacent to it", () => {
    const s = testState();
    const u = addUnit(s, 1, "fighter", 30, 35);
    let st = s;
    for (let i = 0; i < 10; i++) st = step(st, [{ type: "moveTo", unitId: u.id, x: 35, y: 35 }], []).state;
    expect(unit(st, u.id)).toMatchObject({ x: 34, y: 35 });
  });

  it("moveTo with no path reports an invalid action", () => {
    const walls: [number, number][] = [];
    for (let x = 0; x < 40; x++) walls.push([x, 20]);
    const s = testState({ walls });
    const u = addUnit(s, 1, "worker", 10, 10);
    const { events } = step(s, [{ type: "moveTo", unitId: u.id, x: 10, y: 30 }], []);
    expect(invalid(events)[0]).toMatchObject({ reason: "no path to target" });
  });

  it("units cannot enter base, structure or node tiles", () => {
    const s = testState();
    addNode(s, "energy", 12, 10);
    s.structures.push({ upgraded: false, id: 90, owner: 2, type: "wall", x: 10, y: 12, hp: 40 });
    const a = addUnit(s, 1, "worker", 11, 10);
    const b = addUnit(s, 1, "worker", 10, 11);
    const c = addUnit(s, 1, "worker", 5, 4);
    const { state } = step(s, [
      { type: "move", unitId: a.id, dir: "E" },
      { type: "move", unitId: b.id, dir: "S" },
      { type: "move", unitId: c.id, dir: "W" },
    ], []);
    expect(unit(state, a.id)).toMatchObject({ x: 11, y: 10 });
    expect(unit(state, b.id)).toMatchObject({ x: 10, y: 11 });
    expect(unit(state, c.id)).toMatchObject({ x: 5, y: 4 });
  });
});

describe("spawning and upgrades", () => {
  it("spawns next to base, deducts cost, one per tick", () => {
    const s = testState();
    const { state, events } = step(s, [{ type: "spawn", unit: "fighter" }, { type: "spawn", unit: "worker" }], []);
    expect(state.units).toHaveLength(1);
    expect(state.units[0]).toMatchObject({ type: "fighter", owner: 1 });
    expect(Math.max(Math.abs(state.units[0]!.x - 4), Math.abs(state.units[0]!.y - 4))).toBe(1);
    expect(state.players[0]).toMatchObject({ energy: 940, crystal: 985 });
    expect(invalid(events)[0]).toMatchObject({ reason: "only one spawn per tick" });
  });

  it("spawn placement is point-symmetric between players", () => {
    const s = testState();
    const { state } = step(s, [{ type: "spawn", unit: "worker" }], [{ type: "spawn", unit: "worker" }]);
    const [a, b] = state.units;
    expect(a!.x + b!.x).toBe(39);
    expect(a!.y + b!.y).toBe(39);
  });

  it("rejects spawn without resources, at unit cap, or with no free tile", () => {
    const s = testState();
    s.players[0].energy = 49;
    expect(invalid(step(s, [{ type: "spawn", unit: "worker" }], []).events)[0]).toMatchObject({ reason: "not enough resources" });

    const capped = testState();
    for (let i = 0; i < CONFIG.match.unitCap; i++) addUnit(capped, 1, "scout", 20 + (i % 10), 10 + Math.floor(i / 10));
    expect(invalid(step(capped, [{ type: "spawn", unit: "worker" }], []).events)[0]).toMatchObject({ reason: "unit cap reached" });

    const boxed = testState();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) addUnit(boxed, 2, "worker", 4 + dx, 4 + dy);
    expect(invalid(step(boxed, [{ type: "spawn", unit: "worker" }], []).events)[0]).toMatchObject({ reason: "no free tile next to base" });
  });

  it("an upgrade is bought once per type and covers every current entity of that type", () => {
    const s = testState();
    const scout = addUnit(s, 1, "scout", 10, 10);
    const other = addUnit(s, 1, "scout", 10, 12);
    const fighter = addUnit(s, 1, "fighter", 10, 14);
    const enemyScout = addUnit(s, 2, "scout", 30, 30);
    s.structures.push({ upgraded: false, id: 50, owner: 1, type: "wall", x: 12, y: 12, hp: 60 });
    s.structures.push({ upgraded: false, id: 51, owner: 1, type: "wall", x: 13, y: 12, hp: 60 });
    const r1 = step(s, [
      { type: "upgrade", upgrade: "scout" },
      { type: "upgrade", upgrade: "fighter" },
      { type: "upgrade", upgrade: "wall" },
    ], []);
    expect(invalid(r1.events)).toHaveLength(0);
    expect(r1.state.players[0].crystal).toBe(1000 - 15 - 20);
    expect(r1.state.players[0].energy).toBe(1000 - 50);
    expect(r1.state.players[0].upgrades).toEqual(["scout", "fighter", "wall"]);
    expect(unit(r1.state, scout.id)).toMatchObject({ upgraded: true, hp: 10 });
    expect(unit(r1.state, other.id)).toMatchObject({ upgraded: true, hp: 10 });
    expect(unit(r1.state, fighter.id)).toMatchObject({ upgraded: true, hp: 30 });
    expect(unit(r1.state, enemyScout.id)!.upgraded).toBeFalsy();
    expect(r1.state.structures.map((x) => [x.upgraded, x.hp])).toEqual([[true, 120], [true, 120]]);
    expect(r1.events).toContainEqual({ type: "upgrade", player: 1, upgrade: "scout" });
    const r2 = step(r1.state, [{ type: "upgrade", upgrade: "scout" }], []);
    expect(invalid(r2.events)[0]).toMatchObject({ reason: "already upgraded" });
    expect(r2.state.players[0].crystal).toBe(1000 - 15 - 20);
  });

  it("units spawned and walls built after the upgrade start upgraded, at full upgraded HP", () => {
    const s = testState();
    const w = addUnit(s, 1, "worker", 10, 10);
    const r1 = step(s, [{ type: "upgrade", upgrade: "scout" }, { type: "upgrade", upgrade: "wall" }], []);
    const r2 = step(r1.state, [{ type: "spawn", unit: "scout" }, { type: "build", unitId: w.id, structure: "wall", x: 11, y: 10 }], [{ type: "spawn", unit: "scout" }]);
    expect(invalid(r2.events)).toHaveLength(0);
    const mine = r2.state.units.find((u) => u.owner === 1 && u.type === "scout")!;
    const theirs = r2.state.units.find((u) => u.owner === 2 && u.type === "scout")!;
    expect(mine).toMatchObject({ upgraded: true, hp: 10 });
    expect(theirs).toMatchObject({ upgraded: false, hp: 5 });
    expect(r2.state.structures[0]).toMatchObject({ type: "wall", upgraded: true, hp: 120 });
    const { state } = step(r2.state, [{ type: "move", unitId: mine.id, dir: "E" }], []);
    expect(unit(state, mine.id)!.x).toBe(mine.x + 4);
  });

  it("upgrading damaged entities adds the extra max HP", () => {
    const s = testState();
    const scout = addUnit(s, 1, "scout", 10, 10, { hp: 2 });
    s.structures.push({ upgraded: false, id: 50, owner: 1, type: "wall", x: 12, y: 12, hp: 10 });
    const { state } = step(s, [{ type: "upgrade", upgrade: "scout" }, { type: "upgrade", upgrade: "wall" }], []);
    expect(unit(state, scout.id)!.hp).toBe(7);
    expect(state.structures[0]!.hp).toBe(70);
  });

  it("rejects unknown upgrades, types without one, a missing type and duplicates", () => {
    const s = testState();
    const { events } = step(s, [
      { type: "upgrade", upgrade: "worker" },
      { type: "upgrade", upgrade: "armor" },
      { type: "upgrade", upgrade: "constructor" },
      { type: "upgrade" },
      { type: "upgrade", upgrade: "scout" },
      { type: "upgrade", upgrade: "scout" },
    ], []);
    expect(invalid(events).map((e) => e.type === "invalid_action" && e.reason)).toEqual([
      "unknown upgrade",
      "unknown upgrade",
      "unknown upgrade",
      "unknown upgrade",
      "duplicate upgrade",
    ]);
  });

  it.each([
    ["scout", 14, 15, "crystal"],
    ["fighter", 19, 20, "crystal"],
  ] as const)("%s upgrade requires exactly its cost (%i fails, %i succeeds)", (type, low, ok, res) => {
    for (const amount of [low, ok]) {
      const s = testState();
      s.players[0][res] = amount;
      const u = addUnit(s, 1, type, 10, 10);
      const { state, events } = step(s, [{ type: "upgrade", upgrade: type }], []);
      expect(!!unit(state, u.id)!.upgraded).toBe(amount === ok);
      expect(state.players[0][res]).toBe(amount === ok ? 0 : amount);
      if (amount !== ok) expect(invalid(events)[0]).toMatchObject({ reason: "not enough resources" });
    }
  });

  it("wall upgrade costs 50 energy, and can be bought before owning any wall", () => {
    for (const energy of [49, 50]) {
      const s = testState();
      s.players[0].energy = energy;
      s.structures.push({ upgraded: false, id: 50, owner: 1, type: "wall", x: 12, y: 12, hp: 60 });
      const { state } = step(s, [{ type: "upgrade", upgrade: "wall" }], []);
      expect(state.structures[0]).toMatchObject({ hp: energy === 50 ? 120 : 60 });
      expect(state.players[0].energy).toBe(energy === 50 ? 0 : 49);
    }
    const none = step(testState(), [{ type: "upgrade", upgrade: "wall" }], []);
    expect(invalid(none.events)).toHaveLength(0);
    expect(none.state.players[0].upgrades).toEqual(["wall"]);
  });

  it("without the upgrade, newly spawned scouts are not upgraded", () => {
    const s = testState();
    const { state: spawned } = step(s, [{ type: "spawn", unit: "scout" }], []);
    const scout = spawned.units[0]!;
    expect(scout.upgraded).toBe(false);
    const { state } = step(spawned, [{ type: "move", unitId: scout.id, dir: "E" }], []);
    expect(unit(state, scout.id)!.x).toBe(scout.x + 2);
  });

});

describe("harvest, deposit, build", () => {
  it("harvests 5 per tick into cargo up to capacity, then deposits at base", () => {
    const s = testState();
    const n = addNode(s, "energy", 6, 6);
    const w = addUnit(s, 1, "worker", 5, 5); // diagonal to node and to base
    let st = s;
    for (let i = 0; i < 5; i++) st = step(st, [{ type: "harvest", unitId: w.id, nodeId: n.id }], []).state;
    expect(unit(st, w.id)!.cargo.energy).toBe(20);
    expect(st.nodes[0]!.amount).toBe(600 - 20 + 5); // regen 1/tick (capped at 600 for the first ticks)
    const r = step(st, [{ type: "deposit", unitId: w.id }], []);
    expect(r.state.players[0].energy).toBe(1020);
    expect(unit(r.state, w.id)!.cargo.energy).toBe(0);
  });

  it("rejects harvest when not adjacent and deposit away from base; only workers carry", () => {
    const s = testState();
    const n = addNode(s, "energy", 20, 20);
    const w = addUnit(s, 1, "worker", 10, 10);
    const f = addUnit(s, 1, "fighter", 21, 21);
    const { events } = step(s, [
      { type: "harvest", unitId: w.id, nodeId: n.id },
      { type: "harvest", unitId: f.id, nodeId: n.id },
    ], []);
    expect(invalid(events).map((e) => e.type === "invalid_action" && e.reason)).toEqual(["fighter cannot harvest", "not adjacent to node"]);
  });

  it("contested node: priority alternates by tick parity", () => {
    const s = testState();
    const n = addNode(s, "crystal", 20, 20, 5);
    const a = addUnit(s, 1, "worker", 19, 20);
    const b = addUnit(s, 2, "worker", 21, 20);
    const acts = (id: number) => [{ type: "harvest", unitId: id, nodeId: n.id }];
    const even = step(s, acts(a.id), acts(b.id)).state;
    expect([unit(even, a.id)!.cargo.crystal, unit(even, b.id)!.cargo.crystal]).toEqual([5, 0]);
    const odd = step({ ...s, tick: 1 }, acts(a.id), acts(b.id)).state;
    expect([unit(odd, a.id)!.cargo.crystal, unit(odd, b.id)!.cargo.crystal]).toEqual([0, 5]);
  });

  it("builds turrets and walls on adjacent empty tiles, paying energy", () => {
    const s = testState();
    const w = addUnit(s, 1, "worker", 8, 8);
    const w2 = addUnit(s, 1, "worker", 20, 20);
    const { state, events } = step(s, [
      { type: "build", unitId: w.id, structure: "turret", x: 9, y: 9 },
      { type: "build", unitId: w2.id, structure: "wall", x: 21, y: 20 },
    ], []);
    expect(state.structures.map((x) => [x.type, x.x, x.y, x.hp])).toEqual([["turret", 9, 9, 50], ["wall", 21, 20, 60]]);
    expect(state.players[0].energy).toBe(1000 - 100 - 3);
    expect(invalid(events)).toHaveLength(0);
  });

  it.each([2, 3])("checks wall affordability with %i energy", (energy) => {
    const s = testState();
    s.players[0].energy = energy;
    const w = addUnit(s, 1, "worker", 10, 10);
    const { state, events } = step(s, [
      { type: "build", unitId: w.id, structure: "wall", x: 11, y: 10 },
    ], []);
    expect(state.structures).toHaveLength(energy === 3 ? 1 : 0);
    expect(state.players[0].energy).toBe(energy === 3 ? 0 : energy);
    expect(invalid(events)).toHaveLength(energy === 3 ? 0 : 1);
  });

  it("turrets must be within 8 tiles of own base", () => {
    const s = testState();
    const ok = addUnit(s, 1, "worker", 11, 11);
    const far = addUnit(s, 1, "worker", 12, 13);
    const { state, events } = step(s, [
      { type: "build", unitId: ok.id, structure: "turret", x: 12, y: 12 },
      { type: "build", unitId: far.id, structure: "turret", x: 13, y: 13 },
    ], []);
    expect(state.structures.map((x) => [x.type, x.x, x.y])).toEqual([["turret", 12, 12]]);
    expect(invalid(events)).toHaveLength(1);
    expect(invalid(events)[0]).toMatchObject({ reason: "turret must be within 8 tiles of base" });
  });

  it("build fails on occupied tiles, non-adjacent tiles, and when both players pick the same tile", () => {
    const s = testState();
    const a = addUnit(s, 1, "worker", 19, 20);
    const b = addUnit(s, 2, "worker", 21, 20);
    const c = addUnit(s, 1, "worker", 10, 10);
    addUnit(s, 2, "scout", 11, 11);
    const { state, events } = step(s, [
      { type: "build", unitId: a.id, structure: "wall", x: 20, y: 20 },
      { type: "build", unitId: c.id, structure: "wall", x: 11, y: 11 },
    ], [
      { type: "build", unitId: b.id, structure: "wall", x: 20, y: 20 },
    ]);
    expect(state.structures).toHaveLength(0);
    const reasons = invalid(events).map((e) => e.type === "invalid_action" && e.reason);
    expect(reasons).toContain("build tile not empty");
    expect(reasons.filter((r) => r === "both players built on the same tile")).toHaveLength(2);
  });

  it("units moving off a tile free it for building in the same tick", () => {
    const s = testState();
    const w = addUnit(s, 1, "worker", 10, 10);
    const m = addUnit(s, 1, "scout", 11, 10);
    const { state } = step(s, [
      { type: "move", unitId: m.id, dir: "E" },
      { type: "build", unitId: w.id, structure: "wall", x: 11, y: 10 },
    ], []);
    expect(state.structures).toHaveLength(1);
  });
});

describe("combat", () => {
  it("damage is simultaneous: two fighters at equal HP trade evenly", () => {
    const s = testState();
    const a = addUnit(s, 1, "fighter", 20, 20, { hp: 6 });
    const b = addUnit(s, 2, "fighter", 21, 20, { hp: 6 });
    const { state, events } = step(s, [{ type: "attack", unitId: a.id, targetId: b.id }], [{ type: "attack", unitId: b.id, targetId: a.id }]);
    expect(state.units).toHaveLength(0);
    expect(events.filter((e) => e.type === "death")).toHaveLength(2);
  });

  it("attacks are range 1 (Chebyshev), use post-movement positions", () => {
    const s = testState();
    const a = addUnit(s, 1, "fighter", 20, 20);
    const b = addUnit(s, 2, "worker", 21, 21);
    const r1 = step(s, [{ type: "attack", unitId: a.id, targetId: b.id }], []);
    expect(unit(r1.state, b.id)!.hp).toBe(4);
    const r2 = step(s, [{ type: "attack", unitId: a.id, targetId: b.id }], [{ type: "move", unitId: b.id, dir: "E" }]);
    expect(invalid(r2.events)[0]).toMatchObject({ reason: "target out of range" });
  });

  it("upgraded fighters take normal damage from units", () => {
    const s = testState();
    const a = addUnit(s, 1, "fighter", 20, 20);
    const b = addUnit(s, 2, "fighter", 21, 20, { upgraded: true });
    const { state } = step(s, [{ type: "attack", unitId: a.id, targetId: b.id }], [{ type: "attack", unitId: b.id, targetId: a.id }]);
    expect(unit(state, b.id)!.hp).toBe(24);
    expect(unit(state, a.id)!.hp).toBe(24);
  });

  it("turrets ignore upgraded fighters and shoot the next valid target", () => {
    const s = testState();
    s.structures.push({ upgraded: false, id: 50, owner: 1, type: "turret", x: 8, y: 8, hp: 50 });
    const immune = addUnit(s, 2, "fighter", 9, 8, { hp: 1, upgraded: true });
    const plain = addUnit(s, 2, "fighter", 10, 8, { hp: 20 });
    const { state } = step(s, [], []);
    expect(unit(state, immune.id)!.hp).toBe(1);
    expect(unit(state, plain.id)!.hp).toBe(16);
    const alone = testState();
    alone.structures.push({ id: 50, owner: 1, type: "turret", x: 8, y: 8, hp: 50 });
    const only = addUnit(alone, 2, "fighter", 9, 8, { upgraded: true });
    const r = step(alone, [], []);
    expect(unit(r.state, only.id)!.hp).toBe(30);
    expect(r.events.filter((e) => e.type === "attack")).toHaveLength(0);
  });

  it("turrets hit the lowest-HP enemy in range, ties to lowest ID", () => {
    const s = testState();
    s.structures.push({ upgraded: false, id: 50, owner: 1, type: "turret", x: 8, y: 8, hp: 50 });
    const far = addUnit(s, 2, "worker", 13, 8, { hp: 1 }); // range 5: out
    const x = addUnit(s, 2, "fighter", 12, 8, { hp: 20 });
    const y = addUnit(s, 2, "fighter", 8, 12, { hp: 20 });
    addUnit(s, 2, "fighter", 9, 9, { hp: 25 });
    const { state } = step(s, [], []);
    expect(unit(state, x.id)!.hp).toBe(16);
    expect(unit(state, y.id)!.hp).toBe(20);
    expect(unit(state, far.id)!.hp).toBe(1);
  });

  it("fighters can damage structures and bases; cannot attack own entities", () => {
    const s = testState();
    s.structures.push({ upgraded: false, id: 50, owner: 2, type: "wall", x: 21, y: 20, hp: 40 });
    const a = addUnit(s, 1, "fighter", 20, 20);
    const b = addUnit(s, 1, "fighter", 34, 34);
    const c = addUnit(s, 1, "fighter", 5, 5);
    const { state, events } = step(s, [
      { type: "attack", unitId: a.id, targetId: 50 },
      { type: "attack", unitId: b.id, targetId: 2 },
      { type: "attack", unitId: c.id, targetId: 1 },
    ], []);
    expect(state.structures[0]!.hp).toBe(34);
    expect(state.bases[1].hp).toBe(194);
    expect(invalid(events)[0]).toMatchObject({ reason: "cannot attack own entity" });
  });

  it("workers cannot attack; scouts hit for 1", () => {
    const s = testState();
    const w = addUnit(s, 1, "worker", 20, 20);
    const sc = addUnit(s, 1, "scout", 22, 22);
    const t = addUnit(s, 2, "worker", 21, 21);
    const { state, events } = step(s, [
      { type: "attack", unitId: w.id, targetId: t.id },
      { type: "attack", unitId: sc.id, targetId: t.id },
    ], []);
    expect(invalid(events).map((e) => e.type === "invalid_action" && e.reason)).toEqual(["worker cannot attack"]);
    expect(state.units.find((u) => u.id === t.id)!.hp).toBe(CONFIG.units.worker.hp - 1);
  });
});

describe("match end", () => {
  it("destroying the enemy base wins immediately", () => {
    const s = testState();
    s.bases[1].hp = 6;
    const f = addUnit(s, 1, "fighter", 34, 34);
    const { state } = step(s, [{ type: "attack", unitId: f.id, targetId: 2 }], []);
    expect(state.result).toMatchObject({ winner: 1, reason: "base_destroyed" });
  });

  it("both bases destroyed on the same tick, equal unit counts → higher score wins", () => {
    const s = testState();
    s.bases[0].hp = 6;
    s.bases[1].hp = 6;
    s.players[1].energy = 2000;
    const f1 = addUnit(s, 1, "fighter", 34, 34);
    const f2 = addUnit(s, 2, "fighter", 5, 5);
    const { state } = step(s, [{ type: "attack", unitId: f1.id, targetId: 2 }], [{ type: "attack", unitId: f2.id, targetId: 1 }]);
    expect(state.result).toMatchObject({ winner: 2, reason: "score", units: [1, 1] });
  });

  it("both bases destroyed on the same tick → more living units wins", () => {
    const s = testState();
    s.bases[0].hp = 6;
    s.bases[1].hp = 6;
    s.players[1].energy = 2000;
    const f1 = addUnit(s, 1, "fighter", 34, 34);
    const f2 = addUnit(s, 2, "fighter", 5, 5);
    addUnit(s, 1, "scout", 20, 20);
    const { state } = step(s, [{ type: "attack", unitId: f1.id, targetId: 2 }], [{ type: "attack", unitId: f2.id, targetId: 1 }]);
    expect(state.result).toMatchObject({ winner: 1, reason: "units", units: [2, 1] });
  });

  it("time limit → more living units wins, even with a lower score", () => {
    const s = testState({ tick: CONFIG.match.maxTicks - 1 });
    s.players[1].energy = 5000;
    addUnit(s, 1, "scout", 18, 18);
    addUnit(s, 1, "scout", 19, 18);
    addUnit(s, 2, "fighter", 20, 20);
    const { state } = step(s, [], []);
    expect(state.result).toMatchObject({ winner: 1, reason: "units", units: [2, 1] });
  });

  it("time limit, equal unit counts → score decides; equal score → draw", () => {
    const s = testState({ tick: CONFIG.match.maxTicks - 1 });
    const { state } = step(s, [], []);
    expect(state.tick).toBe(CONFIG.match.maxTicks);
    expect(state.result).toMatchObject({ winner: "draw", reason: "score" });
  });

  it("score = energy + 3*crystal + unit spawn value + 2*base HP", () => {
    const s = testState();
    s.players[0].energy = 100;
    s.players[0].crystal = 10;
    s.bases[0].hp = 150;
    addUnit(s, 1, "worker", 10, 10);
    addUnit(s, 1, "fighter", 11, 10);
    expect(computeScore(s, 1)).toBe(100 + 30 + 50 + (60 + 45) + 300);
  });

  it("stepping a finished match throws", () => {
    const s = testState({ tick: CONFIG.match.maxTicks - 1 });
    const { state } = step(s, [], []);
    expect(() => step(state, [], [])).toThrow();
  });
});

describe("zone", () => {
  it("radius is constant before tick 400 then shrinks 1 every 4 ticks", () => {
    expect(zoneRadius(0)).toBe(28);
    expect(zoneRadius(399)).toBe(28);
    expect(zoneRadius(400)).toBe(27);
    expect(zoneRadius(403)).toBe(27);
    expect(zoneRadius(404)).toBe(26);
    expect(zoneRadius(499)).toBe(3);
  });

  it("damages units and structures outside, never bases, including upgraded fighters", () => {
    const s = testState({ tick: 432 }); // radius 19
    const out = addUnit(s, 1, "fighter", 2, 2, { upgraded: true });
    const inside = addUnit(s, 1, "fighter", 20, 20);
    s.structures.push({ upgraded: false, id: 60, owner: 2, type: "wall", x: 38, y: 38, hp: 40 });
    const { state } = step(s, [], []);
    expect(unit(state, out.id)!.hp).toBe(27);
    expect(unit(state, inside.id)!.hp).toBe(30);
    expect(state.structures[0]!.hp).toBe(37);
    expect(state.bases.map((b) => b.hp)).toEqual([200, 200]);
  });
});

describe("validation and robustness", () => {
  it("garbage actions are dropped with events and never throw", () => {
    const s = testState();
    const u = addUnit(s, 1, "worker", 10, 10);
    const enemy = addUnit(s, 2, "worker", 30, 30);
    const garbage: unknown[] = [
      null, 42, "move", [], {}, { type: 7 }, { type: "nope" },
      { type: "move", unitId: u.id, dir: "UP" },
      { type: "move", unitId: enemy.id, dir: "N" },
      { type: "move", unitId: 99999, dir: "N" },
      { type: "moveTo", unitId: u.id, x: -1, y: 5 },
      { type: "moveTo", unitId: u.id, x: 1.5, y: 5 },
      { type: "build", unitId: u.id, structure: "castle", x: 11, y: 10 },
      { type: "spawn", unit: "dragon" },
      { type: "spawn", unit: "constructor" },
      { type: "constructor" },
      { type: "hasOwnProperty", unitId: u.id },
      { type: "build", unitId: u.id, structure: "toString", x: 11, y: 10 },
      { type: "upgrade", upgrade: "laser" },
      { type: "mark", x: 1e9, y: 0 },
      { type: "harvest", unitId: u.id, nodeId: "x" },
      { type: "attack", unitId: u.id },
    ];
    const { state, events } = step(s, garbage, "not an array");
    expect(invalid(events).length).toBe(garbage.length + 1);
    expect(unit(state, u.id)).toMatchObject({ x: 10, y: 10 });
    expect(() => JSON.stringify(events)).not.toThrow();
  });

  it("only the first action per unit counts", () => {
    const s = testState();
    const u = addUnit(s, 1, "worker", 10, 10);
    const { state, events } = step(s, [
      { type: "move", unitId: u.id, dir: "E" },
      { type: "move", unitId: u.id, dir: "W" },
    ], []);
    expect(unit(state, u.id)!.x).toBe(11);
    expect(invalid(events)[0]).toMatchObject({ reason: "unit already has an action this tick" });
  });

  it("log and mark become events", () => {
    const s = testState();
    const { events } = step(s, [{ type: "log", text: "hello" }, { type: "mark", x: 3, y: 4, color: "red", label: "x" }], []);
    expect(events).toContainEqual({ type: "log", player: 1, text: "hello" });
    expect(events).toContainEqual({ type: "mark", player: 1, x: 3, y: 4, color: "red", label: "x" });
  });

  it("random fuzzing never throws", () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const types = ["move", "moveTo", "harvest", "deposit", "attack", "build", "spawn", "upgrade", "log", "mark"];
    const vals = [() => Math.floor(rnd() * 200), () => "N", () => "turret", () => "fighter", () => "armor", () => null, () => -1, () => rnd() * 40];
    let s = testState();
    for (let i = 0; i < 200 && !s.result; i++) {
      const mk = () =>
        Array.from({ length: 20 }, () => ({
          type: types[Math.floor(rnd() * types.length)],
          unitId: Math.floor(rnd() * 200),
          dir: ["N", "S", "E", "W"][Math.floor(rnd() * 4)],
          x: Math.floor(rnd() * 42) - 1,
          y: Math.floor(rnd() * 42) - 1,
          nodeId: vals[Math.floor(rnd() * vals.length)]!(),
          targetId: Math.floor(rnd() * 200),
          structure: rnd() < 0.5 ? "turret" : "wall",
          unit: ["worker", "fighter", "scout"][Math.floor(rnd() * 3)],
          text: "t",
        }));
      s = step(s, mk(), mk()).state;
    }
    expect(s.units.length).toBeGreaterThan(0);
  });
});

describe("fog of war", () => {
  it("bots only see enemies and tiles within their units' vision", () => {
    const s = testState();
    const w = addUnit(s, 1, "worker", 20, 20);
    const near = addUnit(s, 2, "worker", 24, 23); // dist² 25 ≤ 25 → visible
    const far = addUnit(s, 2, "worker", 25, 24); // dist² 41 → hidden
    const view = buildBotView(s, 1);
    const ids = view.visibleEnemies.map((e) => e.id);
    expect(ids).toContain(near.id);
    expect(ids).not.toContain(far.id);
    expect(ids).not.toContain(2); // enemy base far away
    expect(view.visibleTiles.some((t) => t.x === 20 && t.y === 25)).toBe(true);
    expect(view.visibleTiles.some((t) => t.x === 30 && t.y === 30)).toBe(false);
    expect(view.myUnits.map((u) => u.id)).toEqual([w.id]);
  });
});

describe("CPU budget bank", () => {
  it("absorbs a spike, refills slowly, and fails sustained overuse", () => {
    const b = new CpuBudget(50, 250);
    expect(b.charge(250)).toBeNull(); // 50 + 250 bank available
    expect(b.banked).toBe(50);
    expect(b.charge(120)).toMatch(/exceeded/); // only 50 + 50 available
    expect(b.banked).toBe(0);
    expect(b.charge(50)).toBeNull();
    for (let i = 0; i < 20; i++) b.charge(10); // 40 ms/tick unused refills to the cap
    expect(b.banked).toBe(250);
  });
});
