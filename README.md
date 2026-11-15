# Bot Arena

Bot Arena is a programmable 1v1 strategy game. You write a bot, a single function
`onTick(state, memory) → actions`, and it fights other bots on a fog-of-war map: harvesting resources,
spawning units, building structures and trying to destroy the enemy's bases.

Two documents cover the game itself:

- **[RULES.md](RULES.md)**: the full rules. It is the source of truth and mirrors `engine/src/config.ts`.
- **[BOT_API.md](BOT_API.md)**: a self-contained guide to writing a bot, also meant to be handed to an LLM.

## Quick start

```sh
pnpm install
pnpm test                                     # engine rules, map, determinism, replay tests
pnpm arena run bots/balanced.js bots/rusher.js --seed 42 --out replays/r.json
pnpm arena tournament bots/*.js --rounds 20
pnpm arena verify replays/r.json              # re-simulate and compare final state hash
pnpm arena view replays/r.json                # open a replay in the web viewer
pnpm arena playground                         # browser playground: editor + viewer (built once, served locally)
pnpm playground                               # same, via the Vite dev server (hot reload)
pnpm arena server                             # ranked ladder (see below)
```

## The game at a glance

Each player starts with a base, some energy and a couple of workers. Workers harvest energy and
crystal and deposit them into a shared balance, which pays for units, structures and upgrades.
Destroy all enemy bases to win. RULES.md has everything else: map generation, match end and scoring,
the shrinking zone, fog of war and the exact tick resolution order.

### Units and structures

| | Cost | HP | Speed | Vision | Notes |
|---|---|---|---|---|---|
| Worker | 50 E | 10 | 1 | 5 | carries 20, harvests 5/tick, builds; can't attack |
| Fighter | 60 E + 15 C | 30 | 1 | 5 | attacks for 6, range 1 |
| Scout | 30 E | 5 | 2 | 9 | attacks for 1, range 1; can't carry |
| Turret | 100 E | 50 | – | 4 | auto-shoots the lowest-HP enemy unit within 4 for 4; must be built within Chebyshev 8 of any living friendly base |
| Wall | 3 E | 60 | – | – | blocks movement |
| Base | 100 E + 50 C | 200 | – | 7 | workers deposit resources here; supports spawning and nearby turrets; immune to zone damage |

E = energy, C = crystal. A build or spawn needs the full cost in both resources.

### Upgrades

Upgrades are bought for one specific unit or wall with `{ type: "upgrade", targetId }`. Each scout,
fighter or wall can be upgraded once; units spawned later start without it. The upgrade takes effect
immediately, on the tick it is bought.

| Upgrades | Cost | Effect |
|---|---|---|
| Scout | 15 C | speed 2 → 4 and max HP 5 → 10 |
| Fighter | 20 C | immune to turrets: turrets ignore it and shoot other targets |
| Wall | 50 E | max HP 60 → 120 |

When max HP doubles, the entity also gains the extra HP right away, so a damaged scout at 2/5 becomes 7/10.
Workers and turrets have no upgrade. An upgraded fighter still takes full damage from enemy units and the zone.

### Multiple bases

A worker builds an additional base on an adjacent empty floor tile with
`{ type: "build", unitId, structure: "base", x, y }`; it costs 100 energy and 50 crystals.

- Workers can deposit at any living friendly base into the shared resource balance.
- Turrets can be built within 8 tiles of any living friendly base.
- A player loses to base destruction only after losing **all** bases.
- Bots receive `myBases` (all living friendly bases); `myBase` defaults to the oldest survivor.
- `{ type: "spawn", unit: "worker", baseId }` chooses where to spawn. The limit stays one spawn per
  player per tick, however many bases you have.
- Scoring counts the total HP of surviving friendly bases.

## Playground

`pnpm arena playground` (or `pnpm playground` for hot reload) opens the browser playground. Write a
bot in the editor on the right (Ctrl/Cmd+Enter runs it), pick an opponent and a seed, and watch the
match on the left.

