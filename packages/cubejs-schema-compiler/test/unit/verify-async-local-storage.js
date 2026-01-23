#!/usr/bin/env node
/**
 * Standalone test script to verify AsyncLocalStorage-based query context isolation.
 * This simulates the same concurrent query pattern that was causing "Cube not found" errors.
 * 
 * Run with: node verify-async-local-storage.js
 * 
 * This test:
 * 1. Proves AsyncLocalStorage correctly isolates concurrent query contexts
 * 2. Proves the OLD instance-property pattern FAILS under concurrency (regression test)
 */

const { AsyncLocalStorage } = require('async_hooks');

// ============================================================================
// NEW PATTERN (FIXED): Using AsyncLocalStorage for context isolation
// ============================================================================
const ctxQueryStorage = new AsyncLocalStorage();

function withQuery(query, fn) {
  return ctxQueryStorage.run(query, fn);
}

function contextQuery() {
  return ctxQueryStorage.getStore();
}

// ============================================================================
// OLD PATTERN (BROKEN): Using instance property - THIS MUST FAIL
// ============================================================================
class BrokenCompilerWithInstanceProperty {
  currentQuery = null; // Shared instance property - THIS WAS THE BUG

  withQuery(query, fn) {
    this.currentQuery = query;
    return fn();
  }

  contextQuery() {
    return this.currentQuery;
  }
}

async function runConcurrencyTest() {
  console.log('=== AsyncLocalStorage Concurrent Query Context Isolation Test ===\n');

  const errors = [];
  const concurrency = 500;
  const checkpointsPerQuery = 10;

  console.log(`Running ${concurrency} concurrent queries with ${checkpointsPerQuery} checkpoints each...`);

  const queries = Array.from({ length: concurrency }, (_, i) => {
    const query = { queryId: i, cubeName: `Cube_${i}` };

    return withQuery(query, async () => {
      for (let checkpoint = 0; checkpoint < checkpointsPerQuery; checkpoint++) {
        // Yield to event loop to allow interleaving
        await new Promise(resolve => setImmediate(resolve));

        const ctx = contextQuery();
        if (!ctx) {
          errors.push(`Query ${i}, checkpoint ${checkpoint}: context is undefined`);
        } else if (ctx.queryId !== i) {
          errors.push(`Query ${i}, checkpoint ${checkpoint}: expected queryId ${i}, got ${ctx.queryId}`);
        }
      }
      return contextQuery();
    });
  });

  const results = await Promise.all(queries);

  // Verify final results
  for (let i = 0; i < results.length; i++) {
    if (!results[i] || results[i].queryId !== i) {
      errors.push(`Final result ${i}: expected queryId ${i}, got ${results[i]?.queryId}`);
    }
  }

  console.log(`\nTotal checkpoints verified: ${concurrency * checkpointsPerQuery}`);

  if (errors.length === 0) {
    console.log('✅ ALL TESTS PASSED - No context bleeding detected!\n');
    console.log('AsyncLocalStorage correctly isolates query context across concurrent async operations.');
    return true;
  } else {
    console.log(`❌ FAILED - ${errors.length} errors detected:\n`);
    errors.slice(0, 10).forEach(e => console.log(`  - ${e}`));
    if (errors.length > 10) {
      console.log(`  ... and ${errors.length - 10} more errors`);
    }
    return false;
  }
}

async function runNestedContextTest() {
  console.log('\n=== Nested Context Test ===\n');

  let outerBefore, innerCtx, outerAfter;

  await withQuery({ level: 'outer' }, async () => {
    outerBefore = contextQuery();

    await withQuery({ level: 'inner' }, async () => {
      innerCtx = contextQuery();
    });

    outerAfter = contextQuery();
  });

  const passed = 
    outerBefore?.level === 'outer' &&
    innerCtx?.level === 'inner' &&
    outerAfter?.level === 'outer';

  if (passed) {
    console.log('✅ Nested context test PASSED');
    console.log(`   Outer before inner: ${JSON.stringify(outerBefore)}`);
    console.log(`   Inner context: ${JSON.stringify(innerCtx)}`);
    console.log(`   Outer after inner: ${JSON.stringify(outerAfter)}`);
  } else {
    console.log('❌ Nested context test FAILED');
  }

  return passed;
}

async function runPromiseChainTest() {
  console.log('\n=== Promise Chain Test ===\n');

  const query = { type: 'promise-chain' };
  let allValid = true;

  await withQuery(query, () => {
    return Promise.resolve()
      .then(() => {
        if (contextQuery()?.type !== 'promise-chain') allValid = false;
        return 1;
      })
      .then(async () => {
        await new Promise(r => setTimeout(r, 10));
        if (contextQuery()?.type !== 'promise-chain') allValid = false;
        return 2;
      })
      .then(() => {
        if (contextQuery()?.type !== 'promise-chain') allValid = false;
        return 3;
      });
  });

  if (allValid) {
    console.log('✅ Promise chain test PASSED - context preserved through .then() chain');
  } else {
    console.log('❌ Promise chain test FAILED');
  }

  return allValid;
}

// Demonstrate the OLD broken behavior for comparison
async function testOldBrokenBehaviorMustFail() {
  console.log('\n=== REGRESSION TEST: Old Broken Behavior MUST Have Collisions ===\n');

  const broken = new BrokenCompilerWithInstanceProperty();
  const collisions = [];

  const queries = Array.from({ length: 50 }, (_, i) => {
    const query = { queryId: i };

    return broken.withQuery(query, async () => {
      // Multiple yields to maximize interleaving
      for (let j = 0; j < 5; j++) {
        await new Promise(resolve => setImmediate(resolve));
        const ctx = broken.contextQuery();
        if (ctx.queryId !== i) {
          collisions.push(`Query ${i}: expected ${i}, got ${ctx.queryId}`);
        }
      }
      return broken.contextQuery();
    });
  });

  await Promise.all(queries);

  // The old pattern MUST have collisions - if it doesn't, the test isn't proving anything
  if (collisions.length > 0) {
    console.log(`✅ REGRESSION TEST PASSED: Old pattern had ${collisions.length} context collisions (expected!)`);
    console.log('   This proves the old instance-property approach is broken under concurrency.');
    return true;
  } else {
    console.log('❌ REGRESSION TEST FAILED: Old pattern had NO collisions!');
    console.log('   This test should demonstrate that the old approach fails.');
    console.log('   If no collisions occurred, the test conditions may not be triggering the race condition.');
    return false;
  }
}

async function main() {
  const test1 = await runConcurrencyTest();
  const test2 = await runNestedContextTest();
  const test3 = await runPromiseChainTest();
  const test4 = await testOldBrokenBehaviorMustFail();

  console.log('\n=== Summary ===');
  console.log(`AsyncLocalStorage Concurrency Test: ${test1 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Nested Context Test:                ${test2 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Promise Chain Test:                 ${test3 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Old Pattern Regression Test:        ${test4 ? '✅ PASS' : '❌ FAIL'}`);

  const allPassed = test1 && test2 && test3 && test4;
  
  if (allPassed) {
    console.log('\n✅ ALL TESTS PASSED');
    console.log('   - AsyncLocalStorage correctly isolates query context');
    console.log('   - The old instance-property pattern demonstrably fails');
  } else {
    console.log('\n❌ SOME TESTS FAILED');
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch(console.error);
