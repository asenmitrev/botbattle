import { COLORS } from "./renderer.js";

/**
 * Small two-series line chart (P1 blue, P2 orange) with a current-tick marker and a
 * crosshair tooltip on hover. 2px lines, recessive axis, max value labeled.
 */
export class LineChart {
  private canvas = document.createElement("canvas");
  private tip = document.createElement("div");
  private data: [number[], number[]] = [[], []];
  private current = 0;
  private hover: number | null = null;

  constructor(private host: HTMLElement, private onSeek: (t: number) => void) {
    host.append(this.canvas, this.tip);
    this.tip.className = "chart-tip";
    this.tip.hidden = true;
    this.canvas.addEventListener("mousemove", (e) => {
      this.hover = this.indexAt(e.clientX);
      this.draw();
    });
    this.canvas.addEventListener("mouseleave", () => {
      this.hover = null;
      this.draw();
    });
    this.canvas.addEventListener("click", (e) => {
      const i = this.indexAt(e.clientX);
      if (i !== null) this.onSeek(i);
    });
  }

  set(data: [number[], number[]]): void {
    this.data = data;
    this.draw();
  }

  setCurrent(t: number): void {
    this.current = t;
    this.draw();
  }

  private indexAt(clientX: number): number | null {
    const n = this.data[0].length;
    if (n < 2) return null;
    const r = this.canvas.getBoundingClientRect();
    const frac = (clientX - r.left) / r.width;
    return Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
  }

  draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const r = this.host.getBoundingClientRect();
    if (r.width === 0) return;
    const W = (this.canvas.width = Math.round(r.width * dpr));
    const H = (this.canvas.height = Math.round(r.height * dpr));
    const ctx = this.canvas.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);
    const [a, b] = this.data;
    const n = Math.max(a.length, b.length);
    if (n < 2) return;
    const max = Math.max(1, ...a, ...b);
    const top = 12 * dpr;
    const bottom = H - 2 * dpr;
    const x = (i: number) => (i / (n - 1)) * (W - 2 * dpr) + dpr;
    const y = (v: number) => bottom - (v / max) * (bottom - top);

    // Recessive baseline and max gridline
    ctx.strokeStyle = "#34342f";
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(0, bottom);
    ctx.lineTo(W, bottom);
    ctx.moveTo(0, top);
    ctx.lineTo(W, top);
    ctx.stroke();
    ctx.fillStyle = "#8d8c84";
    ctx.font = `${10 * dpr}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    ctx.fillText(String(Math.round(max)), 2 * dpr, top - dpr);

    for (const [series, color] of [[a, COLORS.p1], [b, COLORS.p2]] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * dpr;
      ctx.lineJoin = "round";
      ctx.beginPath();
      series.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
      ctx.stroke();
    }

    // Current tick marker
    const cx = x(Math.min(this.current, n - 1));
    ctx.strokeStyle = "#c3c2b7";
    ctx.lineWidth = dpr;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.moveTo(cx, top);
    ctx.lineTo(cx, bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    // Hover crosshair + tooltip
    if (this.hover !== null) {
      const i = this.hover;
      const hx = x(i);
      ctx.strokeStyle = "#f0efec";
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(hx, top);
      ctx.lineTo(hx, bottom);
      ctx.stroke();
      for (const [series, color] of [[a, COLORS.p1], [b, COLORS.p2]] as const) {
        ctx.fillStyle = color;
        ctx.strokeStyle = "#1a1a19";
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        ctx.arc(hx, y(series[i] ?? 0), 4 * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      this.tip.hidden = false;
      this.tip.innerHTML = `t${i} <span style="color:${COLORS.p1}">●</span> ${a[i] ?? "–"} <span style="color:${COLORS.p2}">●</span> ${b[i] ?? "–"}`;
      const left = (hx / dpr) > r.width / 2 ? hx / dpr - this.tip.offsetWidth - 6 : hx / dpr + 6;
      this.tip.style.left = `${left}px`;
    } else this.tip.hidden = true;
  }
}
