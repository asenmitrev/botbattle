// Type definitions for the Bot Arena bot API. Use with JSDoc:
//   /** @type {import("./lib/api").OnTick} */
//   export function onTick(state, memory) { ... }

export type PlayerId = 1 | 2;
export type Dir = "N" | "S" | "E" | "W";
export type UnitType = "worker" | "fighter" | "scout";
export type StructureType = "turret" | "wall";
export type BuildType = StructureType | "base";
/** Types that have a per-unit upgrade. */
export type UpgradeType = "scout" | "wall" | "fighter";
export type NodeType = "energy" | "crystal";
export type TileType = "floor" | "wall" | "energy_node" | "crystal_node";

export interface Pos { x: number; y: number }

export interface MyUnit {
  id: number;
  type: UnitType;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  cargo: { energy: number; crystal: number };
  /** 0 for units that cannot carry. */
  cargoCapacity: number;
  /** This unit has bought its type's upgrade. */
  upgraded: boolean;
}

export interface MyStructure { id: number; type: StructureType; x: number; y: number; hp: number; maxHp: number; upgraded: boolean }

export type Enemy =
  | { id: number; kind: "unit"; type: UnitType; x: number; y: number; hp: number; upgraded: boolean }
  | { id: number; kind: "structure"; type: StructureType; x: number; y: number; hp: number; upgraded: boolean }
  | { id: number; kind: "base"; type: "base"; x: number; y: number; hp: number };

export interface VisibleNode { id: number; type: NodeType; x: number; y: number; amount: number }
export interface VisibleTile { x: number; y: number; type: TileType }

export interface Zone {
  /** Center (fractional: 19.5 on a 40x40 map). */
  x: number;
  y: number;
  /** Radius applied when this tick resolves. Outside (Euclidean) → `damage` per tick. */
  radius: number;
  /** Radius for the following tick. */
  nextRadius: number;
  damage: number;
  shrinkStartTick: number;
}

export interface BotState {
  tick: number;
  player: PlayerId;
  myBase: { id: number; x: number; y: number; hp: number };
  myBases: { id: number; x: number; y: number; hp: number }[];
  startingBase: { x: number; y: number };
  myUnits: MyUnit[];
  myStructures: MyStructure[];
  energy: number;
  crystal: number;
  visibleEnemies: Enemy[];
  visibleNodes: VisibleNode[];
  visibleTiles: VisibleTile[];
  mapSize: number;
  zone: Zone;
  unitCap: number;
  maxTicks: number;
}

export type Action =
  | { type: "move"; unitId: number; dir: Dir }
  | { type: "moveTo"; unitId: number; x: number; y: number }
  | { type: "harvest"; unitId: number; nodeId: number }
  | { type: "deposit"; unitId: number }
  | { type: "attack"; unitId: number; targetId: number }
  | { type: "build"; unitId: number; structure: BuildType; x: number; y: number }
  | { type: "spawn"; unit: UnitType; baseId?: number }
  /** Upgrade one of your scouts, fighters or walls (once per entity). */
  | { type: "upgrade"; targetId: number }
  | { type: "log"; text: string }
  | { type: "mark"; x: number; y: number; color?: string; label?: string };

/** JSON-serializable, persisted between ticks, max 100KB. */
export type Memory = Record<string, any>;

export type OnTick = (state: BotState, memory: Memory) => Action[];

declare global {
  /** Helper library injected by the sandbox (same exports as `import ... from "arena"`). */
  const Arena: typeof import("./helpers.js");
}
