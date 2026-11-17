// Type definitions for the Bot Arena bot API, taken straight from the engine so they can't drift.
// Use with JSDoc:
//   /** @type {import("./lib/api").OnTick} */
//   export function onTick(state, memory) { ... }

import type { Action, BotState } from "../../engine/src/index.js";

export type {
  Action,
  BotEnemy as Enemy,
  BotNode as VisibleNode,
  BotState,
  BotStructure as MyStructure,
  BotTile as VisibleTile,
  BotUnit as MyUnit,
  BuildType,
  Dir,
  NodeType,
  PlayerId,
  Pos,
  StructureType,
  TileType,
  UnitType,
  UpgradeType,
} from "../../engine/src/index.js";

export type Zone = BotState["zone"];

/** JSON-serializable, persisted between ticks (size limit: CONFIG.bot.memoryLimitBytes). */
export type Memory = Record<string, any>;

export type OnTick = (state: BotState, memory: Memory) => Action[];

declare global {
  /** Helper library injected by the sandbox (same exports as `import ... from "arena"`). */
  const Arena: typeof import("./helpers.js");
}
