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


// Most scope and retry behaviour is already tested against the exported
// reconciliation-scope and api-client modules. Keep only minimal UI wiring
// guards here, rather than freezing JSX wording or repeating those tests.
const reviewSource = await readFile(new URL('../review-ui/main.tsx', import.meta.url), 'utf8');

function reviewSection(start, next) {
  const from = reviewSource.indexOf(start);
  const until = reviewSource.indexOf(next, from + start.length);
  assert.ok(from >= 0 && until > from, `Missing review action: ${start}`);
  return reviewSource.slice(from, until);
}

test('review UI wires scope changes and single-profile reconciliation to the shared contracts', () => {
  const switcher = reviewSection('const changeReviewProfile=', 'const editId=');
  // The pure request-gate and manual-target behaviour is covered in
  // reconciliation-scope.test.mjs; verify the UI actually uses those helpers.
  assert.match(switcher, /navigationSequence\.current\+\+/);
  assert.match(switcher, /requestGate\.switchScope\(next\)/);
  assert.match(switcher, /setCases\(\[\]\)/);
  assert.match(switcher, /setRunViews\(\{\}\)/);
  assert.match(switcher, /selectCase\(undefined\)/);

  const run = reviewSection('const runReconciliation=', 'const dismissAlert=');
  assert.match(run, /const target=manualTarget/);
  assert.match(run, /if\(!target\)/);
  assert.match(run, /requestGate\.begin\(`manual:\$\{target\}`,profile\)/);
  assert.match(run, /api\("reconciliation",\{method:"POST",body:JSON\.stringify\(\{profile:target\}\)\}\)/);
  assert.doesNotMatch(run, /reconciliationScopes\(/,
    'manual action must never fan out across all profiles');

  // Only check stable data references, not headings, wording, order or whether
  // empty diagnostics are visible; separate UI work can hide unused sections.
  for (const field of ['candidateTaskIds', 'candidateEventIds', 'discardedTaskId', 'retainedTaskId', 'decisionId']) {
    assert.ok(reviewSource.includes(`item.detail.${field}`), `Missing diagnostic identity ${field}`);
  }
  assert.match(reviewSource, /actionableCaseCount/,
    'actionable alert count must remain separate from run diagnostics');
});

test('dismissing an alert is a single safe POST and cannot clear another selected case', () => {
  const dismiss = reviewSection('const dismissAlert=', 'const decisionActions=');
  assert.match(dismiss, /if\(!selected\|\|selected\.status!=="open"\)return;/);
  assert.match(dismiss, /api\(`cases\/\$\{encodeURIComponent\(dismissedCaseId\)\}\/dismiss`,\{method:"POST",body:"\{\}"\}\)/);
  assert.doesNotMatch(dismiss, /(?:window\.)?confirm\s*\(/);
  assert.match(dismiss, /if\(selectedVersion===selectionVersion\.current\)selectCase\(undefined\)/);
  assert.ok(
    dismiss.indexOf('await api(`cases/') < dismiss.indexOf('selectCase(undefined)'),
    'selection must only clear after the dismiss request succeeds',
  );
});

test('recorded evidence stays in the review case and delivery failure is not replayed', () => {
  const evidence = reviewSection('<section className="preview alert-evidence">', '</section>');
  assert.match(evidence, /JSON\.stringify\(selected\.decision\?\.context\|\|\{\},null,2\)/);
  assert.match(evidence, /selected\.decision\?\.type\?\.startsWith\("operational_"\)/);
  assert.match(evidence, /A failed delivery is not replayed/);
  assert.doesNotMatch(evidence, /Why this alert is open|Delivery failure details|Recorded provider identities/);
});
