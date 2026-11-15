import type { BotState, Dir, Memory, Pos, UpgradeType } from "./api";

export declare const DIRS: Record<Dir, Pos>;
export declare const COSTS: Record<
  "worker" | "fighter" | "scout" | "turret" | "wall" | "base",
  { energy: number; crystal: number }
>;
export declare const UPGRADE_COSTS: Record<UpgradeType, { energy: number; crystal: number }>;
export declare function distance(a: Pos, b: Pos): number;
export declare function manhattan(a: Pos, b: Pos): number;
export declare function isAdjacent(a: Pos, b: Pos): boolean;
export declare function nearest<T extends Pos & { id?: number }>(from: Pos, list: readonly T[], filter?: (t: T) => boolean): T | null;
export declare function enemyBasePos(state: BotState): Pos;
export declare function canAfford(state: BotState, what: keyof typeof COSTS, count?: number): boolean;
export declare function rememberMap(state: BotState, memory: Memory): string;
export declare function pathTo(
  state: BotState,
  from: Pos,
  to: Pos,
  options?: { map?: string; avoid?: Pos[] },
): Array<Pos & { dir: Dir }>;
export declare function freeNeighbors(state: BotState, p: Pos): Pos[];
export declare function inSafeZone(state: BotState, p: Pos, margin?: number): boolean;
