/**
 * @module components/omega-spinner
 * Shared braille omega spinner for TUI components.
 * 4×4 pixel grid rendered as 2 braille characters.
 * Animation: spiral fill → solid → dissolve → reveal omega → fade.
 *
 * The omega glyph includes inner foot dots for a truer Ω shape:
 *   ·██·
 *   █··█
 *   ·██·
 *   ████
 */

type Listener = () => void;

const OMEGA = [
  [0, 1, 1, 0],
  [1, 0, 0, 1],
  [0, 1, 1, 0],
  [1, 1, 1, 1],
];

const SPIRAL: [number, number][] = [
  [0, 0], [0, 1], [0, 2], [0, 3],
  [1, 3], [2, 3], [3, 3],
  [3, 2], [3, 1], [3, 0],
  [2, 0], [1, 0],
  [1, 1], [1, 2], [2, 2], [2, 1],
];

const FILL_PHASES: [number, number][][] = [
  SPIRAL.slice(0, 4),
  SPIRAL.slice(4, 8),
  SPIRAL.slice(8, 12),
  SPIRAL.slice(12, 16),
];

function toBraille(grid: number[][]): string {
  let result = '';
  const w = grid[0].length;
  for (let x = 0; x < w; x += 2) {
    let code = 0x2800;
    for (let y = 0; y < 4; y++) {
      if (grid[y]?.[x]) code |= y < 3 ? (1 << y) : 0x40;
      if (grid[y]?.[x + 1]) code |= y < 3 ? (1 << (y + 3)) : 0x80;
    }
    result += String.fromCharCode(code);
  }
  return result;
}

function buildFrames(): string[] {
  const grid = OMEGA.map(r => r.map(() => 0));
  const frames: string[] = [];

  // Empty
  frames.push(toBraille(grid));

  // Spiral fill
  for (const phase of FILL_PHASES) {
    for (const [y, x] of phase) grid[y][x] = 1;
    frames.push(toBraille(grid));
  }

  // Hold full
  frames.push(toBraille(grid));

  // Reveal omega (non-omega off)
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++)
      grid[y][x] = OMEGA[y][x];
  frames.push(toBraille(grid));

  // Hold omega
  frames.push(toBraille(grid));
  frames.push(toBraille(grid));

  // Fade out
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++)
      grid[y][x] = 0;
  frames.push(toBraille(grid));

  return frames;
}

const FRAMES = buildFrames();

/**
 * Global omega spinner — singleton ticker that multiple components can subscribe to.
 * Starts ticking when first listener subscribes, stops when all unsubscribe.
 */
class OmegaSpinnerTicker {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<Listener>();
  readonly intervalMs = 120;

  /** Current braille frame string (2 chars). */
  get current(): string {
    return FRAMES[this.frame];
  }

  /** All frames for direct indexing. */
  get frames(): readonly string[] {
    return FRAMES;
  }

  get frameCount(): number {
    return FRAMES.length;
  }

  /** Subscribe to tick updates. Returns unsubscribe function. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % FRAMES.length;
        for (const l of this.listeners) l();
      }, this.intervalMs);
    }
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        this.frame = 0;
      }
    };
  }
}

/** Shared singleton spinner ticker. */
export const omegaSpinner = new OmegaSpinnerTicker();
