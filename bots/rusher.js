// A few workers (some fetching crystal), then a stream of fighters straight at the enemy base.
import { assignNode, crystalWorkerAct, enemyBasePos, fighterAct, observe, workerAct } from "./lib/common.js";

const ENERGY_WORKERS = 2;
const CRYSTAL_WORKERS = 2;

/** @type {import("./lib/api").OnTick} */
export function onTick(state, memory) {
  observe(state, memory);
  memory.role = memory.role || {};
  const actions = [];
  const workers = state.myUnits.filter((u) => u.type === "worker");
  const fighters = state.myUnits.filter((u) => u.type === "fighter");

  // Roles: fill energy first, then crystal.
  const count = (r) => workers.filter((u) => memory.role[u.id] === r).length;
  for (const u of workers) {
    if (memory.role[u.id]) continue;
    memory.role[u.id] = count("energy") < ENERGY_WORKERS ? "energy" : "crystal";
  }

  if (workers.length < ENERGY_WORKERS + CRYSTAL_WORKERS) {
    if (state.energy >= 50) actions.push({ type: "spawn", unit: "worker" });
  } else if (state.energy >= 60 && state.crystal >= 15) {
    actions.push({ type: "spawn", unit: "fighter" });
  }

  for (const u of workers) {
    const a =
      memory.role[u.id] === "crystal"
        ? crystalWorkerAct(state, memory, u)
        : workerAct(state, memory, u, assignNode(state, memory, u, "energy", 2));
    if (a) actions.push(a);
  }
  const target = enemyBasePos(state);
  for (const u of fighters) {
    const a = fighterAct(state, memory, u, target, "base");
    if (a) actions.push(a);
  }
  return actions;
}
