// README.md is the one document with all the rules. Its numbers are tied to the code with markers that
// this script fills in (a test fails while README.md is stale; `pnpm readme` rewrites it):
//
//   <!--v match.unitCap-->40<!--/v-->      a value: any JS expression over the names in SOURCES
//   <!--table units-->…<!--/table-->        a whole table from TABLES
//
// The markers are HTML comments, so they are invisible on GitHub; the viewer strips them before showing
// or copying the README (stripMarkers).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, CONFIG_VERSION, STRUCTURE_TYPES, UNIT_TYPES, UPGRADE_TYPES, NODE_TYPES, type UpgradeEffect } from "../engine/src/index.js";
import { ECON } from "../server/src/economy.js";
import { ELO } from "../server/src/elo.js";
import { MAX_CODE_BYTES } from "../server/src/ladder.js";
import { PLAYOFF } from "../server/src/playoff.js";
import { SEASON_MIN_ELO } from "../server/src/seasons.js";

export const README_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../README.md");

/** Names a `<!--v …-->` expression can use: every CONFIG section, plus the ladder constants. */
const SOURCES: Record<string, unknown> = { ...CONFIG, CONFIG, CONFIG_VERSION, ECON, ELO, PLAYOFF, SEASON_MIN_ELO, MAX_CODE_BYTES };

function evaluate(expr: string): string {
  const names = Object.keys(SOURCES);
  let v: unknown;
  try {
    v = new Function(...names, `return (${expr});`)(...names.map((n) => SOURCES[n]));
  } catch (e) {
    throw new Error(`README marker <!--v ${expr}-->: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(", ");
  throw new Error(`README marker <!--v ${expr}--> is ${String(v)}, not a number or string`);
}

const title = (t: string) => t[0]!.toUpperCase() + t.slice(1);
const cost = (c: { costEnergy: number; costCrystal: number }) =>
  [c.costEnergy ? `${c.costEnergy} E` : "", c.costCrystal ? `${c.costCrystal} C` : ""].filter(Boolean).join(" + ") || "free";
const row = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;

function effectText(type: string, e: UpgradeEffect): string {
  const base = (UNIT_TYPES as readonly string[]).includes(type)
    ? CONFIG.units[type as keyof typeof CONFIG.units]
    : CONFIG.structures[type as keyof typeof CONFIG.structures];
  const parts: string[] = [];
  if (e.speedMultiplier) parts.push(`speed ${(base as { speed: number }).speed} → ${(base as { speed: number }).speed * e.speedMultiplier}`);
  if (e.hpMultiplier) parts.push(`max HP ${base.hp} → ${base.hp * e.hpMultiplier}`);
  if (e.turretImmune) parts.push("immune to turrets: they never target it and shoot other units instead");
  return parts.join("; ");
}

const TABLES: Record<string, () => string[]> = {
  units: () => [
    row(["Unit", "Cost", "HP", "Speed", "Vision", "Attack", "Carry", "Harvest", "Builds"]),
    row(Array(9).fill("---")),
    ...UNIT_TYPES.map((t) => {
      const u = CONFIG.units[t];
      return row([
        title(t),
        cost(u),
        u.hp,
        u.speed,
        u.vision,
        u.damage ? `${u.damage} dmg, range ${u.range}` : "–",
        u.carry || "–",
        u.harvest ? `${u.harvest}/tick` : "–",
        u.canBuild ? "yes" : "–",
      ]);
    }),
  ],
  structures: () => [
    row(["Structure", "Cost", "HP", "Vision", "Attack", "Placement"]),
    row(Array(6).fill("---")),
    ...STRUCTURE_TYPES.map((t) => {
      const s = CONFIG.structures[t];
      return row([
        title(t),
        cost(s),
        s.hp,
        s.vision || "–",
        s.damage ? `${s.damage} dmg, range ${s.range} (automatic)` : "–",
        Number.isFinite(s.maxDistFromBase) ? `within ${s.maxDistFromBase} of a living friendly base` : "anywhere",
      ]);
    }),
    row(["Base", cost(CONFIG.base), CONFIG.base.hp, CONFIG.base.vision, "–", "anywhere"]),
  ],
  upgrades: () => [
    row(["Upgrade", "Cost", "Effect"]),
    row(["---", "---", "---"]),
    ...UPGRADE_TYPES.map((t) => row([title(t), cost(CONFIG.upgrades[t]), effectText(t, CONFIG.upgrades[t])])),
  ],
  nodes: () => [
    row(["Node", "Amount", "Regeneration"]),
    row(["---", "---", "---"]),
    ...NODE_TYPES.map((t) => {
      const n = CONFIG.nodes[t];
      return row([title(t), n.amount, n.regen ? `+${n.regen} per tick, up to ${n.max}` : "none"]);
    }),
  ],
  limits: () => {
    const b = CONFIG.bot;
    return [
      row(["Limit", "Value", "If exceeded"]),
      row(["---", "---", "---"]),
      row(["CPU per tick", `${b.tickCpuMs} ms on average; unused CPU is banked up to ${b.cpuBankMs} ms (the bank starts full)`, `the tick fails if it uses more than ${b.tickCpuMs} ms + the bank`]),
      row(["Wall clock per tick", `${b.tickWallMs} ms`, "the tick fails (this is what stops infinite loops)"]),
      row(["Top-level module code", `${b.initMs} ms, once`, "the bot can't start and fails every tick"]),
      row(["Heap", `${b.isolateMemoryMb} MB`, "the tick fails and the sandbox restarts with the last good `memory`"]),
      row(["`memory` (as JSON)", `${b.memoryLimitBytes / 1024} KB`, "the tick fails and `memory` reverts to the previous tick"]),
      row(["Returned actions + memory", `${b.outputLimitBytes / 1024 / 1024} MB`, "the tick fails"]),
      row(["Actions per tick", b.maxActionsPerTick, "the rest are dropped"]),
      row(["`log` / `mark` actions per tick", `${b.maxLogsPerTick} / ${b.maxMarksPerTick}`, "the rest are dropped"]),
      row(["Failed ticks in a row", b.maxConsecutiveFailures, "the bot forfeits"]),
    ];
  },
};

/** README.md with every marker filled in from the current constants. */
export function renderReadme(src: string): string {
  const withTables = src.replace(/(<!--table (\w+)-->\n)[\s\S]*?(\n<!--\/table-->)/g, (_m, open: string, name: string, close: string) => {
    const make = TABLES[name];
    if (!make) throw new Error(`README: unknown table "${name}"`);
    return open + make().join("\n") + close;
  });
  return withTables.replace(/(<!--v ([^>]+?)-->)[^<]*(<!--\/v-->)/g, (_m, open: string, expr: string, close: string) => open + evaluate(expr) + close);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const src = fs.readFileSync(README_PATH, "utf8");
  const out = renderReadme(src);
  if (out !== src) fs.writeFileSync(README_PATH, out);
  console.log(out === src ? "README.md is up to date" : "README.md updated");
}
