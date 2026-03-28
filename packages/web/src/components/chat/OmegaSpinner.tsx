'use client';

import { useEffect, useState } from 'react';

// 5x5 omega shape:
// . # # # .
// # . . . #
// # . . . #
// . # . # .
// # # . # #
const OMEGA = [
  0, 1, 1, 1, 0,
  1, 0, 0, 0, 1,
  1, 0, 0, 0, 1,
  0, 1, 0, 1, 0,
  1, 1, 0, 1, 1,
];

// Spiral fill order (clockwise from top-left), 25 cells
const SPIRAL = [
  0, 1, 2, 3, 4,
  9, 14, 19, 24,
  23, 22, 21, 20,
  15, 10, 5,
  6, 7, 8,
  13, 18,
  17, 16,
  11,
  12,
];

const TOTAL = 25;

// 0=off, 1=on(blue), 2=accent(green), 3=glow(bright), -1=dim
type CellState = 0 | 1 | 2 | 3 | -1;

function buildFrames(): CellState[][] {
  const frames: CellState[][] = [];

  // Phase 1: Spiral fill (5 steps, 5 cells each) — glow
  for (let step = 0; step < 5; step++) {
    const grid: CellState[] = new Array(TOTAL).fill(0);
    for (let i = 0; i <= (step + 1) * 5 - 1 && i < TOTAL; i++) {
      grid[SPIRAL[i]] = 3;
    }
    frames.push(grid);
  }

  // Phase 2: All solid blue
  frames.push(new Array<CellState>(TOTAL).fill(1));

  // Phase 3: Non-omega fades to green accent
  const fade1: CellState[] = new Array(TOTAL).fill(0);
  for (let i = 0; i < TOTAL; i++) fade1[i] = OMEGA[i] ? 1 : 2;
  frames.push(fade1);

  // Phase 4: Non-omega dims
  const fade2: CellState[] = new Array(TOTAL).fill(0);
  for (let i = 0; i < TOTAL; i++) fade2[i] = OMEGA[i] ? 1 : -1;
  frames.push(fade2);

  // Phase 5: Omega glow reveal
  const reveal: CellState[] = new Array(TOTAL).fill(0);
  for (let i = 0; i < TOTAL; i++) reveal[i] = OMEGA[i] ? 3 : 0;
  frames.push(reveal);

  // Phase 6: Omega solid hold
  frames.push(OMEGA.map((v) => v as CellState));

  // Phase 7: Omega fades to green before restart
  const fadeOut: CellState[] = new Array(TOTAL).fill(0);
  for (let i = 0; i < TOTAL; i++) fadeOut[i] = OMEGA[i] ? 2 : 0;
  frames.push(fadeOut);

  return frames;
}

const FRAMES = buildFrames();

const cellStyle: Record<number, string> = {
  0: '',
  1: 'bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.5)]',
  2: 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.6)]',
  3: 'bg-blue-200 shadow-[0_0_14px_rgba(191,219,254,0.7)]',
  [-1]: 'bg-zinc-800/40',
};

interface OmegaSpinnerProps {
  /** Dot size in pixels */
  size?: number;
  /** Gap between dots in pixels */
  gap?: number;
  /** Frame interval in ms */
  interval?: number;
  /** Additional classes on the wrapper */
  className?: string;
}

export function OmegaSpinner({
  size = 5,
  gap = 1,
  interval = 180,
  className = '',
}: OmegaSpinnerProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, interval);
    return () => clearInterval(timer);
  }, [interval]);

  const grid = FRAMES[frame];

  return (
    <div
      role="status"
      aria-label="Loading"
      className={className}
      style={{
        display: 'inline-grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: `${gap}px`,
      }}
    >
      {grid.map((cell, i) => (
        <div
          key={i}
          className={`rounded-sm transition-all duration-150 ${cellStyle[cell] || ''}`}
          style={{ width: size, height: size }}
        />
      ))}
    </div>
  );
}
