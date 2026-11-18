import { baseSpec, CONFIG, computeVisibility, maxHp, placementRange, TILE, zoneCenter, zoneRadius, type GameEvent, type GameState, type PlayerId } from "@arena/engine";
import { onSpriteLoad, sprite, spriteFor, tintedSprite, type SpriteName } from "./sprites.js";

export const COLORS = {
  p1: "#3987e5",
  p2: "#d95926",
  floor: "#1a1a19",
  grid: "#20201e",
  wall: "#4a4944",
  energy: "#e3b23c",
  crystal: "#5ad1e6",
  zone: "#e5484d",
  fog: "rgba(8,8,7,0.62)",
  text: "#f0efec",
  hpBack: "rgba(0,0,0,0.6)",
  hpGood: "#3fb950",
  hpLow: "#e5484d",
};

const playerColor = (p: PlayerId) => (p === 1 ? COLORS.p1 : COLORS.p2);

export interface RenderOptions {
  fog: 0 | 1 | 2;
  marks: boolean;
  attacks: boolean;
}

export class BoardRenderer {
  private ctx: CanvasRenderingContext2D;
  cell = 16;

  private last: [GameState, GameEvent[], RenderOptions] | null = null;
  /** Turret id → direction (radians) its head last pointed, so it holds aim between shots. */
  private turretAim = new Map<number, number>();
  /** The turret art's barrel points up-right (−45°); rotate by the difference. */
  private static readonly TURRET_ART_ANGLE = -Math.PI / 4;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    // Sprites load asynchronously; repaint the last frame when each one arrives.
    onSpriteLoad(() => this.last && this.draw(...this.last));
  }

  /** Draw a sprite centred on (cx, cy) at `size` px. Returns false if it hasn't loaded yet. */
  private sprite(name: SpriteName, cx: number, cy: number, size: number, rotation = 0): boolean {
    const img = sprite(name);
    if (!img) return false;
    const { ctx } = this;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (rotation) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rotation);
      ctx.drawImage(img, -size / 2, -size / 2, size, size);
      ctx.restore();
    } else ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    return true;
  }

  /** Size the backing store to the element's CSS size × devicePixelRatio. */
  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const px = Math.max(160, Math.floor(Math.min(r.width, r.height) * dpr));
    this.canvas.width = px;
    this.canvas.height = px;
  }

  /** Forget turret aims (call when a different replay is loaded; entity ids restart). */
  resetAim(): void {
    this.turretAim.clear();
  }

  /** Tile under a client-space point, or null. */
  tileAt(clientX: number, clientY: number, size: number): { x: number; y: number } | null {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor(((clientX - r.left) / r.width) * size);
    const y = Math.floor(((clientY - r.top) / r.height) * size);
    return x >= 0 && y >= 0 && x < size && y < size ? { x, y } : null;
  }

  draw(state: GameState, events: GameEvent[], opts: RenderOptions): void {
    this.last = [state, events, opts];
    const { ctx } = this;
    const size = state.map.size;
    const c = (this.cell = this.canvas.width / size);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Terrain
    ctx.fillStyle = COLORS.floor;
    ctx.fillRect(0, 0, size * c, size * c);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < size; i++) {
      ctx.moveTo(i * c, 0);
      ctx.lineTo(i * c, size * c);
      ctx.moveTo(0, i * c);
      ctx.lineTo(size * c, i * c);
    }
    ctx.stroke();
    ctx.fillStyle = COLORS.wall;
    for (let i = 0; i < state.map.tiles.length; i++) {
      if (state.map.tiles[i] !== TILE.wall) continue;
      ctx.fillRect((i % size) * c, Math.floor(i / size) * c, c, c);
    }

    const vis = opts.fog ? computeVisibility(state, opts.fog) : null;
    const seen = (x: number, y: number) => !vis || vis[y * size + x] === 1;

    // Nodes (terrain is static, so node tiles always show; amounts only when visible)
    for (const n of state.nodes) {
      const max = CONFIG.nodes[n.type].max;
      const frac = Math.max(0.15, n.amount / max);
      ctx.fillStyle = n.type === "energy" ? COLORS.energy : COLORS.crystal;
      ctx.globalAlpha = n.amount > 0 ? 0.35 + 0.65 * frac : 0.2;
      const cx = n.x * c + c / 2;
      const cy = n.y * c + c / 2;
      ctx.beginPath();
      if (n.type === "energy") ctx.rect(n.x * c + c * 0.12, n.y * c + c * 0.12, c * 0.76, c * 0.76);
      else {
        ctx.moveTo(cx, n.y * c + c * 0.06);
        ctx.lineTo(n.x * c + c * 0.94, cy);
        ctx.lineTo(cx, n.y * c + c * 0.94);
        ctx.lineTo(n.x * c + c * 0.06, cy);
        ctx.closePath();
      }
      ctx.fill();
      ctx.globalAlpha = 1;
      if (seen(n.x, n.y) && c >= 12) this.label(String(n.amount), cx, cy, c * 0.38, "#111");
    }

    // Bases
    for (const b of state.bases) {
      if (b.hp <= 0) continue;
      const visible = seen(b.x, b.y) || b.owner === opts.fog;
      if (!visible) continue;
      const race = state.players[b.owner - 1]!.race;
      // Bases are drawn bigger than their tile. Near the map edge, nudge the drawing inward (and leave room
      // for the HP bar above it) so it stays on the board instead of being cut off.
      const half = c * 0.88;
      const boardPx = state.map.size * c;
      const bx = Math.min(Math.max(b.x * c + c / 2, half), boardPx - half);
      const by = Math.min(Math.max(b.y * c + c / 2, half + c * 0.3), boardPx - half);
      if (race === "tumor") {
        // Tumor Cell: a round cell with a dark nucleus, plus its build zone outline for its owner.
        this.drawCell(bx, by, c * 0.75, playerColor(b.owner), c * 0.3);
        if (opts.fog === 0 || opts.fog === b.owner) {
          const r = placementRange("purificationCell", race, state.players[b.owner - 1]!.upgrades);
          ctx.strokeStyle = playerColor(b.owner);
          ctx.globalAlpha = 0.12;
          ctx.strokeRect((b.x - r) * c, (b.y - r) * c, (2 * r + 1) * c, (2 * r + 1) * c);
          ctx.globalAlpha = 1;
        }
      } else {
        ctx.fillStyle = playerColor(b.owner);
        ctx.fillRect(bx - c * 0.85, by - c * 0.85, c * 1.7, c * 1.7);
        ctx.strokeStyle = COLORS.text;
        ctx.lineWidth = Math.max(1, c * 0.08);
        ctx.strokeRect(bx - c * 0.85, by - c * 0.85, c * 1.7, c * 1.7);
        this.sprite("base", bx, by, c * 1.55);
      }
      this.hpBar(bx - c * 0.85, by - c * 1.1, c * 1.7, b.hp / baseSpec(race).hp);
    }

    // Turret aim: face this tick's target; otherwise keep the last aim (default: the enemy base).
    const turretTargets = new Map<number, { x: number; y: number }>();
    {
      const pos = new Map<number, { x: number; y: number }>();
      for (const u of state.units) pos.set(u.id, u);
      for (const s of state.structures) pos.set(s.id, s);
      for (const b of state.bases) pos.set(b.id, b);
      for (const e of events) if (e.type === "death") pos.set(e.id, e);
      for (const e of events) {
        if (e.type !== "attack") continue;
        const tgt = pos.get(e.targetId);
        if (tgt) turretTargets.set(e.attackerId, tgt);
      }
    }
    for (const s of state.structures) {
      if (s.type !== "turret") continue;
      const tgt = turretTargets.get(s.id);
      if (tgt) this.turretAim.set(s.id, Math.atan2(tgt.y - s.y, tgt.x - s.x));
      else if (!this.turretAim.has(s.id)) {
        const enemy = state.bases.find((b) => b.owner !== s.owner && b.hp > 0);
        if (enemy) this.turretAim.set(s.id, Math.atan2(enemy.y - s.y, enemy.x - s.x));
      }
    }

    // Structures
    for (const s of state.structures) {
      if (opts.fog && s.owner !== opts.fog && !seen(s.x, s.y)) continue;
      const col = playerColor(s.owner);
      const x = s.x * c;
      const y = s.y * c;
      if (s.type === "purificationCell" || s.type === "siegeCell") {
        // Tumor buildings: cells. Purification has a cross; Siege has a long spine toward its target.
        this.drawCell(x + c / 2, y + c / 2, c * 0.46, col, 0);
        ctx.strokeStyle = "#f0efec";
        ctx.lineWidth = Math.max(1, c * 0.12);
        ctx.beginPath();
        if (s.type === "purificationCell") {
          ctx.moveTo(x + c / 2, y + c * 0.25);
          ctx.lineTo(x + c / 2, y + c * 0.75);
          ctx.moveTo(x + c * 0.25, y + c / 2);
          ctx.lineTo(x + c * 0.75, y + c / 2);
        } else {
          const tgt = turretTargets.get(s.id);
          const a = tgt ? Math.atan2(tgt.y - s.y, tgt.x - s.x) : -Math.PI / 4;
          ctx.moveTo(x + c / 2, y + c / 2);
          ctx.lineTo(x + c / 2 + Math.cos(a) * c * 0.6, y + c / 2 + Math.sin(a) * c * 0.6);
        }
        ctx.stroke();
        if (opts.fog === 0 || opts.fog === s.owner) {
          ctx.strokeStyle = col;
          ctx.globalAlpha = 0.15;
          const r = CONFIG.structures[s.type].range;
          ctx.strokeRect((s.x - r) * c, (s.y - r) * c, (2 * r + 1) * c, (2 * r + 1) * c);
          ctx.globalAlpha = 1;
        }
      } else if (s.type === "wall") {
        if (!this.sprite(spriteFor("wall", s.upgrades.length > 0), x + c / 2, y + c / 2, c)) {
          ctx.fillStyle = "#6b6a63";
          ctx.fillRect(x + 1, y + 1, c - 2, c - 2);
        }
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(1, c * 0.1);
        ctx.strokeRect(x + c * 0.05, y + c * 0.05, c * 0.9, c * 0.9);
      } else {
        // Turret: player-colored square plate under the turret art, distinct from round unit plates.
        ctx.fillStyle = col;
        ctx.fillRect(x + c * 0.04, y + c * 0.04, c * 0.92, c * 0.92);
        const aim = this.turretAim.get(s.id) ?? BoardRenderer.TURRET_ART_ANGLE;
        if (!this.sprite("turret", x + c / 2, y + c / 2, c * 0.96, aim - BoardRenderer.TURRET_ART_ANGLE)) {
          ctx.fillStyle = "#1a1a19";
          ctx.fillRect(x + c * 0.3, y + c * 0.3, c * 0.4, c * 0.4);
          ctx.strokeStyle = "#f0efec";
          ctx.lineWidth = Math.max(1, c * 0.08);
          ctx.beginPath();
          ctx.moveTo(x + c / 2, y + c * 0.12);
          ctx.lineTo(x + c / 2, y + c * 0.88);
          ctx.moveTo(x + c * 0.12, y + c / 2);
          ctx.lineTo(x + c * 0.88, y + c / 2);
          ctx.stroke();
        }
        if (opts.fog === 0 || opts.fog === s.owner) {
          ctx.strokeStyle = col;
          ctx.globalAlpha = 0.18;
          const r = CONFIG.structures.turret.range;
          ctx.strokeRect((s.x - r) * c, (s.y - r) * c, (2 * r + 1) * c, (2 * r + 1) * c);
          ctx.globalAlpha = 1;
        }
      }
      if (s.upgrades.length) this.upgradeBadge(x + c * 0.82, y + c * 0.18, c);
      this.hpBar(x + c * 0.1, y - c * 0.05, c * 0.8, s.hp / maxHp(s), true);
    }

    // Units
    for (const u of state.units) {
      if (opts.fog && u.owner !== opts.fog && !seen(u.x, u.y)) continue;
      const col = playerColor(u.owner);
      const cx = u.x * c + c / 2;
      const cy = u.y * c + c / 2;
      const upgraded = u.upgrades.length > 0;
      // Upgraded units keep more of their art so the cyan glow survives the team tint.
      const img = tintedSprite(spriteFor(u.type, upgraded), col, upgraded ? 0.5 : 0.3);
      if (u.type === "stemCell" || u.type === "immuneCell") {
        // Tumor units: small round stem cells, larger lumpy immune cells.
        this.drawCell(cx, cy, c * (u.type === "stemCell" ? 0.3 : 0.42), col, u.type === "stemCell" ? c * 0.12 : 0, u.type === "immuneCell");
      } else if (img) {
        // Faction-tinted art, no backing plate. Size encodes role:
        // workers are small, fighters loom over their tile, scouts sit in between.
        const size = c * (u.type === "worker" ? 0.85 : u.type === "fighter" ? 1.3 : 1.05) * (upgraded ? 1.12 : 1);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
      } else {
        ctx.fillStyle = col;
        ctx.strokeStyle = COLORS.floor;
        ctx.lineWidth = Math.max(1, c * 0.1);
        ctx.beginPath();
        if (u.type === "worker") ctx.arc(cx, cy, c * 0.34, 0, Math.PI * 2);
        else if (u.type === "fighter") {
          ctx.moveTo(cx, cy - c * 0.42);
          ctx.lineTo(cx + c * 0.4, cy + c * 0.34);
          ctx.lineTo(cx - c * 0.4, cy + c * 0.34);
          ctx.closePath();
        } else {
          ctx.moveTo(cx, cy - c * 0.36);
          ctx.lineTo(cx + c * 0.3, cy);
          ctx.lineTo(cx, cy + c * 0.36);
          ctx.lineTo(cx - c * 0.3, cy);
          ctx.closePath();
        }
        ctx.fill();
        ctx.stroke();
      }
      const carried = u.cargo.energy + u.cargo.crystal;
      if (carried > 0) {
        // Cargo pip in the bottom-right corner so it doesn't hide the art.
        ctx.fillStyle = u.cargo.crystal > u.cargo.energy ? COLORS.crystal : COLORS.energy;
        ctx.strokeStyle = COLORS.floor;
        ctx.lineWidth = Math.max(1, c * 0.05);
        ctx.beginPath();
        ctx.arc(cx + c * 0.3, cy + c * 0.3, c * 0.15, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      if (upgraded) this.upgradeBadge(cx - c * 0.3, cy - c * 0.3, c);
      const max = maxHp(u);
      if (u.hp < max) this.hpBar(u.x * c + c * 0.1, u.y * c - c * 0.02, c * 0.8, u.hp / max, true);
    }

    // Attack lines from this tick's events
    if (opts.attacks) {
      const pos = new Map<number, { x: number; y: number; owner: PlayerId }>();
      for (const u of state.units) pos.set(u.id, u);
      for (const s of state.structures) pos.set(s.id, s);
      for (const b of state.bases) pos.set(b.id, b);
      for (const e of events) if (e.type === "death") pos.set(e.id, e);
      ctx.lineWidth = Math.max(1, c * 0.1);
      for (const e of events) {
        if (e.type !== "attack") continue;
        const a = pos.get(e.attackerId);
        const t = pos.get(e.targetId);
        if (!a || !t) continue;
        if (opts.fog && !(seen(a.x, a.y) || a.owner === opts.fog)) continue;
        ctx.strokeStyle = playerColor(a.owner);
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(a.x * c + c / 2, a.y * c + c / 2);
        ctx.lineTo(t.x * c + c / 2, t.y * c + c / 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      for (const e of events) {
        if (e.type !== "death") continue;
        if (opts.fog && !seen(e.x, e.y) && e.owner !== opts.fog) continue;
        ctx.strokeStyle = COLORS.text;
        ctx.lineWidth = Math.max(1, c * 0.1);
        ctx.beginPath();
        ctx.moveTo(e.x * c + c * 0.2, e.y * c + c * 0.2);
        ctx.lineTo(e.x * c + c * 0.8, e.y * c + c * 0.8);
        ctx.moveTo(e.x * c + c * 0.8, e.y * c + c * 0.2);
        ctx.lineTo(e.x * c + c * 0.2, e.y * c + c * 0.8);
        ctx.stroke();
      }
    }

    // Fog overlay
    if (vis) {
      ctx.fillStyle = COLORS.fog;
      for (let i = 0; i < vis.length; i++) if (!vis[i]) ctx.fillRect((i % size) * c, Math.floor(i / size) * c, c, c);
    }

    // Zone (radius in effect for the tick about to resolve)
    const r = zoneRadius(state.tick);
    if (r < CONFIG.zone.initialRadius) {
      const z = zoneCenter(state);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, size * c, size * c);
      ctx.arc(z.x * c + c / 2, z.y * c + c / 2, r * c, 0, Math.PI * 2, true);
      ctx.fillStyle = "rgba(229,72,77,0.13)";
      ctx.fill("evenodd");
      ctx.restore();
      ctx.strokeStyle = COLORS.zone;
      ctx.lineWidth = Math.max(1.5, c * 0.12);
      ctx.beginPath();
      ctx.arc(z.x * c + c / 2, z.y * c + c / 2, r * c, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Debug marks (bot-provided)
    if (opts.marks) {
      for (const e of events) {
        if (e.type !== "mark") continue;
        if (opts.fog && e.player !== opts.fog) continue;
        const col = e.color || playerColor(e.player);
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(1, c * 0.12);
        ctx.strokeRect(e.x * c + c * 0.08, e.y * c + c * 0.08, c * 0.84, c * 0.84);
        if (e.label) this.label(e.label, e.x * c + c / 2, e.y * c - c * 0.3, c * 0.45, col, true);
      }
    }
  }

  private hpBar(x: number, y: number, w: number, frac: number, thin = false): void {
    const h = Math.max(2, this.cell * (thin ? 0.12 : 0.18));
    this.ctx.fillStyle = COLORS.hpBack;
    this.ctx.fillRect(x, y, w, h);
    this.ctx.fillStyle = frac > 0.35 ? COLORS.hpGood : COLORS.hpLow;
    this.ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), h);
  }

  /** A Tumor-race cell: a membrane in the player's colour, optionally lumpy, with an optional dark nucleus. */
  private drawCell(cx: number, cy: number, r: number, color: string, nucleus: number, lumpy = false): void {
    paintCell(this.ctx, cx, cy, r, color, nucleus, lumpy);
  }

  /** Small gold chevron marking an upgraded unit or wall. */
  private upgradeBadge(x: number, y: number, c: number): void {
    const { ctx } = this;
    const r = Math.max(2.5, c * 0.16);
    ctx.fillStyle = "#f2b84b";
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.lineWidth = Math.max(1, c * 0.04);
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y + r * 0.6);
    ctx.lineTo(x, y + r * 0.1);
    ctx.lineTo(x - r, y + r * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  private label(text: string, x: number, y: number, px: number, color: string, halo = false): void {
    const { ctx } = this;
    ctx.font = `600 ${Math.max(7, px)}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (halo) {
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.lineWidth = 3;
      ctx.strokeText(text, x, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }
}

/** Paints a Tumor-race cell: a membrane in `color`, optionally lumpy, with an optional dark nucleus. */
function paintCell(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string, nucleus: number, lumpy = false): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = COLORS.text;
  ctx.lineWidth = Math.max(1, r * 0.14);
  ctx.beginPath();
  if (lumpy) {
    for (let i = 0; i <= 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const rr = r * (0.88 + 0.12 * Math.sin(a * 5));
      if (i === 0) ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      else ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    ctx.closePath();
  } else ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (nucleus > 0) {
    ctx.fillStyle = "#2a1f35";
    ctx.beginPath();
    ctx.arc(cx, cy, nucleus, 0, Math.PI * 2);
    ctx.fill();
  }
}

const iconCache = new Map<string, string>();

/**
 * A legend icon (data URL) for the Tumor race's entities, drawn like the board draws them, or undefined for
 * types that have sprite art. `type` is a unit/structure type, or "tumorCell" for the Tumor base.
 */
export function tumorIcon(type: string): string | undefined {
  if (!["tumorCell", "stemCell", "immuneCell", "purificationCell", "siegeCell"].includes(type)) return undefined;
  const cached = iconCache.get(type);
  if (cached) return cached;
  const size = 44;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  const tint = "#c98aa6";
  if (type === "tumorCell") paintCell(ctx, c, c, size * 0.4, tint, size * 0.16);
  else if (type === "stemCell") paintCell(ctx, c, c, size * 0.26, tint, size * 0.1);
  else if (type === "immuneCell") paintCell(ctx, c, c, size * 0.38, tint, 0, true);
  else {
    paintCell(ctx, c, c, size * 0.38, tint, 0);
    ctx.strokeStyle = "#f0efec";
    ctx.lineWidth = size * 0.1;
    ctx.beginPath();
    if (type === "purificationCell") {
      ctx.moveTo(c, size * 0.25);
      ctx.lineTo(c, size * 0.75);
      ctx.moveTo(size * 0.25, c);
      ctx.lineTo(size * 0.75, c);
    } else {
      ctx.moveTo(c, c);
      ctx.lineTo(size * 0.82, size * 0.18);
    }
    ctx.stroke();
  }
  const url = canvas.toDataURL();
  iconCache.set(type, url);
  return url;
}
