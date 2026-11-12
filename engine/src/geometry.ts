import type { Dir, Pos } from "./types.js";

export const DIRS: Record<Dir, Pos> = {
  N: { x: 0, y: -1 },
  S: { x: 0, y: 1 },
  E: { x: 1, y: 0 },
  W: { x: -1, y: 0 },
};
/** Neighbor order for player 1; player 2 uses the point-mirrored order so pathing has no side bias. */
export const DIR_ORDER_P1: readonly Dir[] = ["N", "E", "S", "W"];
export const DIR_ORDER_P2: readonly Dir[] = ["S", "W", "N", "E"];

/** 8-neighborhood offsets in a fixed order; player 2 negates them. */
export const ADJ8: readonly Pos[] = [
  { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: -1 },
  { x: -1, y: 1 }, { x: 0, y: -1 }, { x: -1, y: 0 }, { x: -1, y: -1 },
];

/** Chebyshev distance: used for all action ranges (adjacency, attack, build). */
export function chebyshev(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Squared Euclidean distance: used for vision and the zone. */
export function dist2(a: Pos, b: Pos): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function inBounds(size: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < size && y < size;
}

export function mirror(size: number, p: Pos): Pos {
  return { x: size - 1 - p.x, y: size - 1 - p.y };
}

/**
 * BFS distance field from `target` over tiles where passable(idx) is true.
 * The target tile itself is always the origin (distance 0) even if impassable,
 * so moving "to" a blocked tile paths to its neighbors.
 * Returns Int32Array of distances (-1 = unreachable).
 */
export function distanceField(size: number, target: Pos, passable: (idx: number) => boolean): Int32Array {
  const dist = new Int32Array(size * size).fill(-1);
  const queue = new Int32Array(size * size);
  let head = 0;
  let tail = 0;
  const start = target.y * size + target.x;
  dist[start] = 0;
  queue[tail++] = start;
  while (head < tail) {
    const cur = queue[head++]!;
    const cx = cur % size;
    const cy = (cur - cx) / size;
    const d = dist[cur]! + 1;
    for (const dir of DIR_ORDER_P1) {
      const o = DIRS[dir];
      const nx = cx + o.x;
      const ny = cy + o.y;
      if (!inBounds(size, nx, ny)) continue;
      const ni = ny * size + nx;
      if (dist[ni] !== -1 || !passable(ni)) continue;
      dist[ni] = d;
      queue[tail++] = ni;
    }
  }
  return dist;
}
