import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { betPayout, ECON, Economy, emptyEconomy, resetEconomyForSeason } from "../src/economy.js";
import { JsonFileStore, Ladder, SubmitError, type MatchRecord } from "../src/index.js";

const W = "w".repeat(8);
const A = "a".repeat(64);
const B = "b".repeat(64);

function clock(start = "2026-11-13T10:00:00Z") {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (h: number) => (t += h * 3600_000) };
}

function match(id: string, p1: { id: string; elo: number }, p2: { id: string; elo: number }, winner: 1 | 2 | "draw"): MatchRecord {
  const side = (s: { id: string; elo: number }) => ({ id: s.id, name: s.id, version: 1, eloBefore: s.elo, eloAfter: s.elo, score: 0 });
  return { id, at: "", seed: 1, p1: side(p1), p2: side(p2), winner, reason: "x", tick: 1 };
}

describe("wallets", () => {
  it("the starting grant is credited once", () => {
    const e = new Economy(emptyEconomy());
    expect(e.ensureWallet(W)).toBe(true);
    expect(e.ensureWallet(W)).toBe(false);
    expect(e.wallet(W)!.balance).toBe(ECON.startingGrant);
  });

  it("the stipend can be claimed once per UTC day", () => {
    const c = clock("2026-11-13T23:00:00Z");
    const e = new Economy(emptyEconomy(), c.now);
    expect(() => e.claimStipend(W)).toThrow(/no botcoin wallet/);
    e.ensureWallet(W);
    e.claimStipend(W);
    expect(() => e.claimStipend(W)).toThrow(/already claimed/);
    expect(e.stipendAvailable(W)).toBe(false);
    c.advance(1); // past UTC midnight
    expect(e.stipendAvailable(W)).toBe(true);
    e.claimStipend(W);
    expect(e.wallet(W)!.balance).toBe(ECON.startingGrant + 2 * ECON.dailyStipend);
  });

  it("debits never go negative and change nothing on failure", () => {
    const e = new Economy(emptyEconomy());
    e.ensureWallet(W);
    expect(() => e.debit(W, ECON.startingGrant + 1, "boost")).toThrow(/not enough botcoin/);
    expect(e.wallet(W)!.balance).toBe(ECON.startingGrant);
    e.debit(W, ECON.startingGrant, "boost");
    expect(e.wallet(W)!.balance).toBe(0);
  });

  it("win payouts merge into one ledger line per bot", () => {
    const e = new Economy(emptyEconomy());
    e.ensureWallet(W);
    for (let i = 0; i < 3; i++) e.recordGame(match(`m${i}`, { id: "x", elo: 1200 }, { id: "y", elo: 1200 }, 1), { p1: W, p2: null });
    e.recordGame(match("m9", { id: "x", elo: 1200 }, { id: "y", elo: 1200 }, "draw"), { p1: W, p2: null });
    const w = e.wallet(W)!;
    expect(w.balance).toBe(100.31); // 100 + 3 × 0.1 + 0.01, kept to the cent
    expect(w.ledger.find((l) => l.kind === "win")!.delta).toBe(0.3);
    expect(w.ledger.map((l) => [l.kind, l.count ?? 1])).toEqual([["grant", 1], ["win", 3], ["draw", 1]]);
  });
});

