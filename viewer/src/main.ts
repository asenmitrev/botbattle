import "./style.css";
import { marked } from "marked";
import { CONFIG, runMatch, type GameEvent, type GameState, type MatchResult, type PlayerId, type Replay } from "@arena/engine";
import botApiMarkdown from "../../BOT_API.md?raw";
import { SAMPLE_BOTS, STARTER_SOURCE } from "./bots.js";
import { LineChart } from "./charts.js";
import { createEditor } from "./editor.js";
import { BoardRenderer, type RenderOptions } from "./renderer.js";
import { ReplayModel, type Series } from "./replay-model.js";
import { WorkerBot } from "./worker-bot.js";
import { initLadder, owner } from "./ladder.js";
import { SPRITE_URLS } from "./sprites.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const CODE_KEY = "bot-arena:code";
const SETTINGS_KEY = "bot-arena:settings";

// ------------------------------------------------------------------ storage (best effort)
function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}

// ------------------------------------------------------------------ view state
let model: ReplayModel | null = null;
let t = 0;
let playing = false;
let lastFrame = 0;
let acc = 0;
let logTab: "logs" | "problems" = "logs";
const opts: RenderOptions = { fog: 0, marks: true, attacks: true };

const board = new BoardRenderer($<HTMLCanvasElement>("board"));

// Legend: what each sprite on the board is.
$("legend").innerHTML = (
  [
    ["worker", "Worker"],
    ["fighter", "Fighter"],
    ["scout", "Scout"],
    ["turret", "Turret"],
    ["wall", "Wall"],
    ["base", "Base"],
    ["fighter_up", "Upgraded fighter"],
    ["scout_up", "Upgraded scout"],
    ["wall_up", "Upgraded wall"],
  ] as const
)
  .map(([k, label]) => `<div class="legend-item"><img src="${SPRITE_URLS[k]}" alt="" /><span>${label}</span></div>`)
  .join("");
const charts: Record<keyof Series, LineChart> = {} as Record<keyof Series, LineChart>;
for (const el of document.querySelectorAll<HTMLElement>(".chart")) {
  charts[el.dataset.series as keyof Series] = new LineChart(el, (i) => seek(i));
}

// ------------------------------------------------------------------ editor
const settings = (() => {
  try {
    return JSON.parse(load(SETTINGS_KEY) ?? "{}") as { side?: string; opponent?: string; seed?: string };
  } catch {
    return {};
  }
})();
let code = load(CODE_KEY) ?? STARTER_SOURCE;
let saveTimer = 0;
const editor = createEditor(
  $("editor"),
  code,
  (c) => {
    code = c;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => save(CODE_KEY, c), 300);
  },
  () => void runOne(),
);

const opponentSel = $<HTMLSelectElement>("opponent-select");
const houseGroup = document.createElement("optgroup");
houseGroup.label = "House bots";
for (const name of Object.keys(SAMPLE_BOTS)) houseGroup.append(new Option(name, name));
opponentSel.append(houseGroup);
opponentSel.value = settings.opponent && SAMPLE_BOTS[settings.opponent] ? settings.opponent : "greedy";

// Ladder (user) bots join the list when the page is served by `arena server`. Value: "ladder:<id>".
const LADDER_PREFIX = "ladder:";
const ladderNames = new Map<string, string>();
let ladderGroup: HTMLOptGroupElement | null = null;
/** (Re)build the "Ladder bots" group. Safe to call again, e.g. after a bot is deleted. */
async function loadLadderBots(): Promise<void> {
  let rows: { id: string; name: string; elo: number; house: boolean; version: number }[];
  try {
    const r = await fetch("/api/leaderboard", { cache: "no-store" });
    if (!r.ok) return;
    rows = await r.json();
  } catch {
    return;
  }
  const users = rows.filter((x) => !x.house);
  const current = opponentSel.value;
  ladderGroup?.remove();
  ladderGroup = null;
  ladderNames.clear();
  if (!users.length) {
    if (current.startsWith(LADDER_PREFIX)) opponentSel.value = "greedy";
    return;
  }
  const group = (ladderGroup = document.createElement("optgroup"));
  group.label = "Ladder bots";
  for (const b of users) {
    ladderNames.set(b.id, b.name);
    group.append(new Option(`${b.name} (${Math.round(b.elo)}) · server`, LADDER_PREFIX + b.id));
  }
  opponentSel.append(group);
  const want = current.startsWith(LADDER_PREFIX) ? current : settings.opponent;
  if (want?.startsWith(LADDER_PREFIX)) opponentSel.value = ladderNames.has(want.slice(LADDER_PREFIX.length)) ? want : current.startsWith(LADDER_PREFIX) ? "greedy" : current;
}
void loadLadderBots();

