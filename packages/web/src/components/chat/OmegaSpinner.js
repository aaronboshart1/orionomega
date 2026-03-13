'use client';
import { useEffect, useState } from 'react';
// 4x4 omega shape:
// . # # .
// # . . #
// . # # .
// # . . #
const OMEGA = [
    0, 1, 1, 0,
    1, 0, 0, 1,
    0, 1, 1, 0,
    1, 0, 0, 1,
];
// Spiral fill order (clockwise from top-left)
const SPIRAL = [0, 1, 2, 3, 7, 11, 15, 14, 13, 12, 8, 4, 5, 6, 10, 9];
function buildFrames() {
    const frames = [];
    // Phase 1: Spiral fill (4 steps, 4 cells each) — glow
    for (let step = 0; step < 4; step++) {
        const grid = new Array(16).fill(0);
        for (let i = 0; i <= (step + 1) * 4 - 1 && i < 16; i++) {
            grid[SPIRAL[i]] = 3;
        }
        frames.push(grid);
    }
    // Phase 2: All solid blue
    frames.push(new Array(16).fill(1));
    // Phase 3: Non-omega fades to green accent
    const fade1 = new Array(16).fill(0);
    for (let i = 0; i < 16; i++)
        fade1[i] = OMEGA[i] ? 1 : 2;
    frames.push(fade1);
    // Phase 4: Non-omega dims
    const fade2 = new Array(16).fill(0);
    for (let i = 0; i < 16; i++)
        fade2[i] = OMEGA[i] ? 1 : -1;
    frames.push(fade2);
    // Phase 5: Omega glow reveal
    const reveal = new Array(16).fill(0);
    for (let i = 0; i < 16; i++)
        reveal[i] = OMEGA[i] ? 3 : 0;
    frames.push(reveal);
    // Phase 6: Omega solid hold
    frames.push(OMEGA.map((v) => v));
    // Phase 7: Omega fades to green before restart
    const fadeOut = new Array(16).fill(0);
    for (let i = 0; i < 16; i++)
        fadeOut[i] = OMEGA[i] ? 2 : 0;
    frames.push(fadeOut);
    return frames;
}
const FRAMES = buildFrames();
const cellStyle = {
    0: '',
    1: 'bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.5)]',
    2: 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.6)]',
    3: 'bg-blue-200 shadow-[0_0_14px_rgba(191,219,254,0.7)]',
    [-1]: 'bg-zinc-800/40',
};
export function OmegaSpinner({ size = 6, gap = 1.5, interval = 180, className = '', }) {
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => {
            setFrame((f) => (f + 1) % FRAMES.length);
        }, interval);
        return () => clearInterval(timer);
    }, [interval]);
    const grid = FRAMES[frame];
    return (<div className={className} style={{
            display: 'inline-grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: `${gap}px`,
        }}>
      {grid.map((cell, i) => (<div key={i} className={`rounded-sm transition-all duration-150 ${cellStyle[cell] || ''}`} style={{ width: size, height: size }}/>))}
    </div>);
}
//# sourceMappingURL=OmegaSpinner.js.map