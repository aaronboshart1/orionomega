/**
 * @module hooks/use-mouse-scroll
 * Terminal mouse wheel scrolling for Ink apps.
 *
 * Strategy: Enable SGR mouse mode, then intercept raw stdin data events
 * BEFORE Ink reads them. We replace process.stdin.read to filter mouse bytes.
 */

import { useEffect, useRef } from 'react';

export function useMouseScroll(
  onScrollUp: () => void,
  onScrollDown: () => void,
): void {
  const upRef = useRef(onScrollUp);
  const downRef = useRef(onScrollDown);
  upRef.current = onScrollUp;
  downRef.current = onScrollDown;

  useEffect(() => {
    // Enable SGR extended mouse mode
    process.stdout.write('\x1b[?1000h');
    process.stdout.write('\x1b[?1006h');

    // Intercept stdin data at the lowest level
    const listeners = process.stdin.rawListeners('data') as Array<(chunk: Buffer) => void>;
    // Remove all existing data listeners (Ink's)
    process.stdin.removeAllListeners('data');

    // Our filter handler
    const filterHandler = (chunk: Buffer) => {
      let str = chunk.toString('utf8');

      // Parse SGR mouse wheel events: ESC [ < Btn ; X ; Y M
      const sgrRegex = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
      let match;
      while ((match = sgrRegex.exec(str)) !== null) {
        const btn = parseInt(match[1], 10);
        if (btn === 64) upRef.current();
        else if (btn === 65) downRef.current();
      }

      // Strip ALL mouse sequences
      const cleaned = str.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, '');

      if (cleaned.length === 0) return; // Pure mouse data, don't forward

      // Forward cleaned data to all original listeners
      const cleanBuf = Buffer.from(cleaned, 'utf8');
      for (const listener of listeners) {
        listener(cleanBuf);
      }
    };

    process.stdin.on('data', filterHandler);

    return () => {
      // Remove our handler
      process.stdin.removeListener('data', filterHandler);
      // Restore original listeners
      for (const listener of listeners) {
        process.stdin.on('data', listener);
      }
      // Disable mouse tracking
      process.stdout.write('\x1b[?1006l');
      process.stdout.write('\x1b[?1000l');
    };
  }, []);
}
