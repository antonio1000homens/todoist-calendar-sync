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
  const polling = source.match(/useEffect\(\(\) => \{\r?\n    const currentRunStatus=[\s\S]*?\r?\n  \},\[reconcileProfile,[^\]]+\]\);/)?.[0] || '';
  assert.match(polling, /refreshReconciliation\(reconcileProfile\)/);
  assert.match(polling, /setTerminalInboxRefreshPending\(true\)/);
  assert.match(polling, /!data\.reconciliation\?\.pending/);
  assert.match(polling, /\["succeeded","needs_review","failed"\]\.includes\(currentRunStatus\|\|""\)/);
  assert.match(polling, /\["succeeded","needs_review","failed"\]\.includes\(runStatus\)/);
  assert.match(polling, /if\(terminal\|\|!data\.reconciliation\?\.pending\)/);
  assert.match(polling, /actionableCaseCount/);
  assert.match(source, /createRetryingTask\(\{[\s\S]*?run:refresh,[\s\S]*?onSuccess:\(\)=>setTerminalInboxRefreshPending\(false\)/);
  assert.match(source, /Latest reconciliation · \{reconcileProfile\}/);
  assert.match(source, /Items deferred or blocked during this run/);
  assert.match(source, /Open review alerts/);
  assert.match(source, /these counts measure different things/);
  assert.doesNotMatch(source, /Unresolved items for this run/);
  assert.ok(source.includes('Candidate tasks: {item.detail.candidateTaskIds.join(", ")}'));
  assert.ok(source.includes('Candidate Calendar events: {item.detail.candidateEventIds.join(", ")}'));
  assert.ok(source.includes('Discarded task: {item.detail.discardedTaskId}'));
  assert.ok(source.includes('Retained task: {item.detail.retainedTaskId}'));
  assert.ok(source.includes('Decision: {item.detail.decisionId}'));
});

test('dismissing an open review alert is single-click without changing the dismiss-only action', async () => {
  const source = await readFile(new URL('../review-ui/main.tsx', import.meta.url), 'utf8');
  const dismiss = source.match(/const dismissAlert=async \(\) => \{([\s\S]*?)\n  \};/)?.[1];
  assert.ok(dismiss, 'dismiss handler must remain available');
  assert.doesNotMatch(dismiss, /(?:window\.)?confirm\s*\(/);
  assert.match(dismiss, /if\(!selected\|\|selected\.status!=="open"\)return;/);
  assert.ok(dismiss.includes('api(`cases/${encodeURIComponent(selected.id)}/dismiss`,{method:"POST",body:"{}"})'));
  assert.match(dismiss, /setBusy\(true\)/);
  assert.match(dismiss, /Alert dismissed\. Its history remains available/);
  assert.match(source, /onClick=\{dismissAlert\} disabled=\{busy\}>Dismiss alert only/);
});

test('review alert detail shows recorded evidence without redundant explanation and identity metadata', async () => {
  const source = await readFile(new URL('../review-ui/main.tsx', import.meta.url), 'utf8');
  const evidence = source.match(/<section className="preview alert-evidence">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(evidence, 'recorded alert evidence section must be present');
  assert.match(evidence, /<details><summary>Recorded alert evidence<\/summary><pre>\{JSON\.stringify\(selected\.decision\?\.context\|\|\{\},null,2\)\}<\/pre><\/details>/);
  assert.doesNotMatch(evidence, /Why this alert is open|Recorded reason:|First seen \/ opened|Recorded provider identities|Search Todoist candidates|Search Calendar candidates/);
  assert.doesNotMatch(source, /<h3>Why this alert is open<\/h3>/);
  assert.doesNotMatch(source, /<summary>Delivery failure details<\/summary>/);
  assert.match(evidence, /selected\.decision\?\.type\?\.startsWith\("operational_"\)/);
  assert.match(evidence, /A failed delivery is not replayed/);
});
