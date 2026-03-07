/**
 * @module hooks/use-mouse-scroll
 * Enables terminal mouse wheel scrolling via ANSI escape sequences.
 * Intercepts stdin to strip mouse events before Ink processes them.
 */

import { useEffect, useRef } from 'react';

type EmitFn = (event: string | symbol, ...args: unknown[]) => boolean;

/**
 * Hook that enables mouse wheel scrolling in the terminal.
 * Overrides process.stdin.emit to filter mouse sequences before Ink sees them.
 */
export function useMouseScroll(
  onScrollUp: () => void,
  onScrollDown: () => void,
): void {
  const upRef = useRef(onScrollUp);
  const downRef = useRef(onScrollDown);
  upRef.current = onScrollUp;
  downRef.current = onScrollDown;

  useEffect(() => {
    // Enable mouse tracking (SGR mode for wide terminal support)
    process.stdout.write('\x1b[?1000h');
    process.stdout.write('\x1b[?1006h');

    // SGR mouse pattern: ESC [ < Btn ; X ; Y M/m
    const sgrRegex = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
    // Legacy mouse pattern: ESC [ M followed by 3 bytes
    const legacyRegex = /\x1b\[M[\s\S]{3}/g;

    // Override stdin.emit to intercept mouse events before Ink
    const originalEmit: EmitFn = process.stdin.emit.bind(process.stdin);

    (process.stdin as unknown as { emit: EmitFn }).emit = (
      event: string | symbol,
      ...args: unknown[]
    ): boolean => {
      if (event === 'data' && args[0]) {
        const buf = args[0] as Buffer;
        const str = typeof buf === 'string' ? buf : buf.toString('utf8');

        // Parse mouse wheel events
        let match: RegExpExecArray | null;
        sgrRegex.lastIndex = 0;
        while ((match = sgrRegex.exec(str)) !== null) {
          const btn = parseInt(match[1], 10);
          if (btn === 64) upRef.current();
          else if (btn === 65) downRef.current();
        }

        // Strip all mouse sequences from the data
        const cleaned = str
          .replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, '')
          .replace(/\x1b\[M[\s\S]{3}/g, '');

        // If nothing left after stripping, don't emit (pure mouse data)
        if (cleaned.length === 0) return false;

        // Pass cleaned data to Ink
        return originalEmit(event, Buffer.from(cleaned, 'utf8'));
      }

      return originalEmit(event, ...args);
    };

    return () => {
      // Restore original emit
      (process.stdin as unknown as { emit: EmitFn }).emit = originalEmit;
      // Disable mouse tracking
      process.stdout.write('\x1b[?1006l');
      process.stdout.write('\x1b[?1000l');
    };
  }, []);
}
