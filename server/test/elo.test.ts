import { describe, expect, it } from "vitest";
import { ELO, expectedScore, kFactor, updateElo } from "../src/elo.js";

describe("elo", () => {
  it("expected score: 0.5 for equals, ~0.909 at +400, symmetric", () => {
    expect(expectedScore(1200, 1200)).toBe(0.5);
    expect(expectedScore(1600, 1200)).toBeCloseTo(10 / 11, 6);
    expect(expectedScore(1350, 1200) + expectedScore(1200, 1350)).toBeCloseTo(1, 12);
  });

  it("K is 40 while provisional (<10 games since version), then 24", () => {
    expect(kFactor(0)).toBe(40);
    expect(kFactor(9)).toBe(40);
    expect(kFactor(10)).toBe(24);
    expect(ELO.initial).toBe(1200);
  });

  it("win/draw/loss updates; zero-sum with equal K", () => {
    expect(updateElo(1200, 1200, 1, 24, 24)).toEqual([1212, 1188]);
    expect(updateElo(1200, 1200, 0.5, 24, 24)).toEqual([1200, 1200]);
    const [a, b] = updateElo(1400, 1200, 0, 24, 24);
    expect(a + b).toBeCloseTo(2600, 9);
    expect(a).toBeLessThan(1400);
    // Upset gains more than an expected win.
    const upset = updateElo(1200, 1400, 1, 24, 24)[0] - 1200;
    const expected = updateElo(1400, 1200, 1, 24, 24)[0] - 1400;
    expect(upset).toBeGreaterThan(expected);
  });

  it("provisional side moves more", () => {
    const [a, b] = updateElo(1200, 1200, 1, 40, 24);
    expect(a - 1200).toBe(20);
    expect(1200 - b).toBe(12);
  });
});
