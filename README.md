# Bot Arena

Programmable 1v1 strategy game: write a bot (`onTick(state, memory) → actions`), fight other bots.

- **RULES.md**: the full rules (source of truth, mirrors `engine/src/config.ts`)
- **BOT_API.md**: self-contained guide for writing a bot (also meant to be handed to an LLM)

## Units and structures at a glance

| | Cost | HP | Speed | Vision | Notes |
|---|---|---|---|---|---|
| Worker | 50 E | 10 | 1 | 5 | carries 20, harvests 5/tick, builds; can't attack |
| Fighter | 60 E + 15 C | 30 | 1 | 5 | attacks for 6 (9 with Weapons), range 1 |
| Scout | 30 E | 5 | 2 (4 with Scout Speed) | 9 | attacks for 1, range 1; can't carry |
| Turret | 100 E | 50 | – | 4 | auto-shoots the lowest-HP enemy unit within 4 for 4; must be built within Chebyshev 8 of any living friendly base |
| Wall | 5 E | 60 | – | – | blocks movement |
| Base | 100 E | 200 | – | 7 | workers deposit resources here; supports spawning and nearby turrets; immune to zone damage |

**Scout Speed** is a one-time upgrade costing 15 crystals. It doubles movement speed
for all your current and future scouts from 2 to 4 tiles per tick, effective immediately.
Buy it with `{ type: "upgrade", upgrade: "scoutSpeed" }`.

**Additional bases**: a worker builds on an adjacent empty floor tile with
`{ type: "build", unitId, structure: "base", x, y }`. Workers can deposit at any living
friendly base into the shared resource balance, and turrets can be built within 8 tiles
of any living friendly base. A player loses to base destruction only after losing **all bases**.
Bots receive `myBases` (all living friendly bases); `myBase` defaults to the oldest survivor.
Use `{ type: "spawn", unit: "worker", baseId }` to choose a base; the limit remains
one spawn per player per tick. Scoring counts the total HP of surviving friendly bases.

See RULES.md for everything else.

```sh
pnpm install
pnpm test                                     # engine rules, map, determinism, replay tests
pnpm arena run bots/balanced.js bots/rusher.js --seed 42 --out replays/r.json
pnpm arena tournament bots/*.js --rounds 20
pnpm arena verify replays/r.json              # re-simulate and compare final state hash
pnpm arena view replays/r.json                # open a replay in the web viewer
pnpm arena playground                         # browser playground: editor + viewer (built once, served locally)
pnpm playground                               # same, via the Vite dev server (hot reload)
```

**Playground**: write a bot in the editor on the right (Ctrl/Cmd+Enter runs it), pick an opponent and
a seed, and watch the match on the left. "Run ×10" plays 5 seeds × both sides and shows your first loss.
"README · Bot API" shows BOT_API.md with a copy button so you can hand it to an LLM. Your code is
saved in the browser.

**Two sandboxes, one protocol**: official runs (CLI) use isolated-vm. The playground runs bots in Web
Workers for local testing. Same API and limits, but timing is wall-clock and the heap isn't capped.
Both produce identical matches for the same bots and seed.

Layout: `engine/` (pure deterministic simulation), `sandbox/` (isolated-vm bot runner), `viewer/` (web
playground + replay viewer), `server/` (ranked ladder), `cli/`,
`bots/` (samples + `lib/helpers.js`, `lib/api.d.ts`).

Bots run sandboxed by default (64 MB, 50 ms CPU/tick; see RULES.md §4a). `--unsafe` runs them
in-process, which is faster but only for code you trust. Node ≥ 20 needs `--no-node-snapshot` for isolated-vm;
`pnpm arena` and `cli/bin/arena.js` pass it for you.

## Ranked ladder

```sh
pnpm arena server                       # http://127.0.0.1:8787 — playground + leaderboard + API
pnpm arena server --port 9000 --data ./data --host 0.0.0.0 --no-autoplay --concurrency 4
```

