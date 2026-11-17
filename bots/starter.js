// Starter bot — identical to the example in README.md (kept in sync by a test).
export function onTick(state, memory) {
  const actions = [];
  const adj = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) === 1;
  const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const base = state.myBase;
  const workers = state.myUnits.filter(u => u.type === "worker");
  // Stop investing before the zone starts eating units near the base.
  if (workers.length < 8 && state.energy >= 50 && state.tick < 380) actions.push({ type: "spawn", unit: "worker" });

  // Units that tried to move last tick but didn't are "stuck": sidestep instead.
  const last = memory.last || {};
  memory.last = {};
  const go = (u, x, y) => {
    const prev = last[u.id];
    memory.last[u.id] = { x: u.x, y: u.y };
    if (prev && prev.x === u.x && prev.y === u.y && (state.tick + u.id) % 3 !== 0) {
      return { type: "move", unitId: u.id, dir: "NESW"[(state.tick + u.id) % 4] };
    }
    return { type: "moveTo", unitId: u.id, x, y };
  };

  const nodes = state.visibleNodes.filter(n => n.type === "energy" && n.amount >= 5)
    .sort((a, b) => dist(a, base) - dist(b, base));
  const left = {}; // what each node still holds after harvests already queued this tick
  workers.forEach((u, i) => {
    const carried = u.cargo.energy + u.cargo.crystal;
    if (carried >= u.cargoCapacity || (carried > 0 && !nodes.length)) {
      actions.push(adj(u, base) ? { type: "deposit", unitId: u.id } : go(u, base.x, base.y));
      return;
    }
    const node = nodes[i % Math.max(1, nodes.length)];
    if (!node) return;
    if (!adj(u, node)) return actions.push(go(u, node.x, node.y));
    const amount = left[node.id] ?? node.amount;
    if (amount <= 0) return;
    left[node.id] = amount - 5;
    actions.push({ type: "harvest", unitId: u.id, nodeId: node.id });
  });
  return actions;
}
