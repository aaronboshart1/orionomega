/**
 * @module hooks/use-mouse-scroll
 * Terminal mouse wheel scrolling that works with Ink's useInput.
 *
 * Enables SGR mouse tracking and filters sequences via a state machine
 * in the useInput callback. Returns a filter function that ChatView
 * calls from its useInput handler.
 */

import { useEffect, useRef, useCallback } from 'react';
import type { Key } from 'ink';

interface MouseScrollResult {
  /** Call this from useInput. Returns true if the input was a mouse event (consume it). */
  handleInput: (ch: string, key: Key) => boolean;
}

/**
 * Hook that enables mouse wheel scrolling.
 * Returns a handleInput function to call from useInput — returns true if consumed.
 */
export function useMouseScroll(
  onScrollUp: () => void,
  onScrollDown: () => void,
): MouseScrollResult {
  const upRef = useRef(onScrollUp);
  const downRef = useRef(onScrollDown);
  upRef.current = onScrollUp;
  downRef.current = onScrollDown;

  // State machine for parsing mouse sequences
  // After Ink eats ESC, we see: [ < NN ; NN ; NN M (or m)
  const bufferRef = useRef('');
  const inSequenceRef = useRef(false);

  useEffect(() => {
    // Enable SGR extended mouse mode
    process.stdout.write('\x1b[?1000h');
    process.stdout.write('\x1b[?1006h');

    return () => {
      process.stdout.write('\x1b[?1006l');
      process.stdout.write('\x1b[?1000l');
    };
  }, []);

  const handleInput = useCallback((ch: string, key: Key): boolean => {
    // If Ink detected an escape key, this might be the start of a mouse sequence
    // The next chars will be [<NN;NN;NNM
    if (key.escape) {
      // Could be a real escape or start of mouse sequence
      // We'll check on the next character
      inSequenceRef.current = false;
      bufferRef.current = '';
      return false; // Let escape through (might be real escape)
    }

    // If we're accumulating a mouse sequence
    if (inSequenceRef.current) {
      bufferRef.current += ch;

      // Check if sequence is complete (ends with M or m)
      if (ch === 'M' || ch === 'm') {
        // Parse the completed sequence: <NN;NN;NN
        const match = bufferRef.current.match(/^\[<(\d+);\d+;\d+[Mm]$/);
        if (match) {
          const btn = parseInt(match[1], 10);
          if (btn === 64) upRef.current();
          else if (btn === 65) downRef.current();
        }
        inSequenceRef.current = false;
        bufferRef.current = '';
        return true; // Consumed
      }

      // Still accumulating — check if it's still valid
      if (bufferRef.current.length > 20) {
        // Too long, not a mouse sequence
        inSequenceRef.current = false;
        bufferRef.current = '';
        return false;
      }

      return true; // Consuming (part of sequence)
    }

    // Detect start of mouse sequence: [ after an escape
    // Ink eats ESC, so we see [ as first char after escape
    if (ch === '[' || ch === '<') {
      // Could be start of mouse sequence [< ...
      bufferRef.current = ch;
      inSequenceRef.current = true;
      return true; // Consume tentatively
    }

    return false; // Not a mouse event
  }, []);

  return { handleInput };
}
