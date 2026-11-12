# Bot Arena — Writing a Bot

> This document is self-contained: you can give it to an LLM and ask it to write a bot.
> Full rules: RULES.md.

## The contract

A bot is a JavaScript module that exports one function:

```js
export function onTick(state, memory) {
  return [ /* actions */ ];
}
```

- It is called once per tick (500 ticks max) with a fog-filtered `state`.
- `memory` is a plain object that persists between ticks. It must be JSON-serializable and stay under 100 KB.
  Mutate it in place. Don't rely on module-level variables, because the runner may reload your module.
- Return an array of actions. Invalid actions are ignored (they're reported in the replay, never fatal).
- **One module, no imports** except the built-in helper library: `import { distance } from "arena"`.
  The helpers are also available everywhere as the global `Arena` (for example, `Arena.nearest(unit, nodes)`).
- **Sandbox**: there is no `require`, `fs`, network, `setTimeout`/timers, `process` or `WebAssembly`, only plain JavaScript.
  `Math.random` works and is seeded per match (reproducible).

### Limits

| Limit | Value | What happens if exceeded |
|---|---|---|
| CPU per tick | 50 ms on average. Unused time is banked (up to 250 ms, starting full), so occasional spikes are fine | the tick fails if it uses more than 50 ms + the bank |
| Top-level module code | 1000 ms, once | the bot cannot start (it forfeits) |
| Heap | 64 MB | the tick fails, and the sandbox restarts with your last good `memory` |
| `memory` size (JSON) | 100 KB | the tick fails, and `memory` reverts to the previous tick |
| Returned actions + memory | 1 MB | the tick fails |

A failed tick (exception, timeout or any of the above) means your bot does nothing that tick.
**10 failed ticks in a row = forfeit.** Module-level variables survive between ticks but are lost when the sandbox
restarts, so keep anything important in `memory`.

### Helper library (`Arena` / `import ... from "arena"`)

| Function | Returns |
|---|---|
| `distance(a, b)` | Chebyshev distance (the range metric; adjacent = 1) |
| `manhattan(a, b)` | 4-directional step count on an open map |
| `isAdjacent(a, b)` | `distance(a, b) === 1` |
| `nearest(from, list, filter?)` | closest item of `list` (ties: Manhattan, then lowest id) |
| `enemyBasePos(state)` | `{x, y}` of the enemy base (the mirror of yours) |
| `canAfford(state, what, count?)` | whether banked resources cover `what` (`"worker"`, `"turret"`, `"armor"`, …) |
| `rememberMap(state, memory)` | accumulates seen terrain in `memory.map` (a string; `?` means unknown) |
| `pathTo(state, from, to, { map?, avoid? })` | BFS path `[{x, y, dir}]` over known terrain; `avoid` adds blocked tiles (e.g. units) |
| `freeNeighbors(state, p)` | free tiles around `p` (8-neighborhood) |
| `inSafeZone(state, p, margin?)` | whether `p` is inside next tick's zone |
| `COSTS`, `DIRS` | cost table; direction → `{x, y}` offset |

## Game in one paragraph

On a 40×40 point-symmetric map, you start with a base (200 HP), 150 energy and 2 workers.
Workers harvest energy nodes (near your base) and crystal nodes (in the contested center),
carry it home and deposit it. Spend energy and crystal on units, structures and upgrades. Destroy the
enemy base to win. Otherwise, at tick 500 the player with **more living units** wins
(any unit type counts as 1; structures don't count). Equal unit counts are broken by **score**:
`energy + 3×crystal + value of living units + 2×base HP`, and equal score is a draw. From tick 400 a safe circle
shrinks toward the center, and anything outside it takes 3 damage per tick (bases are immune).
Both bots act simultaneously.

## Coordinates and distances

- `x` grows East, `y` grows South. Directions are `"N"` (y−1), `"S"` (y+1), `"E"` (x+1) and `"W"` (x−1).
- Your base and the enemy base are point mirrors: `enemyBase = { x: 39 - myBase.x, y: 39 - myBase.y }`.
- **Adjacent** means Chebyshev distance 1 (`max(|dx|,|dy|) === 1`), so diagonals count.
  Harvest, deposit, build and attack all need adjacency (turrets: range 4).
- Movement is 1 orthogonal step per tick (scouts take 2).

## `state`

```ts
{
  tick: number;                     // 0..499
  player: 1 | 2;
  myBase: { id, x, y, hp };
  myUnits: [{ id, type: "worker"|"fighter"|"scout", x, y, hp, maxHp,
              cargo: { energy, crystal }, cargoCapacity }];
  myStructures: [{ id, type: "turret"|"wall", x, y, hp }];
  energy: number; crystal: number;  // banked
  upgrades: { cargo: boolean, armor: boolean, weapons: boolean };
  visibleEnemies: [{ id, kind: "unit"|"structure"|"base", type, x, y, hp }];
  visibleNodes: [{ id, type: "energy"|"crystal", x, y, amount }];
  visibleTiles: [{ x, y, type: "floor"|"wall"|"energy_node"|"crystal_node" }];
  mapSize: 40;
  zone: { x: 19.5, y: 19.5, radius, nextRadius, damage: 3, shrinkStartTick: 400 };
  unitCap: 40; maxTicks: 500;
}
```

You only see what is within vision of your base (7), units (worker/fighter 5, scout 9) and turrets (4).
Remember terrain and nodes in `memory` if you need them later.

## Actions

Each unit gets at most **one** action per tick; extras are ignored.

| Action | Effect |
|---|---|
| `{ type: "move", unitId, dir }` | Step N/S/E/W. |
| `{ type: "moveTo", unitId, x, y }` | Engine takes one shortest-path step toward (x,y) (two for scouts). Avoids terrain/structures, ignores units. If (x,y) is blocked (a node, a base), it stops next to it. |
| `{ type: "harvest", unitId, nodeId }` | Worker adjacent to a node takes up to 5 into cargo. |
| `{ type: "deposit", unitId }` | Worker adjacent to own base banks all cargo. |
| `{ type: "attack", unitId, targetId }` | Fighter hits an adjacent enemy unit, structure or base. |
| `{ type: "build", unitId, structure: "turret"\|"wall", x, y }` | Worker builds on an adjacent empty floor tile. |
| `{ type: "spawn", unit: "worker"\|"fighter"\|"scout" }` | Base spawns next to itself. Max 1 per tick. |
| `{ type: "upgrade", upgrade: "cargo"\|"armor"\|"weapons" }` | One-time global upgrade. |
| `{ type: "log", text }` | Message shown in the replay viewer. |
| `{ type: "mark", x, y, color, label }` | Debug marker drawn in the replay viewer. |

## Costs and stats

| | Cost | HP | Speed | Vision | Notes |
|---|---|---|---|---|---|
| Worker | 50 E | 10 | 1 | 5 | carries 20 (30 with Cargo), harvests 5/tick, builds |
| Fighter | 60 E + 15 C | 30 | 1 | 5 | 6 damage (9 with Weapons), range 1 |
| Scout | 30 E | 5 | 2 | 9 | attack 1 dmg, range 1; cannot carry |
| Turret | 100 E | 50 | – | 4 | auto-shoots lowest-HP enemy unit within 4 for 4 dmg; must be within 8 of your base |
| Wall | 10 E | 40 | – | – | blocks movement |
| Upgrade Cargo | 30 C | | | | |
| Upgrade Armor | 40 C | | | | your units take 2 less damage (min 1) |
| Upgrade Weapons | 40 C | | | | |

Energy nodes hold 600 and regenerate 1/tick. Crystal nodes hold 200 and do not regenerate.
Fighters need crystal, so you must contest the center.

## Resolution order (each tick)

1. Validate actions → 2. upgrades, spawns → 3. movement (simultaneous; units that target the same tile all fail; swaps fail)
→ 4. harvest, deposit, build → 5. combat (simultaneous) → 6. remove dead / check bases
→ 7. node regen, zone damage → 8. vision.

So you can move next to a node and harvest **next** tick, not the same tick, because each unit has one action.

## Minimal working bot (no imports)

```js
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
```

## Tips

- `moveTo` ignores units, so crowds can gridlock. If a unit hasn't moved for a tick or two, step sideways.
- Spawn fighters only once you have crystal, which comes from the center.
- Late game (tick ≥ 400): move units toward the center or lose them to the zone. Bank cargo before the end,
  because undeposited cargo doesn't score.
- Fighters next to the enemy base deal 6 per hit, so a pack of 6 fighters kills a 200 HP base in about 6 ticks.
