import { describe, expect, it } from "vitest";
import { BUILD_TYPES, CONFIG, UNIT_TYPES, buildSpec } from "../../engine/src/index.js";
// helpers.js runs inside the bot sandbox and can't import the engine, so its tables are copies.
import { COSTS, UPGRADE_COSTS } from "../lib/helpers.js";

const cost = (c: { costEnergy: number; costCrystal: number }) => ({ energy: c.costEnergy, crystal: c.costCrystal });

describe("bot helper library", () => {
  it("COSTS matches CONFIG for every unit, structure and base", () => {
    const expected = Object.fromEntries([
      ...UNIT_TYPES.map((t) => [t, cost(CONFIG.units[t])]),
      ...BUILD_TYPES.map((t) => [t, cost(buildSpec(t))]),
    ]);
    expect(COSTS).toEqual(expected);
  });

  it("UPGRADE_COSTS matches CONFIG.upgrades", () => {
    const expected = Object.fromEntries(Object.entries(CONFIG.upgrades).map(([t, u]) => [t, cost(u)]));
    expect(UPGRADE_COSTS).toEqual(expected);
  });
});