The server hosts the playground. When it detects the ladder API, the playground adds **Submit to
ladder** (name + your editor code) and a **Leaderboard** button. The leaderboard shows rank, Elo, W-L-D,
games and high score; click a bot for its recent matches (with Elo changes), and click a match to watch the
replay. Your bot's update token is kept in browser storage. `pnpm playground` (Vite dev) proxies
`/api` to a ladder on :8787 if one is running.

All ladder games run server-side in the isolated-vm sandbox, 8 at a time by default (`--concurrency N`).

- **Elo**: everyone starts at 1200. Expected score is `1/(1+10^((Rb−Ra)/400))`, a draw counts 0.5, and
  ratings update after every game. K = 40 while a bot is *provisional* (fewer than 10 games since its last
  submitted version), otherwise 24. Each side uses its own K.
- **High score**: each bot's best single-game score (with the match id), plus the best on the whole
  ladder (`/api/highscore`).
- **Matchmaking**: a new or updated bot gets placement games against *every* other bot, both sides,
  one seed per pair, in random order, ahead of any background games. When the queue is empty, a
  background pair is sampled at random: the first bot is weighted toward those with the fewest games in
  the last 60 matches, and its opponent is drawn from the whole ladder, weighted away from pairings
  played recently. There's a 500 ms pause between games. Seeds
  come from a counter persisted in the data dir, so every game is reproducible from its replay.
- **House bots**: idle, greedy, rusher, balanced, aggressor and starter are loaded from `bots/` at
  startup and rated like everyone else. Their names are reserved.
- **Submissions**: names are 2–24 characters `[A-Za-z0-9_-]` (case-insensitive unique), code is at most
  100 KB and must initialize in the sandbox. A new name returns a secret `token`; only its sha256 is
  stored. Re-submitting a name requires that token. It bumps the version, keeps the rating and history,
  and makes the bot provisional again. Each IP gets 10 submissions per 10 minutes.
- **Deleting**: the owner can delete a bot with its token (the leaderboard shows a **Delete bot** button
  on your own bot's match panel). The bot, its code and its queued games are removed and its name is
  freed; a game it is playing at that moment is discarded. Past matches and replays stay, so opponents'
  histories still show them. House bots can't be deleted.
- **Data dir** (`./data`, gitignored): `ladder.json` (bots, last 2000 matches, counters; written
  atomically via temp file + rename), `bots/<id>.js` (current code), `replays/<matchId>.json` (pruned
  together with the match index).

| API | |
|---|---|
| `GET /api/health` | `{ok, queue, busy}` |
| `POST /api/bots` | `{name, code, token?, owner?}` → `201 {id, name, version, token}` (new) / `200 {id, name, version}` (update) / `400` invalid / `403` name taken or house / `429` rate limited |
| `DELETE /api/bots/:id` | `{token?, owner?}` → `200 {deleted: id}` / `403` neither the bot's token nor its owner key, or house bot / `404` no such bot |
| `POST /api/mine` | `{owner, claims?: [{id, token}]}` → `{ids}`: bots owned by this owner key. A claim whose token matches links that bot to the key. |
| `GET /api/seasons` | past seasons (the `data-backup-*` folders next to the data dir): `[{id, number, endedAt, firstMatchAt, lastMatchAt, bots, matches, champion}]` |
| `GET /api/seasons/:id/{leaderboard,highscore,bots/:bot/matches,matches/:m/replay}` | the same read-only views for an archived season |
| `GET /api/leaderboard` | `[{rank, id, name, elo, games, wins, losses, draws, highScore, highScoreMatch, version, provisional, house, lastPlayedAt}]` by Elo |
| `GET /api/highscore` | `{botId, name, score, matchId}` or `null` |
| `GET /api/bots/:id/matches?limit=20` | `[{id, at, seed, p1:{id,name,version,eloBefore,eloAfter,score}, p2, winner, reason, tick}]`, newest first |
| `GET /api/matches/:id/replay` | replay JSON (`arena verify` / the viewer accept it) |

`owner` is a random hex key (32–128 chars) the browser generates once and keeps in localStorage. The server stores only its sha256 on each bot it submits or claims, and it lets that browser update or delete all of those bots without their individual tokens.