- **Run ×10** plays 5 seeds × both sides and shows your first loss.
- Ladder bots (with `arena server`) play on the server via `POST /api/test-game`: user bot code is never
  sent to browsers. See Botcoin for the price.
- **README · Bot API** shows BOT_API.md with a copy button so you can hand it to an LLM.
- Your code is saved in the browser.

## Sandboxing

Bots run sandboxed by default, with 64 MB of heap and 50 ms of CPU per tick (see RULES.md §4a).
`--unsafe` runs them in-process, which is faster but only for code you trust.

There are two sandboxes that share one protocol:

- **Official runs** (the CLI and the ladder server) use isolated-vm. Node ≥ 20 needs
  `--no-node-snapshot` for isolated-vm; `pnpm arena` and `cli/bin/arena.js` pass it for you.
- **The playground** runs bots in Web Workers for local testing. The API and limits are the same, but
  timing is wall-clock and the heap isn't capped.

Both produce identical matches for the same bots and seed.

## Ranked ladder

```sh
pnpm arena server                       # http://127.0.0.1:8787 — playground + leaderboard + API
pnpm arena server --port 9000 --data ./data --host 0.0.0.0 --no-autoplay --concurrency 4
```

The server hosts the playground. When it detects the ladder API, the playground shows a **Submit to
ladder** button (name + your editor code) and a **Leaderboard** button. The leaderboard shows rank, Elo,
W-L-D, games and high score; click a bot for its recent matches (with Elo changes), and click a match to
watch the replay. Your bot's update token is kept in browser storage. `pnpm playground` (Vite dev)
proxies `/api` to a ladder on :8787 if one is running.

All ladder games run server-side in the isolated-vm sandbox, 8 at a time by default (`--concurrency N`).

- **Elo**: everyone starts at 1200. Expected score is `1/(1+10^((Rb−Ra)/400))`, a draw counts 0.5, and
  ratings update after every game. K = 40 while a bot is *provisional* (fewer than 10 games since its
  last submitted version), otherwise 24. Each side uses its own K.
- **High score**: each bot's best single-game score (with the match id), plus the best on the whole
  ladder (`/api/highscore`).
- **Matchmaking**: a bot that is submitted or updated gets placement games against *every* other bot,
  both sides, one seed per pair, in random order, ahead of any background games. Boost games (see
  Botcoin) come next. When the queue is
  empty, a background pair is sampled at random: the first bot is weighted toward those with the fewest
  games in the last 60 matches, and its opponent is drawn from the whole ladder, weighted away from
  pairings played recently. There's a 500 ms pause between games. Seeds come from a counter persisted
  in the data dir, so every game is reproducible from its replay.
- **House bots**: idle, greedy, rusher, balanced, aggressor and starter are loaded from `bots/` at
  startup and rated like everyone else. Their names are reserved while they're on the ladder.
  `arena server --house-bots none` (or a comma list such as `--house-bots rusher,balanced`) loads
  fewer of them. The live server runs with `none`.
- **Seasons**: `arena new-season --data ./data [--min-elo 1200]` (with the server stopped) archives the data dir as `data-backup-YYYYMMDD-HHMMSS` (served
  read-only under past seasons) and starts the ladder over: every bot that carries over goes back to
  1200 Elo with no games, and the match history and replays are cleared. Past seasons keep their scores
  (leaderboard, match results, playoff) but not their replays, which are deleted from the archive. Bots that finished the season
  below 1200 Elo (as shown, rounded) are removed from the ladder and stay only in the archive; `--min-elo N`
  sets a different threshold. Bot code and tokens are kept.
