// Single source of game constants. RULES.md must stay in sync with this file.
// Bump CONFIG_VERSION whenever any value below changes (replays record it).

export const CONFIG_VERSION = "2.1.0";

export const CONFIG = {
  map: {
    size: 40,
    /** Base position for player 1; player 2 is the point mirror (size-1-x, size-1-y). */
    baseP1: { x: 4, y: 4 },
    /** Tiles within this Chebyshev radius of a base are forced to floor. */
    baseClearRadius: 2,
    energyNodesPerSide: 4,
    energyNodeMinDist: 3,
    energyNodeMaxDist: 8,
    /** Crystal nodes come in mirrored pairs, so the count is 2 or 4. */
    crystalPairsMin: 1,
    crystalPairsMax: 2,
    /** Crystal nodes are placed within this Euclidean radius of the map center. */
    crystalCenterRadius: 7,
    /** Fraction of tiles seeded as wall before smoothing. */
    wallDensity: 0.22,
    smoothingPasses: 2,
    maxGenerationAttempts: 200,
  },

  match: {
    maxTicks: 500,
    startEnergy: 150,
    startCrystal: 0,
    startWorkers: 2,
    unitCap: 40,
  },

  base: { costEnergy: 100, costCrystal: 50, hp: 200, vision: 7, maxDistFromBase: Infinity },

  units: {
    worker: { costEnergy: 50, costCrystal: 0, hp: 10, speed: 1, vision: 5, carry: 20, harvest: 5, damage: 0, range: 0 },
    fighter: { costEnergy: 60, costCrystal: 15, hp: 30, speed: 1, vision: 5, carry: 0, harvest: 0, damage: 6, range: 1 },
    scout: { costEnergy: 30, costCrystal: 0, hp: 5, speed: 2, vision: 9, carry: 0, harvest: 0, damage: 1, range: 1 },
  },

  structures: {
    turret: { costEnergy: 100, costCrystal: 0, hp: 50, damage: 4, range: 4, vision: 4, maxDistFromBase: 8 },
    wall: { costEnergy: 3, costCrystal: 0, hp: 60, damage: 0, range: 0, vision: 0, maxDistFromBase: Infinity },
  },

  nodes: {
    energy: { amount: 600, max: 600, regen: 1 },
    crystal: { amount: 200, max: 200, regen: 0 },
  },

  /**
   * Per-type upgrades, keyed by the unit/structure type they apply to. Bought once per player; applies to
   * all of that player's entities of the type, current and future.
   */
  upgrades: {
    /** Doubles the scout's speed and max HP. */
    scout: { costEnergy: 0, costCrystal: 15, speedMultiplier: 2, hpMultiplier: 2 },
    /** Doubles the wall's max HP. */
    wall: { costEnergy: 50, costCrystal: 0, hpMultiplier: 2 },
    /** Turrets ignore the fighter (no turret damage). */
    fighter: { costEnergy: 0, costCrystal: 20 },
  },

  zone: {
    startTick: 400,
    shrinkEvery: 4,
    shrinkAmount: 1,
    /** Covers the whole 40x40 map (corner distance from center ≈ 27.6). */
    initialRadius: 28,
    damage: 3,
  },

  score: {
    energyWeight: 1,
    crystalWeight: 3,
    unitValueWeight: 1,
    baseHpWeight: 2,
  },

  bot: {
    /** Sandbox: isolate heap limit. */
    isolateMemoryMb: 64,
    /** Sandbox: average CPU time a bot may use per tick (measured with the isolate's CPU clock). */
    tickCpuMs: 50,
    /**
     * Sandbox: unused CPU is banked up to this cap (the bank starts full). A tick fails only when it
     * uses more than tickCpuMs + bank, so rare spikes (GC, JIT warm-up, a loaded host) don't cost
     * a legitimate bot its turn, while sustained overuse still fails within a few ticks.
     */
    cpuBankMs: 250,
    /**
     * Sandbox: hard wall-clock cutoff per tick (kills infinite loops). Above the most CPU a tick may
     * legitimately use (tickCpuMs + cpuBankMs = 300 ms), so a bot isn't killed just because a loaded
     * host (parallel ladder games) paused its thread; the CPU budget is the real limit.
     */
    tickWallMs: 500,
    /** Sandbox: one-time budget for module evaluation (top-level code). */
    initMs: 1000,
    /** Max size of the serialized result (actions + memory) a bot may return per tick. */
    outputLimitBytes: 1024 * 1024,
    maxConsecutiveFailures: 10,
    memoryLimitBytes: 100 * 1024,
    maxActionsPerTick: 300,
    maxLogsPerTick: 20,
    maxMarksPerTick: 50,
    maxLogLength: 200,
  },

  replay: { snapshotEvery: 25 },
} as const;

export type Config = typeof CONFIG;
export type UnitType = keyof Config["units"];
export type StructureType = keyof Config["structures"];
export type BuildType = StructureType | "base";
export type UpgradeType = keyof Config["upgrades"];
export type NodeType = keyof Config["nodes"];

export const UNIT_TYPES: readonly UnitType[] = ["worker", "fighter", "scout"];
export const STRUCTURE_TYPES: readonly StructureType[] = ["turret", "wall"];
export const BUILD_TYPES: readonly BuildType[] = [...STRUCTURE_TYPES, "base"];
/** Unit/structure types that have an upgrade. */
export const UPGRADE_TYPES: readonly UpgradeType[] = ["scout", "wall", "fighter"];
