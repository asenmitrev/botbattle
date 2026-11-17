// Effective stats of units and structures: base stats from CONFIG combined with upgrade effects.
// Rules never read CONFIG.upgrades effect fields or test `upgraded` themselves; they ask here.

import { CONFIG, type BuildType, type StructureType, type UnitType, type UpgradeEffect, type UpgradeType } from "./config.js";

type EntityType = UnitType | StructureType;

/** Anything with a type and an upgrade flag: a unit, a structure, or a stand-in for one about to be made. */
export interface Upgradable {
  type: EntityType;
  upgraded: boolean;
}

const NO_EFFECT: UpgradeEffect = {};

export function isUnitType(type: string): type is UnitType {
  return Object.hasOwn(CONFIG.units, type);
}

export function hasUpgradeType(type: string): type is UpgradeType {
  return Object.hasOwn(CONFIG.upgrades, type);
}

/** The upgrade effect active on an entity (empty when it isn't upgraded). */
export function upgradeEffect(e: Upgradable): UpgradeEffect {
  return e.upgraded && hasUpgradeType(e.type) ? CONFIG.upgrades[e.type] : NO_EFFECT;
}

/** Spawn or build cost and HP of anything a player can make. */
export function buildSpec(type: BuildType): { costEnergy: number; costCrystal: number; hp: number; maxDistFromBase: number } {
  return type === "base" ? CONFIG.base : CONFIG.structures[type];
}

export function maxHp(e: Upgradable): number {
  const hp = isUnitType(e.type) ? CONFIG.units[e.type].hp : CONFIG.structures[e.type].hp;
  return hp * (upgradeEffect(e).hpMultiplier ?? 1);
}

export function unitSpeed(u: { type: UnitType; upgraded: boolean }): number {
  return CONFIG.units[u.type].speed * (upgradeEffect(u).speedMultiplier ?? 1);
}

export function turretImmune(u: { type: UnitType; upgraded: boolean }): boolean {
  return upgradeEffect(u).turretImmune === true;
}

export function cargoCapacity(type: UnitType): number {
  return CONFIG.units[type].carry;
}

/** A unit's worth for scoring: its spawn cost with each resource weighted. */
export function unitValue(type: UnitType): number {
  const u = CONFIG.units[type];
  return u.costEnergy * CONFIG.score.energyWeight + u.costCrystal * CONFIG.score.crystalWeight;
}
