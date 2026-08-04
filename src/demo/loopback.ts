/**
 * Loopback capture simulator: takes the transmit canvas through skew,
 * defocus, sensor noise and a green ambient, so the vision pipeline can be
 * exercised without a camera.
 */

export interface LoopbackParams {
  readonly noise: number;
  /** Blur radius in pixels. */
  readonly defocus: number;
  /** 0..1. Stands in for a green-dominant ambient that auto white balance
   *  has already partly corrected by pulling red and blue down. */
  readonly greenAmbient: number;
  /** Rotation in degrees. */
  readonly skew: number;
}

export class LoopbackCamera {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  }

  render(source: HTMLCanvasElement, p: LoopbackParams): void {
    const width = 520;
    const height = Math.round(width * 0.75);
    this.canvas.width = width;
    this.canvas.height = height;

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#3a3a3a";
    ctx.fillRect(0, 0, width, height);

    ctx.filter = p.defocus > 0.05 ? `blur(${p.defocus.toFixed(2)}px)` : "none";
    ctx.translate(width / 2, height / 2);
    ctx.rotate((p.skew * Math.PI) / 180);
    const size = height * 0.86;
    ctx.drawImage(source, -size / 2, -size / 2, size, size);

    ctx.filter = "none";
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (p.noise > 0 || p.greenAmbient > 0) {
      const image = ctx.getImageData(0, 0, width, height);
      const d = image.data;
      const tint = p.greenAmbient;
      for (let i = 0; i < d.length; i += 4) {
        if (tint > 0) {
          d[i] *= 1 - tint;
          d[i + 2] *= 1 - tint;
        }
        if (p.noise > 0) {
          const n = (Math.random() - 0.5) * p.noise * 2;
          d[i] += n;
          d[i + 1] += n;
          d[i + 2] += n;
        }
      }
      ctx.putImageData(image, 0, 0);
    }
  }
}
