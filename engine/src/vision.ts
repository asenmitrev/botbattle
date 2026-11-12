import { CONFIG, type NodeType, type StructureType, type UnitType } from "./config.js";
import { dist2 } from "./geometry.js";
import { cargoCapacity, zoneCenter, zoneRadius } from "./state.js";
import { TILE, type GameState, type PlayerId, type Pos, type TileType, type Upgrades } from "./types.js";

/** Visibility grid for a player: 1 = visible. Vision is a Euclidean circle; no line of sight. */
export function computeVisibility(state: GameState, player: PlayerId): Uint8Array {
  const size = state.map.size;
  const vis = new Uint8Array(size * size);
  const reveal = (p: Pos, r: number) => {
    if (r <= 0) return;
    const r2 = r * r;
    for (let y = Math.max(0, p.y - r); y <= Math.min(size - 1, p.y + r); y++) {
      for (let x = Math.max(0, p.x - r); x <= Math.min(size - 1, p.x + r); x++) {
        if (dist2(p, { x, y }) <= r2) vis[y * size + x] = 1;
      }
    }
  };
  reveal(state.bases[player - 1]!, CONFIG.base.vision);
  for (const u of state.units) if (u.owner === player) reveal(u, CONFIG.units[u.type].vision);
  for (const s of state.structures) if (s.owner === player) reveal(s, CONFIG.structures[s.type].vision);
  return vis;
}

// ------------------------------------------------------------ bot view types

export interface BotUnit {
  id: number;
  type: UnitType;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  cargo: { energy: number; crystal: number };
  cargoCapacity: number;
}

export interface BotStructure {
  id: number;
  type: StructureType;
  x: number;
  y: number;
  hp: number;
}

export type BotEnemy =
  | { id: number; kind: "unit"; type: UnitType; x: number; y: number; hp: number }
  | { id: number; kind: "structure"; type: StructureType; x: number; y: number; hp: number }
  | { id: number; kind: "base"; type: "base"; x: number; y: number; hp: number };

export interface BotNode {
  id: number;
  type: NodeType;
  x: number;
  y: number;
  amount: number;
}

export interface BotTile {
  x: number;
  y: number;
  type: TileType;
}

export interface BotState {
  tick: number;
  player: PlayerId;
  myBase: { id: number; x: number; y: number; hp: number };
  myUnits: BotUnit[];
  myStructures: BotStructure[];
  energy: number;
  crystal: number;
  upgrades: Upgrades;
  visibleEnemies: BotEnemy[];
  visibleNodes: BotNode[];
  visibleTiles: BotTile[];
  mapSize: number;
  zone: { x: number; y: number; radius: number; nextRadius: number; damage: number; shrinkStartTick: number };
  unitCap: number;
  maxTicks: number;
}

const TILE_NAMES: Record<string, TileType> = {
  [TILE.floor]: "floor",
  [TILE.wall]: "wall",
  [TILE.energy_node]: "energy_node",
  [TILE.crystal_node]: "crystal_node",
};

/** Fog-filtered view handed to a bot at the start of a tick. */
export function buildBotView(state: GameState, player: PlayerId, vis = computeVisibility(state, player)): BotState {
  const size = state.map.size;
  const seen = (p: Pos) => vis[p.y * size + p.x] === 1;
  const me = state.players[player - 1]!;
  const base = state.bases[player - 1]!;
  const enemyBase = state.bases[2 - player]!;

  const visibleEnemies: BotEnemy[] = [];
  if (seen(enemyBase)) visibleEnemies.push({ id: enemyBase.id, kind: "base", type: "base", x: enemyBase.x, y: enemyBase.y, hp: enemyBase.hp });
  for (const u of state.units) {
    if (u.owner !== player && seen(u)) visibleEnemies.push({ id: u.id, kind: "unit", type: u.type, x: u.x, y: u.y, hp: u.hp });
  }
  for (const s of state.structures) {
    if (s.owner !== player && seen(s)) visibleEnemies.push({ id: s.id, kind: "structure", type: s.type, x: s.x, y: s.y, hp: s.hp });
  }
  visibleEnemies.sort((a, b) => a.id - b.id);

  const visibleTiles: BotTile[] = [];
  for (let i = 0; i < vis.length; i++) {
    if (!vis[i]) continue;
    const x = i % size;
    visibleTiles.push({ x, y: (i - x) / size, type: TILE_NAMES[state.map.tiles[i]!]! });
  }

  const c = zoneCenter(state);
  return {
    tick: state.tick,
    player,
    myBase: { id: base.id, x: base.x, y: base.y, hp: base.hp },
    myUnits: state.units
      .filter((u) => u.owner === player)
      .map((u) => ({
        id: u.id,
        type: u.type,
        x: u.x,
        y: u.y,
        hp: u.hp,
        maxHp: CONFIG.units[u.type].hp,
        cargo: { ...u.cargo },
        cargoCapacity: cargoCapacity(state, player, u.type),
      })),
    myStructures: state.structures.filter((s) => s.owner === player).map((s) => ({ id: s.id, type: s.type, x: s.x, y: s.y, hp: s.hp })),
    energy: me.energy,
    crystal: me.crystal,
    upgrades: { ...me.upgrades },
    visibleEnemies,
    visibleNodes: state.nodes.filter(seen).map((n) => ({ id: n.id, type: n.type, x: n.x, y: n.y, amount: n.amount })),
    visibleTiles,
    mapSize: size,
    zone: {
      x: c.x,
      y: c.y,
      radius: zoneRadius(state.tick),
      nextRadius: zoneRadius(state.tick + 1),
      damage: CONFIG.zone.damage,
      shrinkStartTick: CONFIG.zone.startTick,
    },
    unitCap: CONFIG.match.unitCap,
    maxTicks: CONFIG.match.maxTicks,
  };
}
