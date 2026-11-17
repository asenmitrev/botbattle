# Bot Arena — Rules (v1, config 1.9.0)

This file is the human-readable source of truth. Every number here comes from
`engine/src/config.ts`; if they ever disagree, that is a bug — fix both.

## 1. Overview

Two bots play a 1v1 match. Each tick both bots receive a fog-filtered view of the
game and return a list of actions. The engine then resolves both players' actions
**simultaneously** — there is no turn-order advantage. Destroy all enemy bases to
win, or have more living units when time runs out.

The simulation is deterministic: the same seed and the same bot actions always
produce the identical match.

## 2. Distances

| Metric | Formula | Used for |
|---|---|---|
| **Chebyshev** | `max(|dx|, |dy|)` | every *action range*: "adjacent" (= 1, diagonals included), attack range, turret range, build distance, turret-to-base limit |
| **Euclidean** | `dx² + dy² ≤ r²` | vision circles and the shrinking zone |

Movement is 4-directional (N/S/E/W). North is −y.

## 3. Map

- 40×40 grid generated from a seed. Tile types: `floor`, `wall`, `energy_node`, `crystal_node`.
- **Point-symmetric**: tile (x, y) always equals tile (39−x, 39−y).
- Player 1's starting base is at (4, 4), player 2's at (35, 35). All tiles within Chebyshev 2 of a starting base are floor. Building additional bases does not change terrain.
- 4 energy nodes per side, at Euclidean distance 3–8 from that side's base.
- Crystal nodes come in mirrored pairs within Euclidean 7 of the center: **2 or 4** in total.
  (3 is impossible on an even-sized point-symmetric map, since no tile is its own mirror.)
- Generation is retried until a BFS confirms a walkable path from base 1 to base 2 and that
  every node has a reachable adjacent tile.
- Blocking: terrain walls, node tiles, bases, structures and units all block movement.
  Units never share a tile.

## 4. Match

