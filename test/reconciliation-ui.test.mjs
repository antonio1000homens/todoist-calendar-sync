import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ReviewStore } from '../dist/review-store.js';

test('open review case count paginates and excludes terminal cases', async () => {
  const pages = [
    { items: [{ status: 'open' }, { status: 'dismissed' }], cursor: { page: 2 } },
    { items: [{ status: 'open' }, { status: 'repairing' }, { status: 'resolved' }], cursor: undefined },
  ];
  const calls = [];
  const store = new ReviewStore({ async send(command) {
    calls.push(command.input.ExclusiveStartKey);
    return { Items: pages.shift().items, LastEvaluatedKey: calls.length === 1 ? { page: 2 } : undefined };
  } });
  assert.equal(await store.countActionableCases('home'), 3);
  assert.equal(calls.length, 2);
});

test('active run polling refreshes the inbox and announces terminal status without implying inbox clearance', async () => {
  const source = await readFile(new URL('../review-ui/main.tsx', import.meta.url), 'utf8');
  const polling = source.match(/useEffect\(\(\) => \{\n    const currentRunStatus=[\s\S]*?\n  \},\[reconcileProfile,[^\]]+\]\);/)?.[0] || '';
  assert.match(polling, /refreshReconciliation\(reconcileProfile\)/);
  assert.match(polling, /await refresh\(\)/);
  assert.match(polling, /!data\.reconciliation\?\.pending/);
  assert.match(polling, /\["succeeded","needs_review","failed"\]\.includes\(currentRunStatus\|\|""\)/);
  assert.match(polling, /\["succeeded","needs_review","failed"\]\.includes\(runStatus\)/);
  assert.match(polling, /if\(terminal\|\|!data\.reconciliation\?\.pending\)/);
  assert.match(polling, /actionableCaseCount/);
  assert.match(source, /Run: \{reconciliation\.summary\.runStatus\}; unresolved in this run: \{reconciliation\.summary\.runUnresolved\}\. Actionable review cases remaining: \{reconciliation\.summary\.actionableCaseCount\}\./);
});
