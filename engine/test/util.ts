import { CONFIG, type UnitType } from "../src/config.js";
import { TILE, type GameState, type PlayerId, type Unit } from "../src/types.js";

/** Open 40x40 map, bases at (4,4) and (35,35), no nodes, no units. Positions are free-form for rule tests. */
export function testState(opts: { walls?: [number, number][]; tick?: number } = {}): GameState {
  const size = CONFIG.map.size;
  const tiles = new Array(size * size).fill(TILE.floor);
  for (const [x, y] of opts.walls ?? []) tiles[y * size + x] = TILE.wall;
  return {
    tick: opts.tick ?? 0,
    seed: 0,
    map: { size, tiles: tiles.join("") },
    nodes: [],
    bases: [
      { id: 1, owner: 1, x: 4, y: 4, hp: CONFIG.base.hp },
      { id: 2, owner: 2, x: 35, y: 35, hp: CONFIG.base.hp },
    ],
    players: [
      { id: 1, energy: 1000, crystal: 1000, upgrades: [] },
      { id: 2, energy: 1000, crystal: 1000, upgrades: [] },
    ],
    units: [],
    structures: [],
    nextId: 100,
    result: null,
  };
}

export function addUnit(s: GameState, owner: PlayerId, type: UnitType, x: number, y: number, extra: Partial<Unit> = {}): Unit {
  const u: Unit = { id: s.nextId++, owner, type, x, y, hp: CONFIG.units[type].hp, cargo: { energy: 0, crystal: 0 }, upgraded: false, ...extra };
  s.units.push(u);
  s.units.sort((a, b) => a.id - b.id);
  return u;
}

export function addNode(s: GameState, type: "energy" | "crystal", x: number, y: number, amount?: number) {
  const n = { id: s.nextId++, type, x, y, amount: amount ?? CONFIG.nodes[type].amount };
  s.nodes.push(n);
  const tiles = s.map.tiles.split("");
  tiles[y * s.map.size + x] = type === "energy" ? TILE.energy_node : TILE.crystal_node;
  s.map = { ...s.map, tiles: tiles.join("") };
  return n;
}

export function unit(s: GameState, id: number): Unit | undefined {
  return s.units.find((u) => u.id === id);
}