- **Ending a season live**: the leaderboard's **End season** button (password: `djbobo`, or set
  `ARENA_ADMIN_PASSWORD`) calls `POST /api/admin/end-season`. The ladder stops, and the top 8 bots by Elo (that
  played this season) play a knockout playoff: 1v8, 4v5, 2v7, 3v6, then semifinals and a final, every matchup 5
  games with alternating sides. Most wins advances; ties go to total score, then the better seed. Fewer than 8 bots
  means byes for the top seeds. Playoff games are unrated and their replays are kept. The bracket updates live in the
  leaderboard. Afterwards the season is archived exactly like `arena new-season` (with `playoff.json` in the archive,
  and the playoff winner shown as the season's champion), and the new season starts right away. While the playoff
  runs, submissions, deletes, boosts, bets and test games answer `503`.
- **Submissions**: names are 2–24 characters `[A-Za-z0-9_-]` (case-insensitive unique), and code is at
  most 100 KB and must initialize in the sandbox. A new bot needs an owner key, and some submissions
  cost botcoin (see below). Submitting an unused name returns a secret `token`;
  only its sha256 is stored. Re-submitting a name requires that token. It bumps the version, keeps the
  rating and history, and makes the bot provisional again. Each IP gets 10 submissions per 10 minutes.
- **Owner key**: `owner` is a random hex key (32–128 chars) the browser generates once and keeps in
  localStorage. The server stores only its sha256 on each bot it submits or claims, and it lets that
  browser update or delete all of those bots without their individual tokens.
- **Deleting**: the owner can delete a bot with its token (the leaderboard shows a **Delete bot** button
  on your own bot's match panel). The bot, its code and its queued games are removed and its name is
  freed; a game it is playing at that moment is discarded. Past matches and replays stay, so opponents'
  histories still show them. House bots can't be deleted.
- **Data dir** (`./data`, gitignored): `ladder.json` (bots, last 2000 matches, counters; written
  atomically via temp file + rename), `bots/<id>.js` (current code), `replays/<matchId>.json` (pruned
  together with the match index).

### Botcoin

Botcoin is play money that belongs to an owner key (one wallet per browser). It never affects the game itself;
bots don't see it.

| | |
|---|---|
| Starting grant | 100, when a browser first opens the playground (its wallet opens then) |
| Daily stipend | 100, claimable once per UTC day (**Claim +100** next to the balance) |
| Rated games | pay nothing: bets are the only way to win coins from games (balances are kept to the cent) |
| New bot | gets pricier through the season: the owner's first new bot is free, then 30, 60, 90, ... (30 × bots already submitted this season; deleting a bot doesn't lower it). An owner whose bots carried over from last season pays 30 for their first. The count resets at each new season. |
| New version | one free version per bot per UTC day, then 5 each |
| Boost | 5 per pair: two priority games (both sides, one seed) against an opponent picked like a background game, queued after placement and ahead of background games. Up to 10 pairs queued per bot. |
| Test game | 0.5 per playground game against another owner's ladder bot. It runs on the server, so that bot's code never reaches the browser. It's unrated and isn't recorded. Games against house bots run in the browser for free; games against your own ladder bots are free too. Broken code isn't charged; a server failure is refunded. One test game at a time per wallet. |
| Bet | stake 5–500 on a bot's next 4, 10 or 20 rated games; one open bet per bot |

A submission is charged only after its code passes the sandbox check. Without enough coins it gets a `402`.
Deleting a bot refunds nothing, except its open bet.

**Bet payout** = `round(stake × clamp(actual / expected, 0, 3))`.
- `actual` is the bot's score over the counted games (win 1, draw 0.5).
- `expected` is the sum of its Elo expected scores going into each game.
- A bot that plays exactly to its rating gets its stake back. A bot that beats its rating, such as a stronger
  version whose provisional rating hasn't caught up yet, pays out up to 3×.
- Every rated game counts toward the bet, including placement and boost games, so boosting settles a bet faster.

Games themselves pay nothing, so a strong bot can't farm coins just by playing. Income is the daily stipend
plus whatever bets win.

The playground shows the balance next to **Submit to ladder**, and the button shows the price when a
submission isn't free. On the leaderboard, your own bot's panel has **Boost** and **Bet** controls,
⚡ and 🎲 tags mark boosted bots and open bets, and **Bets** lists recent bets.

Wallets live in `ladder.json`.
- Owners whose bots predate a wallet get one, with the grant, at server start.
- Wallets carry into a new season, and open bets are refunded (`arena new-season` does both).

### API

| API | |
|---|---|
| `GET /api/health` | `{ok, queue, busy, boostQueue, playoff}` (`playoff`: a season is ending) |
| `POST /api/bots` | `{name, code, token?, owner?}` → `201 {id, name, version, token, placementGames, cost, balance}` (first submission; `owner` required) / `200 {id, name, version, placementGames, cost, balance}` (update) / `400` invalid / `402 {error, cost, balance}` not enough botcoin / `403` name taken or house / `429` rate limited |
| `DELETE /api/bots/:id` | `{token?, owner?}` → `200 {deleted: id}` / `403` neither the bot's token nor its owner key, or house bot / `404` no such bot |
| `POST /api/mine` | `{owner, claims?: [{id, token}]}` → `{ids}`: bots owned by this owner key. A claim whose token matches links that bot to the key. |
| `GET /api/seasons` | past seasons (the `data-backup-*` folders next to the data dir): `[{id, number, endedAt, firstMatchAt, lastMatchAt, bots, matches, champion}]` |
| `GET /api/seasons/:id/{leaderboard,highscore,bots/:bot/matches,matches/:m/replay}` | the same read-only views for an archived season |
| `POST /api/admin/end-season` | `{password, minElo?}` → `202` (playoff started) / `403` wrong password / `409` already ending |
| `GET /api/playoff` | the playoff in progress, else the last archived season's (or `null`): `{status, entrants, rounds: [[{a, b, games, aWins, bWins, draws, winner, status}]], champion, seasonId}` |
| `GET /api/seasons/:id/playoff` | the playoff that closed that season, or `null` |
| `GET /api/leaderboard` | `[{rank, id, name, elo, games, wins, losses, draws, highScore, highScoreMatch, version, provisional, house, lastPlayedAt, boosted, openBet}]` by Elo. `boosted` = queued boost pairs; `openBet` = `{stake, games, played}` or `null` |
| `GET /api/highscore` | `{botId, name, score, matchId}` or `null` |
| `GET /api/bots/:id/matches?limit=20` | `[{id, at, seed, p1:{id,name,version,eloBefore,eloAfter,score}, p2, winner, reason, tick}]`, newest first |
| `GET /api/matches/:id/replay` | replay JSON (`arena verify` / the viewer accept it) |
| `POST /api/wallet` | `{owner}` → `{exists, balance, stipendAvailable, ledger, nextNewBotCost, bots: [{id, name, nextUpdateCost}], bets, prices}` (read-only) |
| `POST /api/wallet/stipend` | `{owner}` → the wallet / `404` no wallet yet / `409` already claimed today |
| `POST /api/bots/:id/boost` | `{owner, pairs}` → `{balance, queuedGames, boosted}` / `402` not enough botcoin / `403` not yours or house / `409` more than 10 pairs queued |
| `POST /api/bots/:id/bet` | `{owner, stake, games}` → `{bet, balance}` / `400` bad stake or games / `402` / `403` / `409` an open bet already |
| `GET /api/bets?limit=50` | recent and open bets, newest first: `[{id, botId, botName, stake, games, played, actual, expected, placedAt, settledAt, payout, outcome}]` |

## Repository layout

| Path | Contents |
|---|---|
| `engine/` | pure deterministic simulation; `src/config.ts` holds every game constant |
| `sandbox/` | isolated-vm bot runner |
| `viewer/` | web playground + replay viewer |
| `server/` | ranked ladder |
| `cli/` | the `arena` command |
| `bots/` | sample bots + `lib/helpers.js`, `lib/api.d.ts` |
