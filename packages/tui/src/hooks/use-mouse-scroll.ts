/**
 * @module hooks/use-mouse-scroll
 * Enables terminal mouse wheel scrolling via ANSI escape sequences.
 * Sends \x1b[?1000h (basic mouse tracking) and \x1b[?1006h (SGR extended)
 * on mount, and parses wheel events from stdin.
 */

import { useEffect, useRef } from 'react';

/**
 * Hook that enables mouse wheel scrolling in the terminal.
 * Calls onScrollUp/onScrollDown when the user scrolls.
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
    process.stdout.write('\x1b[?1000h'); // basic mouse events
    process.stdout.write('\x1b[?1006h'); // SGR extended mouse mode

    let buffer = '';

    const handler = (data: Buffer) => {
      const str = data.toString('utf8');
      buffer += str;

      // SGR mouse format: \x1b[<Btn;X;Y[Mm]
      // Btn 64 = wheel up, Btn 65 = wheel down
      const sgrPattern = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
      let match;
      while ((match = sgrPattern.exec(buffer)) !== null) {
        const btn = parseInt(match[1], 10);
        if (btn === 64) upRef.current();
        else if (btn === 65) downRef.current();
      }

      // Legacy mouse format: \x1b[M followed by 3 bytes
      // Byte 0: 32 + button (96 = wheel up, 97 = wheel down)
      const legacyIdx = buffer.indexOf('\x1b[M');
      if (legacyIdx >= 0 && buffer.length >= legacyIdx + 6) {
        const btn = buffer.charCodeAt(legacyIdx + 3);
        if (btn === 96) upRef.current();
        else if (btn === 97) downRef.current();
      }

      // Keep only recent buffer to prevent memory leak
      if (buffer.length > 256) buffer = buffer.slice(-64);
    };

    // Prepend so we see mouse events before Ink processes them
    process.stdin.prependListener('data', handler);

    return () => {
      // Disable mouse tracking on cleanup
      process.stdout.write('\x1b[?1006l');
      process.stdout.write('\x1b[?1000l');
      process.stdin.removeListener('data', handler);
    };
  }, []);
}
