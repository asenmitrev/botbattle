// Unit/structure art (generated with fal.ai, neutral steel so it can be tinted by team colour).
import worker from "./sprites/worker.png";
import fighter from "./sprites/fighter.png";
import scout from "./sprites/scout.png";
import turret from "./sprites/turret.png";
import wall from "./sprites/wall.png";
import base from "./sprites/base.png";

export const SPRITE_URLS = { worker, fighter, scout, turret, wall, base } as const;
export type SpriteName = keyof typeof SPRITE_URLS;

const images = new Map<SpriteName, HTMLImageElement>();
const listeners: Array<() => void> = [];

for (const [name, url] of Object.entries(SPRITE_URLS) as [SpriteName, string][]) {
  const img = new Image();
  img.decoding = "async";
  img.onload = () => {
    images.set(name, img);
    for (const fn of listeners) fn();
  };
  img.src = url;
}

/** The loaded image, or undefined while it is still loading (callers fall back to vector shapes). */
export const sprite = (name: SpriteName): HTMLImageElement | undefined => images.get(name);

/** Called each time another sprite finishes loading, so the board can repaint. */
export const onSpriteLoad = (fn: () => void): void => void listeners.push(fn);

const tintCache = new Map<string, HTMLCanvasElement>();

/**
 * The sprite recoloured toward `color` (multiply blend, keeping `keep` of the original steel so
 * outlines and shading survive). Cached per sprite+colour; undefined while the sprite is loading.
 */
export const tintedSprite = (name: SpriteName, color: string, keep = 0.3): HTMLCanvasElement | undefined => {
  const img = images.get(name);
  if (!img) return undefined;
  const key = `${name}|${color}|${keep}`;
  let canvas = tintCache.get(key);
  if (canvas) return canvas;
  canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  // Multiply the art by (keep·white + (1−keep)·color), then clip back to the sprite's alpha.
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = color;
  ctx.globalAlpha = 1 - keep;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(img, 0, 0);
  tintCache.set(key, canvas);
  return canvas;
};