function opponentName(value: string): string {
  return value.startsWith(LADDER_PREFIX) ? (ladderNames.get(value.slice(LADDER_PREFIX.length)) ?? value) : value;
}

const sideSel = $<HTMLSelectElement>("side-select");
sideSel.value = settings.side === "2" ? "2" : "1";
const seedInput = $<HTMLInputElement>("seed-input");
if (settings.seed) seedInput.value = settings.seed;
const persistSettings = () => save(SETTINGS_KEY, JSON.stringify({ side: sideSel.value, opponent: opponentSel.value, seed: seedInput.value }));
for (const el of [opponentSel, sideSel, seedInput]) el.addEventListener("change", persistSettings);

// ------------------------------------------------------------------ status line
function status(text: string, kind: "" | "err" | "ok" = ""): void {
  const el = $("status");
  el.textContent = text;
  el.className = `status mono ${kind}`;
}

// ------------------------------------------------------------------ running matches in the browser sandbox
let running = false;

type MatchOutcome = { initError: string } | { replay: Replay; result: MatchResult; cost: number };

/** House bots play here, in Web Workers. Ladder bots play on the server: their code never comes to the browser. */
async function playMatch(seed: number, side: PlayerId, opponentValue: string, onProgress?: (tick: number) => void): Promise<MatchOutcome> {
  if (opponentValue.startsWith(LADDER_PREFIX)) return playOnServer(seed, side, opponentValue.slice(LADDER_PREFIX.length));
  const opponent = opponentName(opponentValue);
  const mine = await WorkerBot.create("my-bot", code, (seed * 2 + side) >>> 0);
  const other = side === 1 ? 2 : 1;
  const theirs = await WorkerBot.create(opponent, SAMPLE_BOTS[opponentValue]!, (seed * 2 + other) >>> 0);
  try {
    if (mine.initError) return { initError: mine.initError };
    const bots = side === 1 ? ([mine, theirs] as const) : ([theirs, mine] as const);
    let n = 0;
    const res = await runMatch([bots[0], bots[1]], {
      seed,
      onTick: (s) => {
        if (++n % 20 === 0) onProgress?.(s.tick);
      },
    });
    res.replay.bots = side === 1 ? ["my-bot", opponent] : [opponent, "my-bot"];
    return { replay: res.replay, result: res.state.result!, cost: 0 };
  } finally {
    mine.dispose();
    theirs.dispose();
  }
}

async function playOnServer(seed: number, side: PlayerId, opponentId: string): Promise<MatchOutcome> {
  const r = await fetch("/api/test-game", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: owner(), code, opponent: opponentId, seed, side }),
  });
  const out = (await r.json().catch(() => ({}))) as { replay?: Replay; cost?: number; error?: string; initError?: boolean };
  if (out.initError) return { initError: out.error ?? "init failed" };
  if (!r.ok || !out.replay?.result) {
    if (r.status === 404) void loadLadderBots(); // deleted from the ladder: prune the list
    throw new Error(out.error ?? `HTTP ${r.status}`);
  }
  if (out.cost) window.dispatchEvent(new Event("botcoin-changed"));
  return { replay: out.replay, result: out.replay.result, cost: out.cost ?? 0 };
}

/** Status suffix for a paid server game. */
const paid = (cost: number) => (cost ? ` (server game, ${cost} 🪙)` : "");

function setBusy(b: boolean): void {
  running = b;
  for (const id of ["run-btn", "bench-btn"]) $<HTMLButtonElement>(id).disabled = b;
}

