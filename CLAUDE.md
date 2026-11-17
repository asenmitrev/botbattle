# Bot Arena — working rules

README.md is the manual and the only rules document; read its Rules section before touching the engine.

## Before calling a change done

`pnpm typecheck && pnpm lint && pnpm test`. All three must pass.

## Engine (`engine/src`)

- `step()` is pure and deterministic: same seed + same actions = same match, byte for byte. No `Math.random`,
  `Date`, timers or I/O (lint enforces it). Iterate in a fixed order (unit/entity ID, player 1 then 2); never
  rely on object-key or Set/Map insertion order that depends on input.
- The engine imports nothing outside `engine/src`. The server, sandbox, viewer and CLI depend on it, never the
  other way.
- Every game number lives in `config.ts`. Rules read derived stats through `stats.ts` (`maxHp`, `unitSpeed`,
  `turretImmune`, `buildSpec`, …): don't test `u.type === "scout"` or `upgraded` inside rules. A new upgrade
  effect is a field on `UpgradeEffect` handled in `stats.ts`; a new unit ability is a field on the unit spec.
- A new action is one entry in `UNIT_ACTIONS` or `PLAYER_ACTIONS` in `step.ts`, plus its member of `Action`
  in `types.ts`.
- Bot-facing types (`BotState` in `vision.ts`, `Action` in `types.ts`) are what bots see; `bots/lib/api.d.ts`
  re-exports them, so don't redefine them there.
- `bots/lib/helpers.js` runs inside the sandbox and can't import the engine; `bots/test/helpers.test.ts` checks
  its cost tables against `CONFIG`.

## Changing the rules

Any change to `config.ts` or to rule behaviour in `step.ts`:

1. Bump `CONFIG_VERSION` (major for changes that break bots or the state shape, minor otherwise). Replays only
   play under the version they were recorded with.
2. Update the Rules section of README.md in the same commit. Numbers in it are markers
   (`<!--v units.scout.speed-->2<!--/v-->`, `<!--table units-->`) filled in by `pnpm readme`; use a marker for
   any new number instead of typing it, and run `pnpm readme`. `test/readme.test.ts` fails while it's stale.

## No compatibility shims

Each deploy ends the season (`deploy.sh`), so live data, replays and bots never outlive a rules version.
Don't keep deprecated actions, optional "absent in old replays" fields or old-format fallbacks. Change the
shape, bump the version, update the tests.

## Server

Ladder data is live user data on the host (`~/arena/data`, past seasons in `data-backup-*` next to it). Never
name anything `data-backup-*` next to a data dir. Archived seasons are read with today's code, so reading
`ladder.json` must keep working for them (e.g. `economy` can be absent there).
