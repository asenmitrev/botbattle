// Pure economy: only workers, every worker harvests energy as fast as possible.
import { assignNode, observe, workerAct } from "./lib/common.js";

const MAX_WORKERS = 14;

/** @type {import("./lib/api").OnTick} */
export function onTick(state, memory) {
  observe(state, memory);
  const actions = [];
  const workers = state.myUnits.filter((u) => u.type === "worker");
  const ticksLeft = state.maxTicks - state.tick;
  if (workers.length < MAX_WORKERS && state.energy >= 50 && ticksLeft > 40 && state.tick < state.zone.shrinkStartTick - 20) {
    actions.push({ type: "spawn", unit: "worker" });
  }
  for (const u of workers) {
    const node = assignNode(state, memory, u, "energy", 3);
    const a = workerAct(state, memory, u, node);
    if (a) actions.push(a);
  }
  return actions;
}