describe("bets", () => {
  it("payout = stake × actual/expected, clamped to [0, 3×]", () => {
    const even = Array.from({ length: 4 }, () => ({ matchId: "", expected: 0.5, result: 0.5 }));
    expect(betPayout(100, even)).toBe(100);
    expect(betPayout(100, even.map((g) => ({ ...g, result: 0 })))).toBe(0);
    // Underdog (expected 0.1) wins everything: 10× is clamped to 3×.
    expect(betPayout(100, even.map(() => ({ matchId: "", expected: 0.1, result: 1 })))).toBe(300);
    expect(betPayout(100, even.map((g, i) => ({ ...g, result: i < 3 ? 1 : 0 })))).toBe(150);
  });

  it("counts the bot's next N games, then settles into the wallet", () => {
    const e = new Economy(emptyEconomy());
    e.ensureWallet(W);
    expect(() => e.placeBet(W, "x", "x", 3, 4)).toThrow(/stake/);
    expect(() => e.placeBet(W, "x", "x", 10, 5)).toThrow(/games/);
    e.placeBet(W, "x", "x", 40, 4);
    expect(() => e.placeBet(W, "x", "x", 10, 4)).toThrow(/open bet/);
    expect(e.wallet(W)!.balance).toBe(ECON.startingGrant - 40);
    // Even Elo, 3 wins and a loss → 1.5× → 60. The bot is p2 in some games.
    e.recordGame(match("m1", { id: "x", elo: 1200 }, { id: "y", elo: 1200 }, 1), { p1: null, p2: null });
    e.recordGame(match("m2", { id: "y", elo: 1200 }, { id: "x", elo: 1200 }, 2), { p1: null, p2: null });
    e.recordGame(match("m3", { id: "y", elo: 1200 }, { id: "x", elo: 1200 }, 1), { p1: null, p2: null });
    expect(e.openBet("x")!.counted).toHaveLength(3);
    e.recordGame(match("m4", { id: "x", elo: 1200 }, { id: "z", elo: 1200 }, 1), { p1: null, p2: null });
    expect(e.openBet("x")).toBeUndefined();
    const bet = e.data.bets[0]!;
    expect(bet.payout).toBe(60);
    expect(bet.outcome).toBe("settled");
    expect(e.wallet(W)!.balance).toBe(ECON.startingGrant - 40 + 60);
  });

  it("refunds open bets (deleted bot, season reset)", () => {
    const e = new Economy(emptyEconomy());
    e.ensureWallet(W);
    e.placeBet(W, "x", "x", 50, 4);
    e.placeBet(W, "y", "y", 20, 4);
    expect(e.refundBets("x")).toBe(1);
    expect(e.wallet(W)!.balance).toBe(ECON.startingGrant - 20);
    const next = resetEconomyForSeason(e.data);
    expect(next.wallets[W]!.balance).toBe(ECON.startingGrant);
    expect(next.bets).toEqual([]);
  });
});

describe("submission costs (Ladder)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function ladder() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ladder-econ-"));
    dirs.push(d);
    const l = new Ladder(new JsonFileStore(d));
    const c = clock();
    l.now = c.now;
    return { l, c };
  }
  const bal = (l: Ladder, owner: string) => l.walletView(owner).balance;

  it("first bot free, further bots cost, one free update per bot per day", () => {
    const { l, c } = ladder();
    expect(l.walletView(A).exists).toBe(false);
    expect(l.submit("one", "x", { owner: A }).cost).toBe(0);
    expect(bal(l, A)).toBe(ECON.startingGrant);
    expect(l.submit("two", "x", { owner: A }).cost).toBe(ECON.newBotCost);
    expect(bal(l, A)).toBe(ECON.startingGrant - ECON.newBotCost);
    expect(l.submit("two", "x", { owner: A }).cost).toBe(0); // today's free update
    expect(l.submit("two", "x", { owner: A }).cost).toBe(ECON.updateCost);
    expect(l.submit("one", "x", { owner: A }).cost).toBe(0); // per bot
    c.advance(24);
    expect(l.submit("two", "x", { owner: A }).cost).toBe(0);
    expect(bal(l, A)).toBe(ECON.startingGrant - ECON.newBotCost - ECON.updateCost);
  });

  it("a broke owner gets 402 and nothing changes", () => {
    const { l } = ladder();
    l.submit("one", "x", { owner: B });
    l.economy.debit(Object.keys(l.economy.data.wallets)[0]!, ECON.startingGrant - 1, "admin");
    const before = JSON.stringify(l.data);
    expect(() => l.submit("two", "x", { owner: B })).toThrow(SubmitError);
    try {
      l.submit("two", "x", { owner: B });
    } catch (e) {
      expect((e as SubmitError).status).toBe(402);
    }
    expect(JSON.stringify(l.data)).toBe(before);
  });

  it("owners from before botcoin get a wallet at startup", () => {
    const { l } = ladder();
    l.submit("old", "x", { owner: A });
    delete l.data.economy!.wallets[Object.keys(l.data.economy!.wallets)[0]!];
    expect(l.walletView(A).exists).toBe(false);
    expect(l.openLegacyWallets()).toBe(1);
    expect(bal(l, A)).toBe(ECON.startingGrant);
    expect(l.openLegacyWallets()).toBe(0);
  });
});
