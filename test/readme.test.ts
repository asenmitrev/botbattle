import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { README_PATH, renderReadme } from "../scripts/readme.js";

describe("README.md", () => {
  it("has every number filled in from the current code (run `pnpm docs` to fix)", () => {
    const src = fs.readFileSync(README_PATH, "utf8");
    expect(renderReadme(src)).toBe(src);
  });
});
