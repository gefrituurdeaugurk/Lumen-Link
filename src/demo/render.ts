/** Canvas rendering. The only place that knows a cell grid becomes pixels. */

import { PALETTE, type CellGrid } from "../core/raster.ts";
import { applyHomography, type Homography } from "../vision/homography.ts";

export class GridRenderer {
  private readonly cells: HTMLCanvasElement;
  private readonly cellCtx: CanvasRenderingContext2D;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.cells = document.createElement("canvas");
    this.cellCtx = this.cells.getContext("2d")!;
    this.ctx = canvas.getContext("2d")!;
  }

  /** Size the backing store so one cell is a whole number of pixels. Sized for
   *  the fullscreen present mode, since a camera needs every cell pixel it can
   *  get; the inline preview just scales down. */
  resize(W: number, target = 1024): void {
    this.cells.width = W;
    this.cells.height = W;
    const px = Math.max(4, Math.floor(target / W));
    this.canvas.width = W * px;
    this.canvas.height = W * px;
    this.ctx.imageSmoothingEnabled = false;
  }

  draw(grid: CellGrid): void {
    const W = grid.W;
    const img = this.cellCtx.createImageData(W, W);
    for (let i = 0; i < W * W; i++) {
      const [r, g, b] = PALETTE[grid.luma[i] + 2 * grid.blue[i]];
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = 255;
    }
    this.cellCtx.putImageData(img, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.cells, 0, 0, this.canvas.width, this.canvas.height);
  }
}

/** Outline the locked grid over the capture. */
export function drawLockOverlay(
  canvas: HTMLCanvasElement,
  h: Homography | null,
  W: number,
  width: number,
  height: number,
): void {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, width, height);
  if (!h) return;

  ctx.lineWidth = 2;
  ctx.strokeStyle = "#FFE500";
  ctx.beginPath();
  const pts = ([[0, 0], [W, 0], [W, W], [0, W]] as const).map(([x, y]) =>
    applyHomography(h, x, y),
  );
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.stroke();
}

export interface ScopeEntry {
  readonly bandsPassed: number;
  readonly bandsTried: number;
  readonly chromaPassed: number;
  readonly chromaTried: number;
}

const SCOPE_SLOTS = 140;

/** Per-frame band and chroma acceptance, newest at the right. */
export function drawScope(canvas: HTMLCanvasElement, history: readonly ScopeEntry[]): void {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, w, h);

  const bw = w / SCOPE_SLOTS;
  for (let i = 0; i < history.length; i++) {
    const e = history[i];
    const x = i * bw;
    const width = Math.max(1, bw - 0.6);

    ctx.fillStyle = "#0B0B0F";
    ctx.fillRect(x, 0, width, h);

    const bar = (e.bandsPassed / Math.max(1, e.bandsTried)) * (h - 20);
    ctx.fillStyle = "#FFE500";
    ctx.fillRect(x, h - 20 - bar, width, bar);

    if (e.chromaTried) {
      ctx.fillStyle = e.chromaPassed ? "#1B2CFF" : "#3A3D48";
      ctx.fillRect(x, h - 18, width, 16);
    }
  }

  ctx.strokeStyle = "#D6D8DE";
  ctx.beginPath();
  ctx.moveTo(0, h - 19.5);
  ctx.lineTo(w, h - 19.5);
  ctx.stroke();
}

export { SCOPE_SLOTS };
