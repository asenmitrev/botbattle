# Bot Arena

Bot Arena is a programmable 1v1 strategy game. You write a bot, a single function
`onTick(state, memory) → actions`, and it fights other bots on a fog-of-war map: harvesting resources,
spawning units, building structures and trying to destroy the enemy's bases.

This file is the whole manual and the only rules document. It is self-contained: you can hand it to an LLM
and ask for a bot. Every number in it comes from `engine/src/config.ts` (or, for the ladder, the server's
constants) and is checked by a test.

**Rules version <!--v CONFIG_VERSION-->4.10.0<!--/v-->** (`CONFIG_VERSION`; replays record it).

## Writing a bot

A bot is a JavaScript module that exports one function:

```js
export function onTick(state, memory) {
  return [ /* actions */ ];
}
```

- It is called once per tick with a fog-filtered `state` (see [Bot API](#bot-api)).
- **Race**: a bot plays the classic race unless it also exports `export const race = "tumor";` (see
  [Races](#races)). Any other value fails the bot at load.
- `memory` is a plain object that persists between ticks. Mutate it in place. It must be JSON-serializable.
  Module-level variables survive between ticks but are lost when the sandbox restarts, so keep anything
  important in `memory`.
- Return an array of actions. Invalid actions are ignored: they're reported in the replay, never fatal.
- **One module, no imports** except the built-in helper library: `import { distance } from "arena"`.
  The helpers are also available everywhere as the global `Arena` (for example, `Arena.nearest(unit, nodes)`).
- **Sandbox**: official matches run each bot in its own `isolated-vm` isolate. There is no `require`, `fs`,
  network, timers, `process`, `WebAssembly`, `Atomics` or `SharedArrayBuffer`, only plain JavaScript.
  `Math.random` works and is seeded from the match seed and player, so matches are reproducible.

### Limits

<!--table limits-->
| Limit | Value | If exceeded |
| --- | --- | --- |
| CPU per tick | 50 ms on average; unused CPU is banked up to 250 ms (the bank starts full) | the tick fails if it uses more than 50 ms + the bank |
| Wall clock per tick | 500 ms | the tick fails (this is what stops infinite loops) |
| Top-level module code | 1000 ms, once | the bot can't start and fails every tick |
| Heap | 64 MB | the tick fails and the sandbox restarts with the last good `memory` |
| `memory` (as JSON) | 100 KB | the tick fails and `memory` reverts to the previous tick |
| Returned actions + memory | 1 MB | the tick fails |
| Actions per tick | 300 | the rest are dropped |
| `log` / `mark` actions per tick | 20 / 50 | the rest are dropped |
| Failed ticks in a row | 10 | the bot forfeits |
<!--/table-->

CPU is measured on the isolate's own CPU clock, so a busy host doesn't cost a bot its turn. A **failed tick**
is any exception, timeout, CPU overrun, oversized memory or output, or non-serializable result: the bot's
actions are discarded (it does nothing that tick), its memory reverts to the last good tick, and a `bot_error`
is recorded in the replay. If both bots keep failing, play continues with both idle.

### Helper library (`Arena` / `import ... from "arena"`)

| Function | Returns |
|---|---|
| `distance(a, b)` | Chebyshev distance (the range metric; adjacent = 1) |
| `manhattan(a, b)` | 4-directional step count on an open map |
| `isAdjacent(a, b)` | `distance(a, b) === 1` |
| `nearest(from, list, filter?)` | closest item of `list` (ties: Manhattan, then lowest id) |
| `enemyBasePos(state)` | `{x, y}` of the enemy starting base (the mirror of `startingBase`); expansions must be scouted |
| `canAfford(state, what, count?)` | whether banked resources cover `what` (`"worker"`, `"turret"`, `"base"`, …) |
| `rememberMap(state, memory)` | accumulates seen terrain in `memory.map` (a string; `?` means unknown) |
| `pathTo(state, from, to, { map?, avoid? })` | BFS path `[{x, y, dir}]` over known terrain; `avoid` adds blocked tiles (e.g. units) |
| `freeNeighbors(state, p)` | free tiles around `p` (8-neighborhood) |
| `inSafeZone(state, p, margin?)` | whether `p` is inside next tick's zone |
| `COSTS`, `UPGRADE_COSTS`, `DIRS` | spawn/build costs; upgrade costs keyed by the upgraded type; direction → `{x, y}` offset |

## Rules

### Overview

Two bots play a 1v1 match. Each tick both bots receive a fog-filtered view of the game and return a list of
actions. The engine then resolves both players' actions **simultaneously**: there is no turn-order advantage.
Destroy all enemy bases to win, or have more living units when time runs out.

The simulation is deterministic: the same seed and the same bot actions always produce the identical match.

### Distances and directions

| Metric | Formula | Used for |
|---|---|---|
| **Chebyshev** | `max(\|dx\|, \|dy\|)` | every *action range*: "adjacent" (= 1, diagonals included), attack range, turret range, build distance, turret-to-base limit |
| **Euclidean** | `dx² + dy² ≤ r²` | vision circles and the shrinking zone |

`x` grows East and `y` grows South. Movement is 4-directional: `"N"` (y−1), `"S"` (y+1), `"E"` (x+1), `"W"` (x−1).

### Map

- A <!--v map.size-->40<!--/v-->×<!--v map.size-->40<!--/v--> grid generated from a seed. Tile types: `floor`, `wall`, `energy_node`, `crystal_node`.
- **Point-symmetric**: tile (x, y) always equals tile (<!--v map.size - 1-->39<!--/v-->−x, <!--v map.size - 1-->39<!--/v-->−y).
- Player 1's starting base is at (<!--v map.baseP1.x-->4<!--/v-->, <!--v map.baseP1.y-->4<!--/v-->), player 2's at (<!--v map.size - 1 - map.baseP1.x-->35<!--/v-->, <!--v map.size - 1 - map.baseP1.y-->35<!--/v-->). All tiles within
  Chebyshev <!--v map.baseClearRadius-->2<!--/v--> of a starting base are floor. Building more bases doesn't change terrain.
- <!--v map.energyNodesPerSide-->4<!--/v--> energy nodes per side, at Euclidean distance <!--v map.energyNodeMinDist-->3<!--/v-->–<!--v map.energyNodeMaxDist-->8<!--/v--> from that side's base.
- Crystal nodes come in mirrored pairs, <!--v map.crystalPairsMin * 2-->2<!--/v--> to <!--v map.crystalPairsMax * 2-->4<!--/v--> in total, and can be anywhere on the map: in the
  middle, along an edge, or on either side. Each one is at Euclidean distance ≥ <!--v map.crystalMinBaseDist-->10<!--/v--> from both starting
  bases and at Chebyshev distance ≥ <!--v map.crystalMinSpacing-->3<!--/v--> from every other node (its own mirror twin included). Its twin
  at (<!--v map.size - 1-->39<!--/v-->−x, <!--v map.size - 1-->39<!--/v-->−y) is the same distance from the other base, so neither player is closer to crystal overall.
- Generation is retried until a BFS confirms a walkable path from base 1 to base 2 and that every node has a
  reachable adjacent tile.
- Terrain walls, nodes, bases, structures and units all block movement. Units never share a tile.

### Match

- Ticks are numbered 0–<!--v match.maxTicks - 1-->499<!--/v--> (<!--v match.maxTicks-->500<!--/v--> ticks at most).
- Each player starts with one base of their race, <!--v match.startEnergy-->150<!--/v--> energy, <!--v match.startCrystal-->0<!--/v--> crystal and <!--v match.startWorkers-->2<!--/v--> workers of their race
  (classic: Workers; Tumor: Stem Cells) next to the base.
- **Unit cap**: <!--v match.unitCap-->40<!--/v--> units per player (structures and bases don't count).
- **Win**: destroy all enemy bases (the match ends that tick). Losing one base isn't defeat while another
  friendly base survives. If both players lose their last base on the same tick, or the last tick resolves with
  both still having a base, the player with **more living units wins** (every unit type counts as 1; structures
  and bases don't count). Equal unit counts fall back to the **higher score**; an equal score is a **draw**.
- **Score** (the tiebreak, and the ladder's high score) =
  <!--v score.energyWeight-->1<!--/v--> × banked energy + <!--v score.crystalWeight-->3<!--/v--> × banked crystal + <!--v score.unitValueWeight-->1<!--/v--> × value of living units + <!--v score.baseHpWeight-->2<!--/v--> × total HP of surviving friendly bases.
  A unit's value is its spawn cost with the same resource weights (worker <!--v units.worker.costEnergy * score.energyWeight + units.worker.costCrystal * score.crystalWeight-->50<!--/v-->, fighter <!--v units.fighter.costEnergy * score.energyWeight + units.fighter.costCrystal * score.crystalWeight-->105<!--/v-->, scout <!--v units.scout.costEnergy * score.energyWeight + units.scout.costCrystal * score.crystalWeight-->30<!--/v-->,
  Stem Cell <!--v units.stemCell.costEnergy * score.energyWeight + units.stemCell.costCrystal * score.crystalWeight-->25<!--/v-->, Immune Cell <!--v units.immuneCell.costEnergy * score.energyWeight + units.immuneCell.costCrystal * score.crystalWeight-->45<!--/v-->).
  Cargo that hasn't been deposited and structures don't count.
- **Forfeit**: a bot that fails <!--v bot.maxConsecutiveFailures-->10<!--/v--> ticks in a row loses.

### Races

Each player has a race, fixed for the match. It decides the player's base, and which units, structures and
upgrades they can use. A spawn, build or upgrade of another race's type fails with an `invalid_action`.

| Race | Base | Worker | Units | Structures | Upgrades |
| --- | --- | --- | --- | --- | --- |
| `"classic"` (default) | Base | Worker | <!--v races.classic.units-->worker, fighter, scout<!--/v--> | <!--v races.classic.structures-->turret, wall<!--/v--> | <!--v races.classic.upgrades-->scout, wall, fighter<!--/v--> |
| `"tumor"` | Tumor Cell | Stem Cell | <!--v races.tumor.units-->stemCell, immuneCell<!--/v--> | <!--v races.tumor.structures-->purificationCell, siegeCell<!--/v--> | <!--v races.tumor.upgrades-->tumorSpeed, photosynthesis, freedom, toxic<!--/v--> |

Stats are in the [Units](#units), [Structures](#structures) and [Upgrades](#upgrades) tables. The Tumor race
differs from the classic one in these ways:

- **Tumor Cells are its bases.** Everything that applies to bases applies to them: deposits, spawning, the win
  condition, score (<!--v score.baseHpWeight-->2<!--/v--> × HP) and zone immunity. The starting Tumor Cell has
  <!--v races.tumor.base.hp-->50<!--/v--> HP like every other. A Tumor Cell shoots the lowest-HP enemy unit within
  <!--v races.tumor.base.range-->3<!--/v--> for <!--v races.tumor.base.damage-->1<!--/v--> damage every tick. Like a turret,
  it never targets upgraded fighters.
- **New Tumor Cells come from Stem Cells.** `{ type: "transform", unitId }` turns a Stem Cell into a Tumor Cell
  on its own tile, anywhere on the map, for <!--v races.tumor.base.costEnergy-->75<!--/v--> E. The Stem Cell is
  gone (with any cargo it carried) and isn't counted as a death. It happens in the build phase, is paid with
  builds in unit-ID order, and the new Tumor Cell spawns and accepts deposits from the next tick. Stem Cells
  can't `build` a base.
- **Placement**: Purification and Siege Cells go within <!--v structures.purificationCell.maxDistFromBase-->8<!--/v--> of
  a living Tumor Cell, or <!--v structures.purificationCell.maxDistFromBase * upgrades.tumorSpeed.buildRangeMultiplier-->16<!--/v-->
  with Tumor Speed.
- **Leash**: an Immune Cell can't step to a tile more than <!--v units.immuneCell.leash-->8<!--/v--> from its nearest
  living Tumor Cell, unless that step brings it no farther from one (so a cell stranded by a lost Tumor Cell
  can still walk home). A blocked step just doesn't happen, like a step into a wall; `moveTo` paths ignore
  the leash. Adaptation Freedom removes it.
- **Healing**: after combat, each Purification Cell restores <!--v structures.purificationCell.heal-->1<!--/v--> HP to every
  friendly unit, structure and Tumor Cell within <!--v structures.purificationCell.range-->5<!--/v--> (itself included), up to
  max HP. Heals don't stack: a target in range of several Purification Cells is still healed once per tick.
  Each heal is a `heal` event.
- **Siege Cells** shoot the lowest-HP enemy structure or base within <!--v structures.siegeCell.range-->6<!--/v--> (ties →
  lowest ID). They never shoot units.
- **Photosynthesis** adds <!--v upgrades.photosynthesis.energyPerTick-->3<!--/v--> energy to the bank every tick, with no worker.

### Resources

<!--table nodes-->
| Node | Amount | Regeneration |
| --- | --- | --- |
| Energy | 600 | +1 per tick, up to 600 |
| Crystal | 200 | none |
<!--/table-->

- A worker adjacent to a node can `harvest` it: it takes `min(harvest rate, free cargo, node amount)` into its cargo.
- Energy and crystal share one cargo capacity.
- Resources only count once a worker adjacent to a living friendly base does `deposit`: all its cargo goes into
  the player's shared energy and crystal balance, which pays for everything.
- **Contested nodes**: if several workers harvest the same node in a tick, player 1's workers go first on even
  ticks and player 2's on odd ticks; within a player, lowest unit ID first.

### Units

<!--table units-->
| Unit | Race | Cost | HP | Speed | Vision | Attack | Carry | Harvest | Builds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Worker | Classic | 50 E | 10 | 1 | 5 | – | 20 | 5/tick | yes |
| Fighter | Classic | 60 E + 15 C | 30 | 1 | 5 | 6 dmg, range 1 | – | – | – |
| Scout | Classic | 30 E | 5 | 2 | 9 | 1 dmg, range 1 | – | – | – |
| Stem Cell | Tumor | 25 E | 5 | 1 | 5 | – | 10 | 5/tick | yes; transforms into a Tumor Cell |
| Immune Cell | Tumor | 15 C | 20 | 2 | 5 | 3 dmg, range 1 | – | – | – |
<!--/table-->

E = energy, C = crystal. A spawn or build needs the full cost in both resources.

- **Spawning**: at most one unit per player per tick, however many bases you have. An optional `baseId` picks a
  living friendly base; without it, living friendly bases are tried in ascending ID order until one has a free
  spawn tile. A base built this tick can spawn from the next tick.
- **Spawn tile**: the first free tile adjacent to the base, checked in the order
  (+1,+1) (+1,0) (0,+1) (+1,−1) (−1,+1) (0,−1) (−1,0) (−1,−1). Player 2 uses the negated offsets, which keeps
  spawn placement mirror-symmetric. If no tile is free the spawn fails.

### Structures

<!--table structures-->
| Structure | Race | Cost | HP | Vision | Effect | Placement |
| --- | --- | --- | --- | --- | --- | --- |
| Turret | Classic | 100 E | 50 | 4 | 4 dmg, range 4 (automatic, units only) | within 8 of a living friendly base |
| Wall | Classic | 3 E | 60 | – | – | anywhere |
| Purification Cell | Tumor | 50 E | 100 | 10 | heals friendly units and buildings in range 5 by 1 HP/tick | within 8 of a living friendly base |
| Siege Cell | Tumor | 75 E | 100 | 16 | 1 dmg, range 6 (automatic, structures and bases only) | within 8 of a living friendly base |
| Base | Classic | 100 E + 50 C | 200 | 7 | – | anywhere (built by a worker) |
| Tumor Cell (base) | Tumor | 75 E | 50 | 10 | 1 dmg, range 3 (automatic, units only) | anywhere (a Stem Cell transforms) |
<!--/table-->

A worker (Worker or Stem Cell) builds a structure of its race on an empty floor tile adjacent to it. Building
is instant and paid from banked resources.

- The tile must be empty *after movement* this tick: no unit, structure, base or node.
- If both players build on the same tile in the same tick, both builds fail. If two of your own workers pick the
  same tile, the lower unit ID builds.
- Builds are paid in unit-ID order, so if resources run out the later builds fail. Nothing is deducted for a
  failed build.
- A distance limit (turrets, Purification and Siege Cells) counts from **any living friendly base** that existed
  before this tick's build phase. Existing structures keep working if a nearby base is destroyed.
- Walls block movement. Turrets shoot automatically (see [Combat](#combat)).
- **Bases**: workers deposit at any living friendly base, spawns come from them, and they extend turret
  placement. Bases can't move and are never hurt by the zone. A new base can be attacked on the tick it is
  built; deposits, spawning and turret support start the next tick. A base built this tick keeps you alive if
  your other bases fall this tick. Destroyed bases stop blocking tiles, giving vision, accepting deposits and
  spawning; they remain in replay state with 0 HP.

### Upgrades

<!--table upgrades-->
| Upgrade | `upgrade` | Race | Cost | Effect |
| --- | --- | --- | --- | --- |
| Scout | `"scout"` | Classic | 15 C | Scout speed 2 → 4; Scout max HP 5 → 10 |
| Wall | `"wall"` | Classic | 50 E | Wall max HP 60 → 120 |
| Fighter | `"fighter"` | Classic | 20 C | Fighters are immune to all building attacks: turrets and Tumor Cells never target them and shoot other units instead |
| Tumor Speed | `"tumorSpeed"` | Tumor | 100 E | structure placement range ×2 (8 → 16 for Tumor structures) |
| Photosynthesis | `"photosynthesis"` | Tumor | 20 C | +3 energy per tick, banked directly |
| Freedom | `"freedom"` | Tumor | 150 E | Immune Cells lose their leash and can move anywhere |
| Toxic | `"toxic"` | Tumor | 20 C | Immune Cell attack range 1 → 2 |
<!--/table-->

An upgrade is bought once with `{ type: "upgrade", upgrade: "scout" }`, using the name in the `upgrade` column.
One that targets a type applies to **all** your entities of that type: every one you have now and every one
you spawn or build later (which start upgraded, at full upgraded HP). The others (Tumor Speed, Photosynthesis)
change the player. An upgrade takes effect on the tick it is bought, has no range requirement, and can be
bought before you own any of its type. `myUpgrades` shows your race's upgrades and which you own; each entity
lists its upgrades in `upgrades` (and `upgraded: true` if there are any). Immune Cells can have both of theirs.

- When max HP rises, current HP rises by the same amount (a wall at 10/60 becomes 70/120).
- Types not in the table have no upgrade.
- An upgrade fails with an `invalid_action` (and costs nothing) if the name is unknown, belongs to another race
  or is already bought, is listed twice in the same tick, or you can't cover the cost.
- Several upgrades per tick are allowed and are paid in action order.
- An upgraded fighter still takes full damage from enemy units and the zone.

### Combat

- Units with an attack `attack` one enemy unit, structure or base within their range. They can't attack their
  own side.
- Unit range is the table's range plus upgrades (an Immune Cell with Adaptation Toxic has range
  <!--v units.immuneCell.range + upgrades.toxic.rangeBonus-->2<!--/v-->). `myUnits[].range` shows it.
- Turrets fire automatically at the lowest-HP enemy **unit** in range (ties → lowest ID), skipping upgraded
  fighters. They never shoot structures or bases.
- Siege Cells fire automatically at the lowest-HP enemy structure or base in range; Tumor Cells at the
  lowest-HP enemy unit in range, skipping upgraded fighters (see [Races](#races)). An upgraded fighter therefore
  takes no damage from any building, only from units and the zone.
- All damage is computed from the **pre-combat** state and applied **simultaneously**, so two units can kill
  each other in the same tick.

### Shrinking zone

- The safe zone is a circle centered on the middle of the map (<!--v (map.size - 1) / 2-->19.5<!--/v-->, <!--v (map.size - 1) / 2-->19.5<!--/v-->).
- Its radius is <!--v zone.initialRadius-->28<!--/v--> (the whole map) until tick <!--v zone.startTick - 1-->399<!--/v-->. At tick <!--v zone.startTick-->400<!--/v--> it drops by <!--v zone.shrinkAmount-->1<!--/v-->, then by
  <!--v zone.shrinkAmount-->1<!--/v--> more every <!--v zone.shrinkEvery-->4<!--/v--> ticks: `radius(t) = initial − shrinkAmount × (1 + ⌊(t − startTick) / shrinkEvery⌋)`.
- Units and structures outside the zone (`dx² + dy² > r²`) take <!--v zone.damage-->3<!--/v--> damage per tick. Bases are immune.
- The starting bases are far from the center, so in the last ticks the area around them is outside the zone.

### Fog of war

- Each player sees every tile within the vision circle of each of their living bases, units and structures
  (vision radii are in the tables above). There is no line of sight.
- Bots see enemy units, enemy structures, living enemy bases and nodes (with amounts) only on visible tiles.
- `moveTo` pathfinding avoids terrain, bases, your structures and the enemy structures you can currently see.

### Tick resolution order

The engine runs `step(state, actionsP1, actionsP2) → { state, events }`:

1. **Collect actions.** Each bot's list is validated. Invalid actions are dropped and logged as `invalid_action`
   events; they never crash the engine. A unit gets at most one action per tick (the first one; later ones are
   invalid). Only the first `spawn` counts. `log` and `mark` become events immediately.
2. **Upgrades, then spawns.** Player 1, then player 2. Their resources are independent, so the order can't matter.
3. **Movement**, resolved simultaneously in sub-steps. In sub-step *k*, every unit with speed ≥ *k* that has a
   `move`/`moveTo` attempts one step (`moveTo` recomputes its direction each sub-step).
   - A step into a terrain wall, node, base, structure or off the map fails, and so does a leashed unit's step
     past its leash (see [Races](#races)).
   - If 2+ units target the same tile, none of them move.
   - A unit may step into a tile whose occupant moves away successfully in the same sub-step (chains work).
   - Cycles of any length, including 2-unit swaps, are blocked: none of their units move.
   - `moveTo` takes one step along a shortest path (BFS) and ignores units. Ties between equally short steps
     use the order N, E, S, W for player 1 and S, W, N, E for player 2 (mirrored). If the target tile is
     blocked, the unit paths to a tile next to it and stops there. An unreachable target gives an
     `invalid_action` ("no path to target").
4. **Harvest, then deposit, then build** (and `transform`). Deposits happen before builds, so resources
   deposited this tick can pay for a build this tick.
5. **Combat**: unit attacks, then automatic attacks (turrets, Siege Cells, then Tumor Cells). All damage is
   applied at once.
6. **Remove dead** units and structures (HP ≤ 0) and deactivate destroyed bases. If a player has no living
   base the match ends now and phase 7 is skipped.
7. **Node regeneration**, then Photosynthesis income, then **healing** (one heal per target), then
   **zone damage**, then remove anything the zone killed.
8. **Vision** is derived from the new state for the next tick's bot views. After the last tick the match ends
   on living unit counts, then score.

Because each unit has one action per tick, a unit that moves next to a node harvests **next** tick.

### Replays

A replay JSON contains the seed, bot names, the rules version (plus a full copy of the config), every tick's
actions exactly as passed to `step` and the events produced, full-state snapshots every
<!--v replay.snapshotEvery-->25<!--/v--> ticks for seeking, and the final state hash. Re-simulating a replay from its seed and actions
must reproduce the identical final state (`arena verify replay.json`). A replay only plays under the rules
version it was recorded with.

## Bot API

### `state`

```ts
{
  tick: number;                     // 0 .. maxTicks-1
  player: 1 | 2;
  race: "classic" | "tumor";        // your race (your `race` export)
  myBase: { id, x, y, hp };         // the oldest living friendly base (the destroyed starting base, 0 HP, once all are gone)
  myBases: [{ id, x, y, hp }];      // all living friendly bases, ascending ID
  startingBase: { x, y };           // original position, even after destruction
  myUnits: [{ id, type, x, y, hp, maxHp, cargo: { energy, crystal }, cargoCapacity,
              range, leash, upgraded, upgrades }];  // range after upgrades; leash: null when unleashed
  myStructures: [{ id, type, x, y, hp, maxHp, upgraded, upgrades }];  // bases (and Tumor Cells) are not here
  energy: number; crystal: number;  // banked
  myUpgrades: { scout, fighter, wall };  // your race's upgrades → whether you have bought each
  visibleEnemies: [{ id, kind: "unit"|"structure"|"base", type, x, y, hp, upgraded }];  // no `upgraded` on bases
  visibleNodes: [{ id, type: "energy"|"crystal", x, y, amount }];
  visibleTiles: [{ x, y, type: "floor"|"wall"|"energy_node"|"crystal_node" }];
  mapSize: number;
  zone: { x, y, radius, nextRadius, damage, shrinkStartTick };  // radius applies this tick, nextRadius the next
  unitCap: number; maxTicks: number;
}
```

You only see what is within vision. Remember terrain and nodes in `memory` if you need them later
(`rememberMap` does this). The enemy starting base is the point mirror of yours:
`{ x: mapSize - 1 - startingBase.x, y: mapSize - 1 - startingBase.y }`. The exact types are in
`bots/lib/api.d.ts`.

### Actions

Each unit gets at most **one** action per tick; extras are invalid.

| Action | Effect |
|---|---|
| `{ type: "move", unitId, dir }` | Step N/S/E/W, as many tiles as the unit's speed. |
| `{ type: "moveTo", unitId, x, y }` | The engine takes shortest-path steps toward (x, y), as many as the unit's speed. Avoids terrain and structures, ignores units. If (x, y) is blocked (a node, a base), it stops next to it. |
| `{ type: "harvest", unitId, nodeId }` | A unit that can harvest, adjacent to a node, takes its harvest rate into cargo. |
| `{ type: "deposit", unitId }` | A unit with cargo, adjacent to a living friendly base, banks all of it. |
| `{ type: "attack", unitId, targetId }` | A unit with an attack hits an enemy unit, structure or base within range. |
| `{ type: "build", unitId, structure, x, y }` | A worker builds a structure of its race (classic: `"turret"`, `"wall"`, `"base"`; Tumor: `"purificationCell"`, `"siegeCell"`) on an adjacent empty floor tile. |
| `{ type: "transform", unitId }` | A Stem Cell becomes a Tumor Cell on its own tile. |
| `{ type: "spawn", unit, baseId? }` | Spawn a unit of your race beside a living friendly base (one spawn per player per tick). |
| `{ type: "upgrade", upgrade }` | Buy one of your race's upgrades, by name. |
| `{ type: "log", text }` | Message shown in the replay viewer. |
| `{ type: "mark", x, y, color?, label? }` | Debug marker drawn in the replay viewer. |

### Minimal working bot (no imports)

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

### Tips

- `moveTo` ignores units, so crowds can gridlock. If a unit hasn't moved for a tick or two, step sideways.
- Fighters need crystal, and crystal can be anywhere: scout for it early. Whatever you find, its twin is at the
  mirrored position (<!--v map.size - 1-->39<!--/v-->−x, <!--v map.size - 1-->39<!--/v-->−y), so you also know where the enemy's matching crystal is.
- Late game: move units toward the center or lose them to the zone. Bank cargo before the end, because
  undeposited cargo doesn't score.
- A pack of fighters next to the enemy base takes it down fast: base HP ÷ (fighters × fighter damage) ticks.

## Running the arena

```sh
pnpm install
pnpm test                                     # engine rules, map, determinism, replay, ladder tests
pnpm typecheck
pnpm lint
pnpm readme                                   # refresh the numbers in this README from the code
pnpm arena run bots/balanced.js bots/rusher.js --seed 42 --out replays/r.json
pnpm arena tournament bots/*.js --rounds 20
pnpm arena verify replays/r.json              # re-simulate and compare final state hash
pnpm arena view replays/r.json                # open a replay in the web viewer
pnpm arena playground                         # browser playground: editor + viewer (built once, served locally)
pnpm playground                               # same, via the Vite dev server (hot reload)
pnpm arena server                             # ranked ladder (see below)
```

### Playground

`pnpm arena playground` (or `pnpm playground` for hot reload) opens the browser playground. Write a bot in the
editor on the right (Ctrl/Cmd+Enter runs it), pick an opponent and a seed, and watch the match on the left.

- **Run ×10** plays 5 seeds × both sides and shows your first loss.
- Ladder bots (with `arena server`) play on the server via `POST /api/test-game`: user bot code is never sent to
  browsers. See Botcoin for the price.
- **README · Bot API** shows this README with a copy button so you can hand it to an LLM.
- Your code is saved in the browser.

### Sandboxing

Bots run sandboxed by default (see [Limits](#limits)). `--unsafe` runs them in-process, which is faster but
only for code you trust. There are two sandboxes that share one protocol:

- **Official runs** (the CLI and the ladder server) use isolated-vm. Node ≥ 20 needs `--no-node-snapshot` for
  isolated-vm; `pnpm arena` and `cli/bin/arena.js` pass it for you.
- **The playground** runs bots in Web Workers for local testing. The API and limits are the same, but timing is
  wall-clock and the heap isn't capped.

Both produce identical matches for the same bots and seed.

### Ranked ladder

```sh
pnpm arena server                       # http://127.0.0.1:8787 — playground + leaderboard + API
pnpm arena server --port 9000 --data ./data --host 0.0.0.0 --no-autoplay --concurrency 4
```

The server hosts the playground. When it detects the ladder API, the playground shows a **Submit to ladder**
button (name + your editor code) and a **Leaderboard** button. The leaderboard shows rank, Elo, W-L-D, games
and high score; click a bot for its recent matches (with Elo changes), and click a match to watch the replay.
Your bot's update token is kept in browser storage. `pnpm playground` (Vite dev) proxies `/api` to a ladder on
:8787 if one is running.

All ladder games run server-side in the isolated-vm sandbox, 8 at a time by default (`--concurrency N`).

- **Elo**: everyone starts at <!--v ELO.initial-->1200<!--/v-->. Expected score is `1/(1+10^((Rb−Ra)/400))`, a draw counts 0.5, and
  ratings update after every game. K = <!--v ELO.kProvisional-->40<!--/v--> while a bot is *provisional* (fewer than <!--v ELO.provisionalGames-->10<!--/v--> games since its
  last submitted version), otherwise <!--v ELO.kEstablished-->24<!--/v-->. Each side uses its own K.
- **High score**: each bot's best single-game score (with the match id), plus the best on the whole ladder
  (`/api/highscore`).
- **Matchmaking**: a bot that is submitted or updated gets placement games against *every* other bot, both
  sides, one seed per pair, in random order, ahead of any background games. Boost games (see Botcoin) come
  next. When the queue is empty, a background pair is sampled at random: the first bot is weighted toward those
  with the fewest games in the last 60 matches, and its opponent is drawn from the whole ladder, weighted away
  from pairings played recently. There's a 500 ms pause between games. Seeds come from a counter persisted in
  the data dir, so every game is reproducible from its replay.
- **House bots**: idle, greedy, rusher, balanced, aggressor and starter are loaded from `bots/` at startup and
  rated like everyone else. Their names are reserved while they're on the ladder. `arena server --house-bots
  none` (or a comma list such as `--house-bots rusher,balanced`) loads fewer of them. The live server runs with
  `none`.
- **Seasons**: `arena new-season --data ./data [--min-elo N]` (with the server stopped) archives the data dir
  as `data-backup-YYYYMMDD-HHMMSS` (served read-only under past seasons) and starts the ladder over: every bot
  that carries over goes back to <!--v ELO.initial-->1200<!--/v--> Elo with no games, and the match history and replays are cleared.
  Past seasons keep their scores (leaderboard, match results, playoff) but not their replays. Bots that
  finished the season below <!--v SEASON_MIN_ELO-->1200<!--/v--> Elo (as shown, rounded) are removed from the ladder and stay only in the
  archive; `--min-elo N` sets a different threshold. Bot code and tokens are kept.
- **Ending a season live**: the leaderboard's **End season** button (the admin password is
  `ARENA_ADMIN_PASSWORD`) calls `POST /api/admin/end-season`. The ladder stops, and the top <!--v PLAYOFF.size-->8<!--/v--> bots by Elo
  (that played this season) play a knockout playoff: 1v8, 4v5, 2v7, 3v6, then semifinals and a final, every
  matchup <!--v PLAYOFF.gamesPerSeries-->5<!--/v--> games with alternating sides. Most wins advances; ties go to total score, then the better
  seed. Fewer bots means byes for the top seeds. Playoff games are unrated. The bracket updates live in the
  leaderboard. Afterwards the season is archived exactly like `arena new-season` (with `playoff.json` in the
  archive, and the playoff winner shown as the season's champion), and the new season starts right away. While
  the playoff runs, submissions, deletes, boosts, bets and test games answer `503`.
- **Submissions**: names are 2–24 characters `[A-Za-z0-9_-]` (case-insensitive unique), and code is at most
  <!--v MAX_CODE_BYTES / 1024-->100<!--/v--> KB and must initialize in the sandbox. A new bot needs an owner key, and some submissions cost
  botcoin (see below). Submitting an unused name returns a secret `token`; only its sha256 is stored.
  Re-submitting a name requires that token. It bumps the version, keeps the rating and history, and makes the
  bot provisional again. Each IP gets 10 submissions per 10 minutes.
- **Owner key**: `owner` is a random hex key (32–128 chars) the browser generates once and keeps in
  localStorage. The server stores only its sha256 on each bot it submits or claims, and it lets that browser
  update or delete all of those bots without their individual tokens.
- **Deleting**: the owner can delete a bot with its token (the leaderboard shows a **Delete bot** button on your
  own bot's match panel). The bot, its code and its queued games are removed and its name is freed; a game it
  is playing at that moment is discarded. Past matches and replays stay, so opponents' histories still show
  them. House bots can't be deleted.
- **Data dir** (`./data`, gitignored): `ladder.json` (bots, last 2000 matches, counters; written atomically via
  temp file + rename), `bots/<id>.js` (current code), `replays/<matchId>.json` (pruned together with the match
  index).

### Deploying

`./deploy.sh` ships the current code to the live ladder without mixing rules versions within a season:

1. The new code is copied to a staging directory on the host, installed and built there. The live server
   keeps running the old code.
2. The live season is ended through `POST /api/admin/end-season` with `hold: true`: the playoff runs on the old
   code, the season is archived, and the new season is created but not started.
3. Only once the playoff has a champion is the staged code swapped in and the server restarted, so the new
   season is played entirely on the new rules. If the playoff fails or has no champion, the deploy stops and
   the old server goes on running.

It needs the admin password in `ARENA_ADMIN_PASSWORD` (it asks if it isn't set).

### Botcoin

Botcoin is play money that belongs to an owner key (one wallet per browser). It never affects the game itself;
bots don't see it.

| | |
|---|---|
| Starting grant | <!--v ECON.startingGrant-->100<!--/v-->, when a browser first opens the playground (its wallet opens then). Every wallet is set back to <!--v ECON.startingGrant-->100<!--/v--> at the start of each season, whatever it held. |
| Daily stipend | <!--v ECON.dailyStipend-->100<!--/v-->, claimable once per UTC day (**Claim** next to the balance) |
| Rated games | pay nothing: bets are the only way to win coins from games (balances are kept to the cent) |
| New bot | gets pricier through the season: the owner's first new bot is free, then <!--v ECON.newBotCost-->30<!--/v-->, <!--v ECON.newBotCost * 2-->60<!--/v-->, <!--v ECON.newBotCost * 3-->90<!--/v-->, ... (<!--v ECON.newBotCost-->30<!--/v--> × bots already submitted this season; deleting a bot doesn't lower it). An owner whose bots carried over from last season pays <!--v ECON.newBotCost-->30<!--/v--> for their first. The count resets at each new season. |
| New version | one free version per bot per UTC day, then <!--v ECON.updateCost-->5<!--/v--> each |
| Boost | <!--v ECON.boostPairCost-->5<!--/v--> per pair: two priority games (both sides, one seed) against an opponent picked like a background game, queued after placement and ahead of background games. Up to <!--v ECON.maxBoostPairsQueued-->10<!--/v--> pairs queued per bot. |
| Test game | <!--v ECON.testGameCost-->0.5<!--/v--> per playground game against another owner's ladder bot. It runs on the server, so that bot's code never reaches the browser. It's unrated and isn't recorded. Games against house bots run in the browser for free; games against your own ladder bots are free too. Broken code isn't charged; a server failure is refunded. One test game at a time per wallet. |
| Bet | stake <!--v ECON.betMinStake-->5<!--/v-->–<!--v ECON.betMaxStake-->500<!--/v--> on a bot's next <!--v ECON.betGames-->4, 10, 20<!--/v--> rated games; one open bet per bot |

A submission is charged only after its code passes the sandbox check. Without enough coins it gets a `402`.
Deleting a bot refunds nothing, except its open bet.

**Bet payout** = `round(stake × clamp(actual / expected, 0, `<!--v ECON.maxBetMultiplier-->3<!--/v-->`))`.
- `actual` is the bot's score over the counted games (win 1, draw 0.5).
- `expected` is the sum of its Elo expected scores going into each game.
- A bot that plays exactly to its rating gets its stake back. A bot that beats its rating, such as a stronger
  version whose provisional rating hasn't caught up yet, pays out up to <!--v ECON.maxBetMultiplier-->3<!--/v-->×.
- Every rated game counts toward the bet, including placement and boost games, so boosting settles a bet faster.

Games themselves pay nothing, so a strong bot can't farm coins just by playing. Income is the daily stipend plus
whatever bets win.

The playground shows the balance next to **Submit to ladder**, and the button shows the price when a submission
isn't free. On the leaderboard, your own bot's panel has **Boost** and **Bet** controls, ⚡ and 🎲 tags mark
boosted bots and open bets, and **Bets** lists recent bets. Wallets live in `ladder.json`. At a new season open
bets are refunded, then every wallet is reset to the starting grant (`arena new-season` and **End season** both
do this).

### API

| API | |
|---|---|
| `GET /api/health` | `{ok, queue, busy, boostQueue, playoff}` (`playoff`: a season is ending) |
| `POST /api/bots` | `{name, code, token?, owner?}` → `201 {id, name, version, token, placementGames, cost, balance}` (first submission; `owner` required) / `200 {id, name, version, placementGames, cost, balance}` (update) / `400` invalid / `402 {error, cost, balance}` not enough botcoin / `403` name taken or house / `429` rate limited |
| `DELETE /api/bots/:id` | `{token?, owner?}` → `200 {deleted: id}` / `403` neither the bot's token nor its owner key, or house bot / `404` no such bot |
| `POST /api/mine` | `{owner, claims?: [{id, token}]}` → `{ids}`: bots owned by this owner key. A claim whose token matches links that bot to the key. |
| `GET /api/seasons` | past seasons (the `data-backup-*` folders next to the data dir): `[{id, number, endedAt, firstMatchAt, lastMatchAt, bots, matches, champion}]` |
| `GET /api/seasons/:id/{leaderboard,highscore,bots/:bot/matches,matches/:m/replay}` | the same read-only views for an archived season |
| `POST /api/admin/end-season` | `{password, minElo?, hold?}` → `202` (playoff started) / `403` wrong password / `409` already ending. `hold: true` leaves the new season paused until the server restarts (used by deploys). |
| `GET /api/playoff` | the playoff in progress, else the last archived season's (or `null`): `{status, entrants, rounds: [[{a, b, games, aWins, bWins, draws, winner, status}]], champion, seasonId}` |
| `GET /api/seasons/:id/playoff` | the playoff that closed that season, or `null` |
| `GET /api/leaderboard` | `[{rank, id, name, elo, games, wins, losses, draws, highScore, highScoreMatch, version, provisional, house, lastPlayedAt, boosted, openBet}]` by Elo. `boosted` = queued boost pairs; `openBet` = `{stake, games, played}` or `null` |
| `GET /api/highscore` | `{botId, name, score, matchId}` or `null` |
| `GET /api/bots/:id/matches?limit=20` | `[{id, at, seed, p1:{id,name,version,eloBefore,eloAfter,score}, p2, winner, reason, tick}]`, newest first |
| `GET /api/matches/:id/replay` | replay JSON (`arena verify` / the viewer accept it) |
| `POST /api/wallet` | `{owner}` → `{exists, balance, stipendAvailable, ledger, nextNewBotCost, bots: [{id, name, nextUpdateCost}], bets, prices}` (read-only) |
| `POST /api/wallet/stipend` | `{owner}` → the wallet / `404` no wallet yet / `409` already claimed today |
| `POST /api/bots/:id/boost` | `{owner, pairs}` → `{balance, queuedGames, boosted}` / `402` not enough botcoin / `403` not yours or house / `409` too many pairs queued |
| `POST /api/bots/:id/bet` | `{owner, stake, games}` → `{bet, balance}` / `400` bad stake or games / `402` / `403` / `409` an open bet already |
| `GET /api/bets?limit=50` | recent and open bets, newest first: `[{id, botId, botName, stake, games, played, actual, expected, placedAt, settledAt, payout, outcome}]` |

### Repository layout

| Path | Contents |
|---|---|
| `engine/` | pure deterministic simulation; `src/config.ts` holds every game constant, `src/stats.ts` turns them (plus upgrades) into effective stats |
| `sandbox/` | isolated-vm bot runner |
| `viewer/` | web playground + replay viewer |
| `server/` | ranked ladder |
| `cli/` | the `arena` command |
| `bots/` | sample bots + `lib/helpers.js` (the `arena` helper library), `lib/api.d.ts` (bot API types, re-exported from the engine) |
| `scripts/readme.ts` | fills the numbers in this README from the code (`pnpm readme`) |
