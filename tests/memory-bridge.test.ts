/**
 * Tests for memory-bridge.ts fix (F7) and context-assembler.ts fix (F11).
 */

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  PASS: ${message}`);
}

// ─────────────────────────────────────────────────────────
// F7: Mental model seeding
// ─────────────────────────────────────────────────────────

console.log('\n=== F7: Mental Model Seeding ===');

{
  const fs = await import('node:fs');
  const source = fs.readFileSync('/tmp/orionomega-fix/packages/core/src/agent/memory-bridge.ts', 'utf-8');

  assert(
    source.includes('seedMentalModelsIfNeeded'),
    'seedMentalModelsIfNeeded method exists',
  );

  // Verify it seeds all 3 required models
  assert(
    source.includes("modelId: 'user-profile'"),
    'Seeds user-profile mental model',
  );
  assert(
    source.includes("modelId: 'session-context'"),
    'Seeds session-context mental model',
  );
  assert(
    source.includes("modelId: 'infra-map'"),
    'Seeds infra-map mental model',
  );

  // Verify the seeding strategy: GET to check, refresh to create
  assert(
    source.includes('getMentalModel(bankId, modelId)'),
    'Checks for existing model via GET before seeding',
  );
  assert(
    source.includes('refreshMentalModel(bankId, modelId)'),
    'Creates missing model via refresh',
  );

  // Verify it's called during init()
  assert(
    source.includes('this.seedMentalModelsIfNeeded()'),
    'seedMentalModelsIfNeeded called during init()',
  );

  // Verify it doesn't block init (fire-and-forget with .catch)
  const initSection = source.slice(
    source.indexOf('seedMentalModelsIfNeeded()'),
    source.indexOf('seedMentalModelsIfNeeded()') + 200,
  );
  assert(
    initSection.includes('.catch('),
    'Mental model seeding is fire-and-forget (has .catch)',
  );
}

{
  // Verify the correct bank-to-model mapping
  const fs = await import('node:fs');
  const source = fs.readFileSync('/tmp/orionomega-fix/packages/core/src/agent/memory-bridge.ts', 'utf-8');

  // user-profile and session-context → core bank
  assert(
    source.includes("{ bankId: 'core', modelId: 'user-profile' }"),
    'user-profile seeded in core bank',
  );
  assert(
    source.includes("{ bankId: 'core', modelId: 'session-context' }"),
    'session-context seeded in core bank',
  );

  // infra-map → infra bank
  assert(
    source.includes("{ bankId: 'infra', modelId: 'infra-map' }"),
    'infra-map seeded in infra bank',
  );
}

// ─────────────────────────────────────────────────────────
// F7: relevanceFloor alignment in bootstrap config
// ─────────────────────────────────────────────────────────

console.log('\n=== F7: Bootstrap Config Alignment ===');

{
  const fs = await import('node:fs');
  const source = fs.readFileSync('/tmp/orionomega-fix/packages/core/src/agent/memory-bridge.ts', 'utf-8');

  assert(
    source.includes('relevanceFloor: 0.15'),
    'Bootstrap relevanceFloor aligned to 0.15 (not old 0.3)',
  );
}

// ─────────────────────────────────────────────────────────
// F11: Budget alignment in context-assembler
// ─────────────────────────────────────────────────────────

console.log('\n=== F11: Budget Alignment ===');

{
  const fs = await import('node:fs');
  const source = fs.readFileSync('/tmp/orionomega-fix/packages/core/src/memory/context-assembler.ts', 'utf-8');

  assert(
    source.includes('DEFAULT_RECALL_BUDGET = 8_192'),
    'DEFAULT_RECALL_BUDGET aligned to 8,192 (was 30,000)',
  );

  assert(
    !source.includes('DEFAULT_RECALL_BUDGET = 30_000'),
    'Old 30,000 budget value has been replaced',
  );

  // Verify minRelevance default aligned
  assert(
    source.includes('config.minRelevance ?? 0.15'),
    'Context assembler minRelevance default aligned to 0.15',
  );

  assert(
    !source.includes('config.minRelevance ?? 0.3'),
    'Old 0.3 minRelevance default replaced in context assembler',
  );
}

console.log('\n✓ All memory-bridge.ts and context-assembler.ts tests passed\n');
