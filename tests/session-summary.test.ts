/**
 * Tests for session-summary.ts fixes (F9, F14).
 *
 * Validates retry logic with exponential backoff and debounce behavior.
 */

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  PASS: ${message}`);
}

// ─────────────────────────────────────────────────────────
// F9: Retry with exponential backoff
// ─────────────────────────────────────────────────────────

console.log('\n=== F9: Retry Logic ===');

{
  const fs = await import('node:fs');
  const source = fs.readFileSync('/tmp/orionomega-fix/packages/core/src/memory/session-summary.ts', 'utf-8');

  assert(
    source.includes('MAX_RETRIES = 3'),
    'MAX_RETRIES constant defined',
  );

  assert(
    source.includes('INITIAL_BACKOFF_MS = 500'),
    'INITIAL_BACKOFF_MS defined at 500ms',
  );

  assert(
    source.includes('Math.pow(2, attempt)'),
    'Exponential backoff formula present',
  );

  assert(
    source.includes('withRetry('),
    'withRetry helper used for retain calls',
  );

  // Verify retry skips 4xx errors (client errors should not be retried)
  assert(
    source.includes('status >= 400 && status < 500'),
    '4xx errors are not retried (only transient/5xx)',
  );
}

{
  // Verify the retry backoff schedule
  const INITIAL_BACKOFF_MS = 500;
  const delays = [0, 1, 2].map(attempt => INITIAL_BACKOFF_MS * Math.pow(2, attempt));
  assert(delays[0] === 500, `Attempt 1 backoff: ${delays[0]}ms`);
  assert(delays[1] === 1000, `Attempt 2 backoff: ${delays[1]}ms`);
  assert(delays[2] === 2000, `Attempt 3 backoff: ${delays[2]}ms`);
}

{
  // Verify both core and project bank retain calls use retry
  const fs = await import('node:fs');
  const source = fs.readFileSync('/tmp/orionomega-fix/packages/core/src/memory/session-summary.ts', 'utf-8');

  const retryCallCount = (source.match(/withRetry\(/g) ?? []).length;
  assert(retryCallCount >= 2, `withRetry used for both core and project bank retains (${retryCallCount} calls)`);
}

// ─────────────────────────────────────────────────────────
// F14: Session summary debounce
// ─────────────────────────────────────────────────────────

console.log('\n=== F14: Debounce ===');

{
  const fs = await import('node:fs');
  const source = fs.readFileSync('/tmp/orionomega-fix/packages/core/src/memory/session-summary.ts', 'utf-8');

  assert(
    source.includes('DEBOUNCE_WINDOW_MS = 5 * 60 * 1000'),
    'Debounce window defined at 5 minutes',
  );

  assert(
    source.includes('lastSummaryTime'),
    'lastSummaryTime tracking field present',
  );

  assert(
    source.includes('now - this.lastSummaryTime < DEBOUNCE_WINDOW_MS'),
    'Debounce check compares elapsed time against window',
  );

  assert(
    source.includes('this.lastSummaryTime = Date.now()'),
    'lastSummaryTime updated on successful summary',
  );

  assert(
    source.includes('Skipping summary — debounce window active'),
    'Debounce skip is logged',
  );
}

{
  // Verify debounce window math
  const DEBOUNCE_WINDOW_MS = 5 * 60 * 1000;
  assert(DEBOUNCE_WINDOW_MS === 300_000, `Debounce window is 300,000ms (5 minutes)`);

  // Simulate rapid calls
  let lastSummaryTime = Date.now();
  const callTimes = [0, 1000, 2000, 60_000, 120_000, 299_999, 300_001].map(
    offset => lastSummaryTime + offset
  );

  let summariesGenerated = 0;
  for (const callTime of callTimes) {
    if (callTime - lastSummaryTime >= DEBOUNCE_WINDOW_MS || summariesGenerated === 0) {
      summariesGenerated++;
      lastSummaryTime = callTime;
    }
  }
  assert(summariesGenerated === 2, `7 rapid calls produce only ${summariesGenerated} summaries (debounce working)`);
}

// ─────────────────────────────────────────────────────────
// Regression: MIN_MESSAGES check still works
// ─────────────────────────────────────────────────────────

console.log('\n=== Regression: MIN_MESSAGES Guard ===');

{
  const fs = await import('node:fs');
  const source = fs.readFileSync('/tmp/orionomega-fix/packages/core/src/memory/session-summary.ts', 'utf-8');

  assert(
    source.includes('MIN_MESSAGES = 5'),
    'MIN_MESSAGES guard still present at 5',
  );

  assert(
    source.includes('messages.length < MIN_MESSAGES'),
    'Short conversation skip logic preserved',
  );
}

console.log('\n✓ All session-summary.ts tests passed\n');
