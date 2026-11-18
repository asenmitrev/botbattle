import type { BuildType, NodeType, Race, StructureType, UnitType, UpgradeType } from "./config.js";

export type PlayerId = 1 | 2;
export type Dir = "N" | "S" | "E" | "W";

/** Terrain characters in GameMap.tiles. */
export const TILE = { floor: ".", wall: "#", energy_node: "E", crystal_node: "C" } as const;
export type TileType = keyof typeof TILE;

export interface Pos {
  x: number;
  y: number;
}

export interface GameMap {
  size: number;
  /** Row-major string of TILE chars, length size*size. Index = y*size + x. */
  tiles: string;
}

export interface ResourceNode extends Pos {
  id: number;
  type: NodeType;
  amount: number;
}

export interface Base extends Pos {
  id: number;
  owner: PlayerId;
  hp: number;
}

export interface Cargo {
  energy: number;
  crystal: number;
}

export interface Unit extends Pos {
  id: number;
  owner: PlayerId;
  type: UnitType;
  hp: number;
  cargo: Cargo;
  /** Upgrades its owner bought that apply to its type, in purchase order (see CONFIG.upgrades and stats.ts). */
  upgrades: UpgradeType[];
}

export interface Structure extends Pos {
  id: number;
  owner: PlayerId;
  type: StructureType;
  hp: number;
  /** Upgrades its owner bought that apply to its type, in purchase order (see CONFIG.upgrades and stats.ts). */
  upgrades: UpgradeType[];
}

export interface PlayerState {
  id: PlayerId;
  /** Fixed for the match: decides the base, units, structures and upgrades the player can use. */
  race: Race;
  energy: number;
  crystal: number;
  /** Upgrades this player has bought, in purchase order (see CONFIG.upgrades). */
  upgrades: UpgradeType[];
}

export type Winner = PlayerId | "draw";

export interface MatchResult {
  winner: Winner;
  /** "units" = more living units at the end; "score" = equal unit counts, decided by score. */
  reason: "base_destroyed" | "units" | "score" | "forfeit";
  scores: [number, number];
  /** Living units per player when the match ended. */
  units: [number, number];
  tick: number;
}

export interface GameState {
  tick: number;
  seed: number;
  map: GameMap;
  nodes: ResourceNode[];
  /** Initial bases first, then expansions. Destroyed bases remain with hp 0 for replay history. */
  bases: Base[];
  players: [PlayerState, PlayerState];
  units: Unit[];
  structures: Structure[];
  nextId: number;
  result: MatchResult | null;
}

// ---------------------------------------------------------------- actions

export type Action =
  | { type: "move"; unitId: number; dir: Dir }
  | { type: "moveTo"; unitId: number; x: number; y: number }
  | { type: "harvest"; unitId: number; nodeId: number }
  | { type: "deposit"; unitId: number }
  | { type: "attack"; unitId: number; targetId: number }
  | { type: "build"; unitId: number; structure: BuildType; x: number; y: number }
  /** A unit with `canTransform` (the Tumor Stem Cell) becomes a base of its race on its own tile. */
  | { type: "transform"; unitId: number }
  | { type: "spawn"; unit: UnitType; baseId?: number }
  /** Buy an upgrade of your race (one with a target type covers all your entities of it, current and future). */
  | { type: "upgrade"; upgrade: UpgradeType }
  | { type: "log"; text: string }
  | { type: "mark"; x: number; y: number; color?: string; label?: string };

// ---------------------------------------------------------------- events

export type EntityKind = "unit" | "structure" | "base";

export type GameEvent =
  | { type: "invalid_action"; player: PlayerId; action: unknown; reason: string }
  | { type: "spawn"; player: PlayerId; unitId: number; unit: UnitType; x: number; y: number }
  | { type: "upgrade"; player: PlayerId; upgrade: UpgradeType }
  | { type: "harvest"; player: PlayerId; unitId: number; nodeId: number; resource: NodeType; amount: number }
  | { type: "deposit"; player: PlayerId; unitId: number; energy: number; crystal: number }
  | { type: "build"; player: PlayerId; unitId: number; structureId: number; structure: BuildType; x: number; y: number }
  /** The unit is gone; base `baseId` stands on its tile. */
  | { type: "transform"; player: PlayerId; unitId: number; baseId: number; x: number; y: number }
  | { type: "heal"; healerId: number; targetId: number; amount: number }
  | { type: "attack"; attackerId: number; targetId: number; damage: number }
  | { type: "zone_damage"; targetId: number; damage: number }
  | { type: "death"; id: number; kind: EntityKind; owner: PlayerId; x: number; y: number }
  | { type: "base_destroyed"; player: PlayerId; baseId: number }
  | { type: "log"; player: PlayerId; text: string }
  | { type: "mark"; player: PlayerId; x: number; y: number; color: string; label: string }
  | { type: "bot_error"; player: PlayerId; message: string }
  | { type: "game_over"; result: MatchResult };

export interface StepResult {
  state: GameState;
  events: GameEvent[];
}