- Ticks are numbered 0–499 (500 ticks max).
- Each player starts with a base (200 HP), 150 energy, 0 crystal, and 2 workers next to the base.
- **Unit cap**: 40 units per player (structures and bases don't count).
- **Win**: destroy all enemy bases (the match ends that tick). Losing one base is not defeat while another friendly base survives. If both players lose their last bases on the same
  tick, or tick 499 resolves with both players still having a base, the player with **more living units wins**
  (all unit types count equally; structures and bases don't count). Equal unit counts fall back to the
  **higher score**; equal score is a **draw**.
- **Score** (tiebreaker, and the ladder's high score) = banked energy + 3 × banked crystal + value of living units + 2 × total surviving friendly base HP.
  A unit's value is its spawn cost with crystal counted at 3×, so worker 50, fighter 105, scout 30.
  Cargo that hasn't been deposited does not count. Structures don't count.
- **Forfeit**: a bot that fails 10 ticks in a row loses. If both are failing, play continues with both idle.

## 4a. Bot sandbox

Official matches run each bot in its own `isolated-vm` isolate. A bot has no `require`, fs, network, timers,
`process`, `WebAssembly`, `Atomics` or `SharedArrayBuffer`. Its only import is the `"arena"` helper library,
which is also the global `Arena`. `Math.random` is seeded from the match seed and player.

| Limit | Value (config `bot.*`) |
|---|---|
| Heap | 64 MB (`isolateMemoryMb`) |
| CPU per tick | 50 ms on average, measured on the isolate's CPU clock (`tickCpuMs`). Unused CPU is banked up to 250 ms (`cpuBankMs`, starts full), and a tick fails only if it uses more than 50 ms plus the bank. |
| Wall-clock cutoff per tick | 500 ms (`tickWallMs`), which kills infinite loops (above the 300 ms CPU maximum, so a busy host doesn't cost a bot its turn) |
| Init (top-level code) | 1000 ms, once (`initMs`) |
| Persisted memory | 100 KB of JSON (`memoryLimitBytes`) |
| Returned output | 1 MB (`outputLimitBytes`) |

A **failed tick** is any exception, timeout, CPU overrun, oversized memory or output, or non-serializable
result. On a failed tick the bot's actions are discarded (it does nothing), its memory reverts to the last
good tick, and a `bot_error` is recorded in the replay. If the isolate runs out of memory it is rebuilt before
the next tick. A bot whose initialization fails fails every tick.

## 5. Resources

| Node | Amount | Regen |
|---|---|---|
| Energy | 600 | +1 per tick, up to 600 |
| Crystal | 200 | none |

- A worker adjacent to a node can `harvest` it: it takes `min(5, free cargo, node amount)` into its cargo.
- Energy and crystal share one cargo capacity of 20.
- Resources only count once a worker adjacent to any living friendly base does `deposit` (all cargo is deposited into the player's shared energy and crystal balance).
- **Contested nodes**: if several workers harvest the same node in a tick, player 1's workers
  go first on even ticks and player 2's on odd ticks; within a player, lowest unit ID first.

## 6. Units

| Unit | Cost | HP | Speed | Vision | Abilities |
|---|---|---|---|---|---|
| Worker | 50 E | 10 | 1 | 5 | carry 20, harvest 5/tick, build |
| Fighter | 60 E + 15 C | 30 | 1 | 5 | attack 6 dmg, range 1 |
| Scout | 30 E | 5 | 2 (4 when upgraded) | 9 | attack 1 dmg, range 1 |

- **Base**: 200 HP, vision 7. Additional bases cost 100 energy + 50 crystals and are built by workers with `structure: "base"`. Bases cannot move and are never hurt by the zone.
- **Spawning**: at most 1 unit per player per tick, regardless of base count. An optional `baseId` selects a living friendly base. Without it, living friendly bases are tried in ascending ID order until a free spawn tile is found. Newly built bases can spawn starting next tick.
- **Spawn tile**: the first free tile adjacent to the base, checked in the order
  (+1,+1) (+1,0) (0,+1) (+1,−1) (−1,+1) (0,−1) (−1,0) (−1,−1). Player 2 uses the negated
  offsets, which keeps spawn placement mirror-symmetric. If no tile is free the spawn fails.

## 7. Structures

A worker builds on an empty floor tile adjacent to it. Building is instant and paid from your banked resources (turrets and walls cost energy; bases cost energy and crystal).

| Structure | Cost | HP | Notes |
|---|---|---|---|
| Turret | 100 E | 50 | 4 dmg, range 4, vision 4. Must be within Chebyshev 8 of any living friendly base. Auto-targets the lowest-HP enemy **unit** in range (ties → lowest ID), skipping upgraded fighters. |
| Wall | 3 E | 60 (120 when upgraded) | Blocks movement. No vision. |
| Base | 100 E + 50 C | 200 | Vision 7, resource deposits, spawning, and turret placement within Chebyshev 8. No distance limit for construction. Immune to zone damage. |

- The tile must be empty *after movement* this tick: no unit, structure, base or node.
- If both players build on the same tile in the same tick, both builds fail.
  If two of your own workers pick the same tile, the lower unit ID builds.
- Builds are paid in unit-ID order, so if energy or crystal runs out the later builds fail. A build fails unless both costs are covered, and nothing is deducted when it fails.
- Turrets may be built within Chebyshev 8 of **any living friendly base**, not just the starting base. The base must exist before this tick's build phase. Existing turrets keep working if a nearby base is destroyed.
- Destroyed bases no longer block movement or construction, provide vision, accept deposits, or spawn units. They remain in replay state with 0 HP; bots' `myBases` includes only living bases.

## 8. Upgrades

Upgrades are bought once per type: `{ type: "upgrade", upgrade: "scout" | "fighter" | "wall" }`. The upgrade
then applies to **all** your entities of that type: every one you have now, and every one you spawn or build
later (they start upgraded, at full upgraded HP). Each type can be bought once per match; `myUpgrades` shows
which you own, and each entity carries `upgraded: true`. There is no range requirement, and the upgrade takes
effect immediately, on the tick it is bought. You can buy a type's upgrade before you own any of that type.

The config 2.0.x form `{ type: "upgrade", targetId }` is still accepted: it buys the upgrade for that entity's
type (the target must be one of your living scouts, fighters or walls).

| Target | Cost | Effect |
|---|---|---|
| Scout | 15 C | Speed 2 → 4 tiles per tick for both `move` and `moveTo`, and max HP 5 → 10. |
| Fighter | 20 C | Immune to turrets: turrets never target it and pick the next valid unit instead. Enemy units and the zone still damage it normally. |
| Wall | 50 E | Max HP 60 → 120. |

- When max HP doubles, current HP rises by the same amount (a wall at 10/60 becomes 70/120).
- Workers, turrets and bases have no upgrade. Asking for one gives an `invalid_action` (`"unknown upgrade"`, or `"<type> has no upgrade"` with `targetId`).
- An upgrade fails with `invalid_action` if the type is already bought, listed twice in the same tick (also via two `targetId`s of the same type), the `targetId` is missing or not yours, or you can't cover the cost. Nothing is deducted when it fails.
- Several upgrades per tick are allowed and are paid in action order.

## 9. Combat

- Fighters (6 dmg) and scouts (1 dmg) `attack` one enemy unit, structure, or base within range 1. They cannot attack their own side.
- Turrets fire automatically at enemy units only, never at upgraded fighters.
- All damage is computed from the **pre-combat** state and applied **simultaneously**,
  so two units can kill each other in the same tick.

## 10. Shrinking zone

- The safe zone is a circle centered at (19.5, 19.5).
- Its radius is 28 until tick 399, which covers the whole map. At tick 400 it becomes 27,
  then shrinks by 1 every 4 ticks: `radius(t) = 28 − (1 + ⌊(t − 400)/4⌋)` for t ≥ 400, so 3 by tick 499.
- Units and structures outside the zone (`dx² + dy² > r²`) take 3 damage per tick. Bases are immune.
- Note: each starting base is ≈21.9 from the center, so from about tick 424 the area around both starting bases is outside the zone.

## 11. Fog of war

- Each player sees every tile within a vision circle of each living friendly base (7), units (worker 5,
  fighter 5, scout 9) and turrets (4). There is no line of sight in v1.
- Bots see enemy units, enemy structures, living enemy bases and nodes (with amounts) only on visible tiles.
- `moveTo` pathfinding avoids terrain, bases, your structures and the enemy structures you can currently see.

## 12. Tick resolution order

The engine runs `step(state, actionsP1, actionsP2) → { state, events }`:

1. **Collect actions.** Each bot's list is validated. Invalid actions are dropped and logged as
   `invalid_action` events; they never crash the engine. A unit gets at most one action per
   tick (the first one; later ones are invalid). Only the first `spawn` counts. `log` and `mark`
   become events immediately. Limits per tick: 300 actions, 20 logs, 50 marks.
2. **Upgrades, then spawns.** Player 1 is processed, then player 2. Their resources are independent,
   so this order cannot matter.
3. **Movement**, resolved simultaneously in sub-steps. In sub-step *k*, every unit with speed ≥ *k*
   that has a `move`/`moveTo` attempts one step (`moveTo` recomputes its direction each sub-step).
   - A step into a terrain wall, node, base, structure or off the map fails.
   - If 2+ units target the same tile, none of them move.
   - A unit may step into a tile whose occupant moves away successfully in the same sub-step (chains work).
   - Cycles of any length, including 2-unit swaps, are blocked: none of their units move.
   - `moveTo` takes one step along a shortest path (BFS) and ignores units. Ties between equally short
     steps use the order N, E, S, W for player 1 and S, W, N, E for player 2 (mirrored).
     If the target tile is blocked, the unit paths to a tile next to it and stops there.
     An unreachable target gives an `invalid_action` ("no path to target").
4. **Harvest, then deposit, then build** (see §5, §7). Deposits happen before builds, so energy
   deposited this tick can pay for a build this tick.
5. **Combat**: fighter attacks, then turret target selection. All damage comes from pre-combat state and is applied at once.
6. **Remove dead** units and structures (HP ≤ 0), and deactivate destroyed bases. If a player has no living bases the match ends now (see §4), and phase 7 is skipped. A base built this tick can prevent defeat even if the starting base is destroyed.
7. **Node regeneration**, then **zone damage**, then remove anything the zone killed.
8. **Vision** is recomputed for each player (it is derived from state, for the next tick's bot views).
   The tick counter advances; after tick 499 the match ends on living unit counts, then score.

## 13. Replays

A replay JSON contains the seed, bot names, config version (plus a full copy of the config),
every tick's actions exactly as passed to `step` and the events produced, full-state snapshots
every 25 ticks for seeking, and the final state hash. Re-simulating a replay from its seed and
actions must reproduce the identical final state (`arena verify replay.json`).
