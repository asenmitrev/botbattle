// Effective stats of races, units and structures: base stats from CONFIG combined with upgrade effects.
// Rules never read CONFIG.upgrades effect fields or test `upgrades` themselves; they ask here.

import { CONFIG, DEFAULT_RACE, type BuildType, type Race, type StructureType, type UnitType, type UpgradeEffect, type UpgradeType } from "./config.js";

type EntityType = UnitType | StructureType;

/** Anything with a type and its upgrades: a unit, a structure, or a stand-in for one about to be made. */
export interface Upgradable {
  type: EntityType;
  upgrades: readonly UpgradeType[];
}

export interface BaseSpec {
  costEnergy: number;
  costCrystal: number;
  hp: number;
  vision: number;
  damage: number;
  range: number;
  maxDistFromBase: number;
}

export function isUnitType(type: string): type is UnitType {
  return Object.hasOwn(CONFIG.units, type);
}

export function hasUpgradeType(type: string): type is UpgradeType {
  return Object.hasOwn(CONFIG.upgrades, type);
}

export function isRace(v: unknown): v is Race {
  return typeof v === "string" && Object.hasOwn(CONFIG.races, v);
}

/**
 * A bot module's `race` export: DEFAULT_RACE when absent, the race when valid, else an error message.
 * Every loader (sandbox, CLI, playground) uses this, so a bad export fails the same way everywhere.
 */
export function parseRaceExport(v: unknown): { race: Race } | { error: string } {
  if (v === undefined) return { race: DEFAULT_RACE };
  if (isRace(v)) return { race: v };
  return { error: `unknown race ${JSON.stringify(v)?.slice(0, 40)} (use one of: ${Object.keys(CONFIG.races).join(", ")})` };
}

/** The race's base: the classic Base or the Tumor Cell. */
export function baseSpec(race: Race): BaseSpec {
  return CONFIG.races[race].base;
}

export function raceHasUnit(race: Race, type: UnitType): boolean {
  return (CONFIG.races[race].units as readonly string[]).includes(type);
}

export function raceHasUpgrade(race: Race, up: UpgradeType): boolean {
  return (CONFIG.races[race].upgrades as readonly string[]).includes(up);
}

/** Whether a worker of this race may `build` this (a structure of the race, or a base if the race builds them). */
export function raceCanBuild(race: Race, type: BuildType): boolean {
  if (type === "base") return CONFIG.races[race].buildBase;
  return (CONFIG.races[race].structures as readonly string[]).includes(type);
}

/** The upgrades (of the ones a player owns) that change entities of `type`. */
export function upgradesFor(type: EntityType, owned: readonly UpgradeType[]): UpgradeType[] {
  return owned.filter((up) => CONFIG.upgrades[up].appliesTo === type);
}

/** Effects of a list of upgrades, combined (multipliers multiply, bonuses add, flags OR). */
function combined(ups: readonly UpgradeType[]): Required<UpgradeEffect> {
  const out: Required<UpgradeEffect> = {
    speedMultiplier: 1,
    hpMultiplier: 1,
    turretImmune: false,
    rangeBonus: 0,
    unleashed: false,
    buildRangeMultiplier: 1,
    energyPerTick: 0,
  };
  for (const up of ups) {
    const e: UpgradeEffect = CONFIG.upgrades[up];
    out.speedMultiplier *= e.speedMultiplier ?? 1;
    out.hpMultiplier *= e.hpMultiplier ?? 1;
    out.turretImmune ||= e.turretImmune === true;
    out.rangeBonus += e.rangeBonus ?? 0;
    out.unleashed ||= e.unleashed === true;
    out.buildRangeMultiplier *= e.buildRangeMultiplier ?? 1;
    out.energyPerTick += e.energyPerTick ?? 0;
  }
  return out;
}

/** Spawn or build cost, HP and placement limit of anything a player can make. */
export function buildSpec(type: BuildType, race: Race): { costEnergy: number; costCrystal: number; hp: number; maxDistFromBase: number } {
  return type === "base" ? baseSpec(race) : CONFIG.structures[type];
}

export function maxHp(e: Upgradable): number {
  const hp = isUnitType(e.type) ? CONFIG.units[e.type].hp : CONFIG.structures[e.type].hp;
  return hp * combined(e.upgrades).hpMultiplier;
}

export function unitSpeed(u: { type: UnitType; upgrades: readonly UpgradeType[] }): number {
  return CONFIG.units[u.type].speed * combined(u.upgrades).speedMultiplier;
}

export function turretImmune(u: { type: UnitType; upgrades: readonly UpgradeType[] }): boolean {
  return combined(u.upgrades).turretImmune;
}

export function attackRange(u: { type: UnitType; upgrades: readonly UpgradeType[] }): number {
  return CONFIG.units[u.type].range + combined(u.upgrades).rangeBonus;
}

/** How far (Chebyshev) the unit may stray from its nearest living friendly base; Infinity when it has no leash. */
export function leash(u: { type: UnitType; upgrades: readonly UpgradeType[] }): number {
  return combined(u.upgrades).unleashed ? Infinity : CONFIG.units[u.type].leash;
}

/** A structure's placement limit for a player, after their upgrades (Infinity stays Infinity). */
export function placementRange(type: BuildType, race: Race, owned: readonly UpgradeType[]): number {
  return buildSpec(type, race).maxDistFromBase * combined(owned.filter((up) => CONFIG.upgrades[up].appliesTo === null)).buildRangeMultiplier;
}

/** Energy a player's upgrades add to their bank every tick. */
export function passiveEnergy(owned: readonly UpgradeType[]): number {
  return combined(owned.filter((up) => CONFIG.upgrades[up].appliesTo === null)).energyPerTick;
}

export function cargoCapacity(type: UnitType): number {
  return CONFIG.units[type].carry;
}

/** A unit's worth for scoring: its spawn cost with each resource weighted. */
export function unitValue(type: UnitType): number {
  const u = CONFIG.units[type];
  return u.costEnergy * CONFIG.score.energyWeight + u.costCrystal * CONFIG.score.crystalWeight;
}
