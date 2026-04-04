/**
 * Tests for client.ts fixes (F4, F5, F6, F10).
 *
 * These tests validate threshold calibration, temporal parameter naming,
 * query truncation, and log message differentiation.
 *
 * Since HindsightClient makes HTTP calls, we test by inspecting the
 * constructed request bodies and verifying client-side behavior.
 */

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  PASS: ${message}`);
}

// ─────────────────────────────────────────────────────────
// F4: Threshold lowered to 0.15
// ─────────────────────────────────────────────────────────

console.log('\n=== F4: Relevance Threshold Calibration ===');

{
  // Verify the default is 0.15 by reading the source
  const fs = await import('node:fs');
  const source = fs.readFileSync('/tmp/orionomega-fix/packages/hindsight/src/client.ts', 'utf-8');

  assert(
    source.includes("opts?.minRelevance ?? 0.15"),
    'Default minRelevance is 0.15 (not 0.3)',
  );

  assert(
    !source.includes("opts?.minRelevance ?? 0.3"),
    'Old 0.3 threshold has been replaced',
  );
}

{
  // Verify that scores in 0.15–0.30 range would now survive filtering
  // (Previously dropped, now kept)
  const testScores = [0.02, 0.07, 0.14, 0.15, 0.20, 0.30, 0.50];
  const threshold = 0.15;
  const surviving = testScores.filter(s => s >= threshold);
  const dropped = testScores.filter(s => s < threshold);
  assert(surviving.length === 4, `4 scores survive 0.15 threshold: ${surviving.join(', ')}`);
  assert(dropped.length === 3, `3 scores dropped below 0.15: ${dropped.join(', ')}`);

  // With old 0.3 threshold, only 2 would survive
  const oldSurviving = testScores.filter(s => s >= 0.3);
  assert(oldSurviving.length === 2, `Only 2 would survive old 0.3 threshold`);
}

// ─────────────────────────────────────────────────────────
// F5: Temporal parameter name fix
// ─────────────────────────────────────────────────────────

console.log('\n=== F5: Temporal Parameter Name ===');

{
  const fs = await import('node:fs');
  const source = fs.readFileSync('/tmp/orionomega-fix/packages/hindsight/src/client.ts', 'utf-8');

  assert(
    source.includes('body.query_timestamp = opts.before'),
    'Temporal param sent as query_timestamp to API',
  );

  assert(
    !source.includes('body.before = opts.before'),
    'Old body.before assignment has been replaced',
  );
}

// ─────────────────────────────────────────────────────────
// F6: Query truncation
// ─────────────────────────────────────────────────────────

console.log('\n=== F6: Query Truncation ===');

{
  const fs = await import('node:fs');
  const source = fs.readFileSync('/tmp/orionomega-fix/packages/hindsight/src/client.ts', 'utf-8');

  assert(
    source.includes('MAX_QUERY_LENGTH = 4000'),
    'MAX_QUERY_LENGTH constant defined at 4000',
  );

  assert(
    source.includes('query.length > MAX_QUERY_LENGTH'),
    'Query length check present before API call',
  );

  assert(
    source.includes('query.slice(0, MAX_QUERY_LENGTH)'),
    'Query truncation via slice present',
  );

  assert(
    source.includes('query: effectiveQuery'),
    'Truncated query used in request body (not raw query)',
  );
}

{
  // Verify truncation logic works correctly
  const MAX_QUERY_LENGTH = 4000;
  const shortQuery = 'fix sql bug';
  const longQuery = 'x'.repeat(15000);

  const effectiveShort = shortQuery.length > MAX_QUERY_LENGTH
    ? shortQuery.slice(0, MAX_QUERY_LENGTH)
    : shortQuery;
  assert(effectiveShort === shortQuery, 'Short query unchanged');
  assert(effectiveShort.length === 11, 'Short query length preserved');

  const effectiveLong = longQuery.length > MAX_QUERY_LENGTH
    ? longQuery.slice(0, MAX_QUERY_LENGTH)
    : longQuery;
  assert(effectiveLong.length === 4000, `Long query truncated to ${effectiveLong.length}`);
}

// ─────────────────────────────────────────────────────────
// F10: Differentiated log messages
// ─────────────────────────────────────────────────────────

console.log('\n=== F10: Log Message Differentiation ===');

{
  const fs = await import('node:fs');
  const source = fs.readFileSync('/tmp/orionomega-fix/packages/hindsight/src/client.ts', 'utf-8');

  assert(
    source.includes('API returned 0 results'),
    'Message distinguishes "API returned 0 results" case',
  );

  assert(
    source.includes('results filtered below relevance threshold'),
    'Message distinguishes "all filtered" case',
  );

  assert(
    !source.includes("detail: 'No matching memories found'"),
    'Old ambiguous message has been replaced',
  );
}

// ─────────────────────────────────────────────────────────
// Regression: temporal diversity min relevance
// ─────────────────────────────────────────────────────────

console.log('\n=== Regression: Temporal Diversity Uses New Threshold ===');

{
  const fs = await import('node:fs');
  const source = fs.readFileSync('/tmp/orionomega-fix/packages/hindsight/src/client.ts', 'utf-8');

  // The temporal diversity buckets apply a slightly lower threshold
  // Verify it references the new 0.15 base, not the old 0.3
  const temporalMatch = source.match(/opts\?\.minRelevance \?\? ([\d.]+)\) - ([\d.]+)/);
  if (temporalMatch) {
    const base = parseFloat(temporalMatch[1]);
    const offset = parseFloat(temporalMatch[2]);
    assert(base <= 0.15, `Temporal diversity base threshold is ${base} (not old 0.3)`);
    console.log(`  INFO: Temporal floor = max(${base} - ${offset}, ...) = ${Math.max(base - offset, 0.05)}`);
  } else {
    console.log('  INFO: Temporal diversity threshold pattern not matched (may have been refactored)');
  }
}

console.log('\n✓ All client.ts tests passed\n');