async function runOne(): Promise<void> {
  if (running) return;
  setBusy(true);
  const seed = Number(seedInput.value) >>> 0;
  const side = Number(sideSel.value) as PlayerId;
  const opponent = opponentName(opponentSel.value);
  status(`Running my-bot vs ${opponent} on seed ${seed}${opponentSel.value.startsWith(LADDER_PREFIX) ? " on the server" : ""}…`);
  try {
    const r = await playMatch(seed, side, opponentSel.value, (tick) => status(`Running my-bot vs ${opponent} on seed ${seed}… tick ${tick}`));
    if ("initError" in r) {
      status(`Your bot failed to start:\n${r.initError}`, "err");
      return;
    }
    showReplay(r.replay);
    const res = r.result;
    const errors = r.replay.ticks.flatMap((x) => x.runnerEvents ?? []).filter((e) => e.type === "bot_error" && e.player === side).length;
    const invalid = r.replay.ticks.flatMap((x) => x.events).filter((e) => e.type === "invalid_action" && e.player === side).length;
    const outcome = res.winner === "draw" ? "Draw" : res.winner === side ? "You win" : "You lose";
    const tail = [errors ? `${errors} failed ticks` : "", invalid ? `${invalid} invalid actions` : ""].filter(Boolean).join(", ");
    status(
      `${outcome} — ${res.reason.replace("_", " ")} at tick ${res.tick}, ` +
        (res.units ? `units ${res.units[side - 1]} vs ${res.units[2 - side]}, ` : "") +
        `score ${res.scores[side - 1]} vs ${res.scores[2 - side]}` +
        paid(r.cost) +
        (tail ? `\n${tail} (see Problems)` : ""),
      res.winner === side ? "ok" : res.winner === "draw" ? "" : "err",
    );
    play(true);
  } catch (e) {
    status(`Match crashed: ${e instanceof Error ? e.message : String(e)}`, "err");
  } finally {
    setBusy(false);
  }
}

async function runBench(): Promise<void> {
  if (running) return;
  setBusy(true);
  const opponentValue = opponentSel.value;
  const opponent = opponentName(opponentValue);
  let w = 0;
  let l = 0;
  let d = 0;
  let firstLoss: Replay | null = null;
  let last: Replay | null = null;
  let spent = 0;
  try {
    for (let i = 0; i < 10; i++) {
      const seed = 1 + Math.floor(i / 2);
      const side = ((i % 2) + 1) as PlayerId;
      status(`Benchmark vs ${opponent}: game ${i + 1}/10 (seed ${seed}, P${side})…  ${w}W ${l}L ${d}D`);
      const r = await playMatch(seed, side, opponentValue);
      if ("initError" in r) {
        status(`Your bot failed to start:\n${r.initError}`, "err");
        return;
      }
      last = r.replay;
      spent += r.cost;
      const win = r.result.winner;
      if (win === "draw") d++;
      else if (win === side) w++;
      else {
        l++;
        firstLoss ??= r.replay;
      }
    }
    const shown = firstLoss ?? last!;
    showReplay(shown);
    status(`vs ${opponent}: ${w} wins, ${l} losses, ${d} draws over 10 games.` + paid(Math.round(spent * 100) / 100) + (firstLoss ? "\nShowing your first loss." : ""), w > l ? "ok" : l > w ? "err" : "");
  } catch (e) {
    status(`Benchmark crashed: ${e instanceof Error ? e.message : String(e)}`, "err");
  } finally {
    setBusy(false);
  }
}

$("run-btn").addEventListener("click", () => void runOne());
$("bench-btn").addEventListener("click", () => void runBench());
$("dice-btn").addEventListener("click", () => {
  seedInput.value = String(Math.floor(Math.random() * 100000));
  persistSettings();
});
$("reset-btn").addEventListener("click", () => {
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: STARTER_SOURCE } });
});

// ------------------------------------------------------------------ replay loading
let currentReplay: Replay | null = null;

function showReplay(replay: Replay): boolean {
  try {
    model = new ReplayModel(replay);
    board.resetAim();
  } catch (e) {
    status(e instanceof Error ? e.message : String(e), "err");
    return false;
  }
  currentReplay = replay;
  $<HTMLButtonElement>("download-btn").disabled = false;
  const scrub = $<HTMLInputElement>("scrubber");
  scrub.max = String(model.lastIndex);
  for (const k of Object.keys(charts) as (keyof Series)[]) charts[k].set(model.series[k]);
  buildLogIndex();
  play(false);
  seek(0);
  if (!model.verified) status("Warning: re-simulating this replay did not reproduce its recorded final state.", "err");
  return true;
}

