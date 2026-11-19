// Single source of game constants. The stat tables in README.md are generated from this file
// (`pnpm readme`; a test fails while they are stale). Bump CONFIG_VERSION whenever any value below
// or any rule in step.ts changes: replays record it and only replay under the same version.

export const CONFIG_VERSION = "4.9.0";

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
    /**
     * Crystal nodes can land anywhere on the map, but at least this Euclidean distance from both
     * starting bases (beyond energyNodeMaxDist, so crystal is never part of a base's home cluster).
     */
    crystalMinBaseDist: 10,
    /** Minimum Chebyshev distance between a crystal node and any other node (its mirror twin included). */
    crystalMinSpacing: 3,
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

  /**
   * Races. A bot picks one with `export const race = "tumor"` (default "classic"). Each race has its own
   * base (the building that deposits, spawns and must survive), the units, structures and upgrades it may
   * use, and its worker type (what each player starts with). `buildBase`: workers can `build` a base;
   * otherwise a unit with `canTransform` turns itself into one with `transform`.
   */
  races: {
    classic: {
      base: { costEnergy: 100, costCrystal: 50, hp: 200, vision: 7, damage: 0, range: 0, maxDistFromBase: Infinity },
      worker: "worker",
      units: ["worker", "fighter", "scout"],
      structures: ["turret", "wall"],
      upgrades: ["scout", "wall", "fighter"],
      buildBase: true,
    },
    tumor: {
      /** The Tumor Cell. It shoots the lowest-HP enemy unit in range, like a turret (and skips upgraded fighters). */
      base: { costEnergy: 75, costCrystal: 0, hp: 50, vision: 10, damage: 1, range: 3, maxDistFromBase: Infinity },
      worker: "stemCell",
      units: ["stemCell", "immuneCell"],
      structures: ["purificationCell", "siegeCell"],
      upgrades: ["tumorSpeed", "photosynthesis", "freedom", "toxic"],
      buildBase: false,
    },
  },

  /**
   * Every unit of every race. `leash`: the unit can't step farther than this (Chebyshev) from its nearest
   * living friendly base, except to step back toward one. `canTransform`: `transform` turns the unit into a
   * base of its race, on its own tile.
   */
  units: {
    worker: { costEnergy: 50, costCrystal: 0, hp: 10, speed: 1, vision: 5, carry: 20, harvest: 5, damage: 0, range: 0, canBuild: true, canTransform: false, leash: Infinity },
    fighter: { costEnergy: 60, costCrystal: 15, hp: 30, speed: 1, vision: 5, carry: 0, harvest: 0, damage: 6, range: 1, canBuild: false, canTransform: false, leash: Infinity },
    scout: { costEnergy: 30, costCrystal: 0, hp: 5, speed: 2, vision: 9, carry: 0, harvest: 0, damage: 1, range: 1, canBuild: false, canTransform: false, leash: Infinity },
    stemCell: { costEnergy: 25, costCrystal: 0, hp: 5, speed: 1, vision: 5, carry: 10, harvest: 5, damage: 0, range: 0, canBuild: true, canTransform: true, leash: Infinity },
    immuneCell: { costEnergy: 0, costCrystal: 15, hp: 20, speed: 2, vision: 5, carry: 0, harvest: 0, damage: 3, range: 1, canBuild: false, canTransform: false, leash: 8 },
  },

  /**
   * Every structure of every race. `targets`: what its automatic attack shoots ("units": the lowest-HP enemy
   * unit; "buildings": the lowest-HP enemy structure or base). `heal`: HP restored per tick to every friendly
   * unit, structure and base within `range` (heals don't stack: one healer per target per tick). `maxDistFromBase`: placement limit from a living friendly base.
   */
  structures: {
    turret: { costEnergy: 100, costCrystal: 0, hp: 50, damage: 4, range: 4, vision: 4, maxDistFromBase: 8, targets: "units", heal: 0 },
    wall: { costEnergy: 3, costCrystal: 0, hp: 60, damage: 0, range: 0, vision: 0, maxDistFromBase: Infinity, targets: "none", heal: 0 },
    purificationCell: { costEnergy: 50, costCrystal: 0, hp: 100, damage: 0, range: 5, vision: 10, maxDistFromBase: 8, targets: "none", heal: 1 },
    siegeCell: { costEnergy: 75, costCrystal: 0, hp: 100, damage: 1, range: 6, vision: 16, maxDistFromBase: 8, targets: "buildings", heal: 0 },
  },

  nodes: {
    energy: { amount: 600, max: 600, regen: 1 },
    crystal: { amount: 200, max: 200, regen: 0 },
  },

  /**
   * Upgrades, by name. Bought once per player, and only by a player whose race lists it. One with
   * `appliesTo` changes every one of the player's entities of that type, current and future; one without
   * changes the player. The effect fields are UpgradeEffect (below); rules read them only through stats.ts,
   * so a new upgrade is a config entry, not a new `if`.
   */
  upgrades: {
    scout: { appliesTo: "scout", costEnergy: 0, costCrystal: 15, speedMultiplier: 2, hpMultiplier: 2 },
    wall: { appliesTo: "wall", costEnergy: 50, costCrystal: 0, hpMultiplier: 2 },
    fighter: { appliesTo: "fighter", costEnergy: 0, costCrystal: 20, turretImmune: true },
    tumorSpeed: { appliesTo: null, costEnergy: 100, costCrystal: 0, buildRangeMultiplier: 2 },
    photosynthesis: { appliesTo: null, costEnergy: 0, costCrystal: 20, energyPerTick: 3 },
    freedom: { appliesTo: "immuneCell", costEnergy: 150, costCrystal: 0, unleashed: true },
    toxic: { appliesTo: "immuneCell", costEnergy: 0, costCrystal: 20, rangeBonus: 1 },
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
export type Race = keyof Config["races"];
export type UnitType = keyof Config["units"];
export type StructureType = keyof Config["structures"];
export type BuildType = StructureType | "base";
/** An upgrade's name (for the classic race, the type it upgrades). */
export type UpgradeType = keyof Config["upgrades"];
export type NodeType = keyof Config["nodes"];

/** What an upgrade may do. Every field is optional; a missing one means "no change". */
export interface UpgradeEffect {
  /** Multiplies the unit's speed. */
  speedMultiplier?: number;
  /** Multiplies max HP (current HP rises by the same amount when bought). */
  hpMultiplier?: number;
  /** No building attacks it: turrets and Tumor Cells never target this unit (Siege Cells only shoot buildings). */
  turretImmune?: boolean;
  /** Adds to the unit's attack range. */
  rangeBonus?: number;
  /** Removes the unit's leash. */
  unleashed?: boolean;
  /** Player upgrade: multiplies every structure's maxDistFromBase. */
  buildRangeMultiplier?: number;
  /** Player upgrade: energy added to the bank every tick. */
  energyPerTick?: number;
}
// Compile-time checks: every upgrade entry is a target and a cost plus UpgradeEffect fields and nothing
// else, and every race lists only real units, structures and upgrades.
type Exact<T, Shape> = T extends Shape ? (Exclude<keyof T, keyof Shape> extends never ? T : never) : never;
type UpgradeEntry = UpgradeEffect & { appliesTo: UnitType | StructureType | null; costEnergy: number; costCrystal: number };
const _upgradesAreEffects: { [K in UpgradeType]: Exact<Config["upgrades"][K], UpgradeEntry> } = CONFIG.upgrades;
void _upgradesAreEffects;
interface RaceEntry { worker: UnitType; units: readonly UnitType[]; structures: readonly StructureType[]; upgrades: readonly UpgradeType[] }
const _racesAreValid: { [K in Race]: RaceEntry } = CONFIG.races;
void _racesAreValid;

const keys = <T extends object>(o: T) => Object.keys(o) as (keyof T & string)[];
export const UNIT_TYPES: readonly UnitType[] = keys(CONFIG.units);
export const STRUCTURE_TYPES: readonly StructureType[] = keys(CONFIG.structures);
export const BUILD_TYPES: readonly BuildType[] = [...STRUCTURE_TYPES, "base"];
/** Every upgrade name. */
export const UPGRADE_TYPES: readonly UpgradeType[] = keys(CONFIG.upgrades);
export const RACES: readonly Race[] = keys(CONFIG.races);
export const DEFAULT_RACE: Race = "classic";
export const NODE_TYPES: readonly NodeType[] = keys(CONFIG.nodes);
