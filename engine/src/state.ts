import { CONFIG, type StructureType, type UnitType } from "./config.js";
import { ADJ8, inBounds } from "./geometry.js";
import { generateMap } from "./map.js";
import { hasUpgradeType, maxHp, unitValue } from "./stats.js";
import { TILE, type Base, type GameState, type PlayerId, type PlayerState, type Pos, type Unit } from "./types.js";

export function createInitialState(seed: number): GameState {
  const gen = generateMap(seed);
  let nextId = 1;
  const nodes = [
    ...gen.energyNodes.map((p) => ({ id: 0, type: "energy" as const, x: p.x, y: p.y, amount: CONFIG.nodes.energy.amount })),
    ...gen.crystalNodes.map((p) => ({ id: 0, type: "crystal" as const, x: p.x, y: p.y, amount: CONFIG.nodes.crystal.amount })),
  ];
  // IDs are assigned in a stable spatial order.
  nodes.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const n of nodes) n.id = nextId++;

  const bases: [Base, Base] = [
    { id: nextId++, owner: 1, x: gen.bases[0].x, y: gen.bases[0].y, hp: CONFIG.base.hp },
    { id: nextId++, owner: 2, x: gen.bases[1].x, y: gen.bases[1].y, hp: CONFIG.base.hp },
  ];
  const mkPlayer = (id: PlayerId): PlayerState => ({
    id,
    energy: CONFIG.match.startEnergy,
    crystal: CONFIG.match.startCrystal,
    upgrades: [],
  });

  const state: GameState = {
    tick: 0,
    seed,
    map: gen.map,
    nodes,
    bases,
    players: [mkPlayer(1), mkPlayer(2)],
    units: [],
    structures: [],
    nextId,
    result: null,
  };

  for (let i = 0; i < CONFIG.match.startWorkers; i++) {
    for (const owner of [1, 2] as const) {
      const tile = findSpawnTile(state, owner);
      if (!tile) throw new Error("no room for starting workers");
      state.units.push(makeUnit(state, owner, "worker", tile));
    }
  }
  return state;
}

export function makeUnit(state: GameState, owner: PlayerId, type: UnitType, pos: Pos): Unit {
  const upgraded = hasUpgrade(state, owner, type);
  return { id: state.nextId++, owner, type, x: pos.x, y: pos.y, hp: maxHp({ type, upgraded }), cargo: { energy: 0, crystal: 0 }, upgraded };
}

/** Whether `owner` has bought the upgrade for `type` (which then applies to all their entities of that type). */
export function hasUpgrade(state: GameState, owner: PlayerId, type: UnitType | StructureType): boolean {
  return hasUpgradeType(type) && state.players[owner - 1]!.upgrades.includes(type);
}

/** Occupancy grid: 1 for every tile blocked by terrain, nodes, bases, structures or units. */
export function occupancy(state: GameState, includeUnits = true): Uint8Array {
  const size = state.map.size;
  const occ = new Uint8Array(size * size);
  for (let i = 0; i < occ.length; i++) if (state.map.tiles[i] !== TILE.floor) occ[i] = 1;
  for (const b of state.bases) if (b.hp > 0) occ[b.y * size + b.x] = 1;
  for (const s of state.structures) occ[s.y * size + s.x] = 1;
  if (includeUnits) for (const u of state.units) occ[u.y * size + u.x] = 1;
  return occ;
}

/**
 * First free tile adjacent to a living friendly base, in base-ID then ADJ8 order.
 * Player 2 negates the offsets so spawn placement is point-symmetric.
 */
export function findSpawnTile(state: GameState, owner: PlayerId, occ = occupancy(state), baseId?: number): Pos | null {
  const bases = state.bases.filter((b) => b.owner === owner && b.hp > 0 && (baseId === undefined || b.id === baseId))
    .sort((a, b) => a.id - b.id);
  const sign = owner === 1 ? 1 : -1;
  const size = state.map.size;
  for (const base of bases) {
    for (const o of ADJ8) {
      const x = base.x + sign * o.x;
      const y = base.y + sign * o.y;
      if (inBounds(size, x, y) && !occ[y * size + x]) return { x, y };
    }
  }
  return null;
}

const clonePlayer = (p: PlayerState): PlayerState => ({ ...p, upgrades: [...p.upgrades] });

export function cloneState(s: GameState): GameState {
  return {
    tick: s.tick,
    seed: s.seed,
    map: s.map, // immutable
    nodes: s.nodes.map((n) => ({ ...n })),
    bases: s.bases.map((b) => ({ ...b })),
    players: [
      clonePlayer(s.players[0]),
      clonePlayer(s.players[1]),
    ],
    units: s.units.map((u) => ({ ...u, cargo: { ...u.cargo } })),
    structures: s.structures.map((x) => ({ ...x })),
    nextId: s.nextId,
    result: s.result ? { ...s.result, scores: [...s.result.scores], units: [...s.result.units] } : null,
  };
}

export function computeScore(state: GameState, owner: PlayerId): number {
  const p = state.players[owner - 1]!;
  const sc = CONFIG.score;
  let units = 0;
  for (const u of state.units) if (u.owner === owner) units += unitValue(u.type);
  const baseHp = state.bases.reduce((hp, b) => hp + (b.owner === owner ? Math.max(0, b.hp) : 0), 0);
  return p.energy * sc.energyWeight + p.crystal * sc.crystalWeight + units * sc.unitValueWeight + baseHp * sc.baseHpWeight;
}

/** Zone radius in effect while resolving tick `tick`. */
export function zoneRadius(tick: number): number {
  const z = CONFIG.zone;
  if (tick < z.startTick) return z.initialRadius;
  const shrinks = 1 + Math.floor((tick - z.startTick) / z.shrinkEvery);
  return Math.max(0, z.initialRadius - shrinks * z.shrinkAmount);
}

export function zoneCenter(state: GameState): Pos {
  return { x: (state.map.size - 1) / 2, y: (state.map.size - 1) / 2 };
}