async function loadReplayText(text: string, label: string): Promise<void> {
  try {
    const r = JSON.parse(text) as Replay;
    if (r.format !== "bot-arena-replay") throw new Error("not a Bot Arena replay");
    showReplay(r);
    if (model) status(`Loaded ${label}: ${r.bots[0]} vs ${r.bots[1]}, seed ${r.seed}${model.verified ? " (verified)" : ""}.`, "ok");
  } catch (e) {
    status(`Could not load ${label}: ${e instanceof Error ? e.message : String(e)}`, "err");
  }
}

$<HTMLInputElement>("file-input").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) await loadReplayText(await f.text(), f.name);
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) await loadReplayText(await f.text(), f.name);
});
$("download-btn").addEventListener("click", () => {
  if (!currentReplay) return;
  const blob = new Blob([JSON.stringify(currentReplay)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${currentReplay.bots.join("-vs-")}-seed${currentReplay.seed}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ------------------------------------------------------------------ playback
function seek(i: number): void {
  if (!model) return;
  t = Math.max(0, Math.min(model.lastIndex, i));
  render();
}

function play(on: boolean): void {
  playing = on && !!model;
  if (playing && model && t >= model.lastIndex) t = 0;
  $("play-btn").textContent = playing ? "⏸" : "▶";
  lastFrame = performance.now();
  acc = 0;
}

function frame(now: number): void {
  if (playing && model) {
    const speed = Number($<HTMLSelectElement>("speed").value);
    acc += ((now - lastFrame) / 1000) * 4 * speed; // 1× = 4 ticks per second
    const steps = Math.floor(acc);
    if (steps > 0) {
      acc -= steps;
      seek(t + steps);
      if (t >= model.lastIndex) play(false);
    }
  }
  lastFrame = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

$("play-btn").addEventListener("click", () => play(!playing));

// Theater mode: the board fills the browser window (an in-page overlay, not the Fullscreen API).
let theater = false;
function setTheater(on: boolean): void {
  theater = on;
  document.body.classList.toggle("theater", on);
  const btn = $("theater-btn");
  btn.setAttribute("aria-pressed", String(on));
  btn.textContent = on ? "✕" : "⛶";
  btn.title = on ? "Exit (Esc)" : "Fill the window with the battle (F)";
}
$("theater-btn").addEventListener("click", () => setTheater(!theater));
$("back-btn").addEventListener("click", () => (play(false), seek(t - 1)));
$("fwd-btn").addEventListener("click", () => (play(false), seek(t + 1)));
$<HTMLInputElement>("scrubber").addEventListener("input", (e) => seek(Number((e.target as HTMLInputElement).value)));
document.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest(".cm-editor") || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
  if (e.key === " ") {
    e.preventDefault();
    play(!playing);
  } else if (e.key === "f" || e.key === "F") {
    setTheater(!theater);
  } else if (e.key === "Escape" && theater) {
    setTheater(false);
  } else if (e.key === "ArrowLeft") {
    play(false);
    seek(t - (e.shiftKey ? 10 : 1));
  } else if (e.key === "ArrowRight") {
    play(false);
    seek(t + (e.shiftKey ? 10 : 1));
  }
});
for (const r of document.querySelectorAll<HTMLInputElement>("input[name=fog]")) {
  r.addEventListener("change", () => {
    opts.fog = Number(r.value) as 0 | 1 | 2;
    render();
  });
}
$<HTMLInputElement>("marks-toggle").addEventListener("change", (e) => {
  opts.marks = (e.target as HTMLInputElement).checked;
  render();
});
$<HTMLInputElement>("attacks-toggle").addEventListener("change", (e) => {
  opts.attacks = (e.target as HTMLInputElement).checked;
  render();
});

// ------------------------------------------------------------------ rendering
function render(): void {
  if (!model) return;
  const state = model.states[t]!;
  const events = model.eventsAt(t);
  board.draw(state, events, opts);
  $<HTMLInputElement>("scrubber").value = String(t);
  $("tick-label").textContent = `${state.tick} / ${CONFIG.match.maxTicks}`;
  for (const c of Object.values(charts)) c.setCurrent(t);
  renderStats(state);
  renderLogs();
  const banner = $("result-banner");
  if (state.result && t === model.lastIndex) {
    const r = state.result;
    const names = model.replay.bots;
    const tally = (r.units ? `units ${r.units[0]} : ${r.units[1]} · ` : "") + `score ${r.scores[0]} : ${r.scores[1]}`;
    banner.textContent =
      r.winner === "draw" ? `Draw · ${tally}` : `${names[r.winner - 1]} (P${r.winner}) wins · ${r.reason.replace("_", " ")} · ${tally}`;
    banner.hidden = false;
  } else banner.hidden = true;
}

function renderStats(s: GameState): void {
  if (!model) return;
  const names = model.replay.bots;
  const sc = model.series.score;
  const count = (p: PlayerId, type: string) => s.units.filter((u) => u.owner === p && u.type === type).length;
  const turrets = (p: PlayerId) => s.structures.filter((x) => x.owner === p && x.type === "turret").length;
  const ups = (p: PlayerId) => s.players[p - 1]!.upgrades?.join(", ") || "–";
  const row = (label: string, f: (p: PlayerId) => string | number) => `<tr><td>${label}</td><td>${f(1)}</td><td>${f(2)}</td></tr>`;
  $("stats").innerHTML = `
    <table class="stats-table">
      <thead><tr><th></th>
        <th><span class="dot p1"></span> <span class="name" title="${esc(names[0])}">${esc(names[0])}</span></th>
        <th><span class="dot p2"></span> <span class="name" title="${esc(names[1])}">${esc(names[1])}</span></th></tr></thead>
      <tbody>
        ${row("Score", (p) => sc[p - 1]![t] ?? 0)}
        ${row("Energy", (p) => s.players[p - 1]!.energy)}
        ${row("Crystal", (p) => s.players[p - 1]!.crystal)}
        ${row("Bases", (p) => s.bases.filter((b) => b.owner === p && b.hp > 0).length)}
        ${row("Base HP", (p) => s.bases.reduce((hp, b) => hp + (b.owner === p ? Math.max(0, b.hp) : 0), 0))}
        ${row("Workers", (p) => count(p, "worker"))}
        ${row("Fighters", (p) => count(p, "fighter"))}
        ${row("Scouts", (p) => count(p, "scout"))}
        ${row("Turrets", (p) => turrets(p))}
        ${row("Upgrades", ups)}
      </tbody>
    </table>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ------------------------------------------------------------------ logs
type LogEntry = { t: number; player: PlayerId; text: string; err: boolean };
let logIndex: { logs: LogEntry[]; problems: LogEntry[] } = { logs: [], problems: [] };

function describeAction(a: unknown): string {
  try {
    const s = JSON.stringify(a);
    return s && s !== "null" ? ` ${s.length > 90 ? s.slice(0, 90) + "…" : s}` : "";
  } catch {
    return "";
  }
}

function buildLogIndex(): void {
  logIndex = { logs: [], problems: [] };
  if (!model) return;
  for (let i = 1; i <= model.lastIndex; i++) {
    for (const e of model.eventsAt(i) as GameEvent[]) {
      if (e.type === "log") logIndex.logs.push({ t: i - 1, player: e.player, text: e.text, err: false });
      else if (e.type === "invalid_action") logIndex.problems.push({ t: i - 1, player: e.player, text: `${e.reason}${describeAction(e.action)}`, err: true });
      else if (e.type === "bot_error") logIndex.problems.push({ t: i - 1, player: e.player, text: `bot error: ${e.message}`, err: true });
    }
  }
  const badge = $("problem-count");
  badge.textContent = String(logIndex.problems.length);
  badge.classList.toggle("hot", logIndex.problems.length > 0);
}

function renderLogs(): void {
  const show1 = $<HTMLInputElement>("log-p1").checked;
  const show2 = $<HTMLInputElement>("log-p2").checked;
  const list = logIndex[logTab].filter((e) => e.t < t && (e.player === 1 ? show1 : show2)).slice(-300);
  const el = $("log-list");
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.innerHTML = list.length
    ? list
        .map((e) => `<div class="log-row${e.err ? " err" : ""}" data-t="${e.t}"><span class="t">${e.t}</span><span class="who p${e.player}">P${e.player}</span><span class="msg">${esc(e.text)}</span></div>`)
        .join("")
    : `<div class="log-empty">${logTab === "logs" ? "No bot logs yet. Return { type: \"log\", text } actions to print here." : "No problems so far."}</div>`;
  if (atBottom || playing) el.scrollTop = el.scrollHeight;
}

$("log-list").addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".log-row");
  if (row) {
    play(false);
    seek(Number(row.dataset.t) + 1);
  }
});
for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  tab.addEventListener("click", () => {
    logTab = tab.dataset.tab as "logs" | "problems";
    for (const x of document.querySelectorAll(".tab")) x.classList.toggle("active", x === tab);
    renderLogs();
  });
}
for (const id of ["log-p1", "log-p2"]) $(id).addEventListener("change", renderLogs);

// ------------------------------------------------------------------ hover info
$("board").addEventListener("mousemove", (e) => {
  if (!model) return;
  const s = model.states[t]!;
  const p = board.tileAt(e.clientX, e.clientY, s.map.size);
  const info = $("hover-info");
  if (!p) return void (info.textContent = "");
  const parts = [`(${p.x}, ${p.y})`];
  const at = (o: { x: number; y: number }) => o.x === p.x && o.y === p.y;
  for (const n of s.nodes.filter(at)) parts.push(`${n.type} node #${n.id}: ${n.amount}`);
  for (const b of s.bases.filter((b) => b.hp > 0 && at(b))) parts.push(`P${b.owner} base #${b.id}: ${b.hp} HP`);
  for (const x of s.structures.filter(at)) parts.push(`P${x.owner} ${x.upgraded ? "upgraded " : ""}${x.type} #${x.id}: ${x.hp} HP`);
  for (const u of s.units.filter(at)) {
    const cargo = u.cargo.energy || u.cargo.crystal ? ` cargo ${u.cargo.energy}E ${u.cargo.crystal}C` : "";
    parts.push(`P${u.owner} ${u.upgraded ? "upgraded " : ""}${u.type} #${u.id}: ${u.hp} HP${cargo}`);
  }
  if (s.map.tiles[p.y * s.map.size + p.x] === "#") parts.push("wall");
  info.textContent = parts.join(" · ");
});
$("board").addEventListener("mouseleave", () => ($("hover-info").textContent = ""));

// ------------------------------------------------------------------ README dialog
const dialog = $<HTMLDialogElement>("readme-dialog");
$("readme-body").innerHTML = marked.parse(botApiMarkdown, { async: false }) as string;
$("readme-btn").addEventListener("click", () => dialog.showModal());
$("close-readme").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});
$("copy-readme").addEventListener("click", async () => {
  const btn = $("copy-readme");
  try {
    await navigator.clipboard.writeText(botApiMarkdown);
    btn.textContent = "Copied ✓";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy markdown"), 1500);
});

// ------------------------------------------------------------------ "How to play" (auto-opens on the first visit)
const HOWTO_KEY = "bot-arena:howto-seen";
const howto = $<HTMLDialogElement>("howto-dialog");
const closeHowto = () => {
  howto.close();
  save(HOWTO_KEY, "1");
};
$("howto-btn").addEventListener("click", () => howto.showModal());
$("close-howto").addEventListener("click", closeHowto);
$("howto-go").addEventListener("click", closeHowto);
howto.addEventListener("close", () => save(HOWTO_KEY, "1"));
howto.addEventListener("click", (e) => {
  if (e.target === howto) closeHowto();
});
$("howto-copy").addEventListener("click", async () => {
  const btn = $("howto-copy");
  try {
    await navigator.clipboard.writeText(botApiMarkdown);
    btn.textContent = "Copied ✓";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy README"), 1500);
});
if (!load(HOWTO_KEY)) howto.showModal();

// ------------------------------------------------------------------ layout
const ro = new ResizeObserver(() => {
  board.resize();
  for (const c of Object.values(charts)) c.draw();
  render();
});
ro.observe($("board"));
for (const el of document.querySelectorAll<HTMLElement>(".chart")) ro.observe(el);

// ------------------------------------------------------------------ ranked ladder (only when served by `arena server`)
void initLadder({
  botDeleted: () => {
    void loadLadderBots().then(persistSettings);
  },
  getCode: () => code,
  showReplay: (r) => {
    if (!showReplay(r)) return false;
    play(true);
    return true;
  },
  status,
});

// ------------------------------------------------------------------ startup
(async () => {
  const replayUrl = new URLSearchParams(location.search).get("replay");
  if (replayUrl) {
    try {
      const res = await fetch(replayUrl);
      await loadReplayText(await res.text(), replayUrl);
      return;
    } catch (e) {
      status(`Could not fetch ${replayUrl}: ${String(e)}`, "err");
    }
  }
  await runOne();
})();
