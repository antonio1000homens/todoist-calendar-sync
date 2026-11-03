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

test('profile-scoped active run polling refreshes the inbox and distinguishes diagnostics from review cases', async () => {
  const source = await readFile(new URL('../review-ui/main.tsx', import.meta.url), 'utf8');
  const polling = source.match(/const pollingProfiles=[\s\S]*?\n  \},\[profile,pollingKey\]\);/)?.[0] || '';
  assert.match(polling,/overviewProfiles\.filter/);
  assert.match(polling,/refreshReconciliation\(target,\{quiet:true\}\)/);
  assert.match(polling,/setTerminalInboxRefreshPending\(true\)/);
  assert.match(polling,/!data\.reconciliation\?\.pending/);
  assert.match(polling,/\["succeeded","needs_review","failed"\]/);
  assert.match(polling,/actionableCaseCount/);
  assert.match(source,/createRetryingTask\(\{[\s\S]*?run:refresh,[\s\S]*?onSuccess:\(\)=>setTerminalInboxRefreshPending\(false\)/);
  assert.match(source,/Latest reconciliation · \{runProfile\}/);
  assert.match(source,/Run diagnostics · \{runProfile\}/);
  assert.match(source,/Actionable review cases for \{runProfile\}/);
  assert.match(source,/open or repairing review alerts shown in/);
  assert.match(source,/run diagnostics, not the number of open alerts/);
  assert.doesNotMatch(source,/Latest reconciliation · \{reconcileProfile\}/);
  assert.ok(source.includes('Candidate tasks: {item.detail.candidateTaskIds.join(", ")}'));
  assert.ok(source.includes('Candidate Calendar events: {item.detail.candidateEventIds.join(", ")}'));
  assert.ok(source.includes('Discarded task: {item.detail.discardedTaskId}'));
  assert.ok(source.includes('Retained task: {item.detail.retainedTaskId}'));
  assert.ok(source.includes('Decision: {item.detail.decisionId}'));
});

test('switching filter clears previous case and results, and keeps the labelled manual POST scope identical', async () => {
  const source = await readFile(new URL('../review-ui/main.tsx', import.meta.url), 'utf8');
  const switcher = source.match(/const changeReviewProfile=\(next:string\)=>\{([\s\S]*?)\n  \};/)?.[1]||'';
  assert.match(switcher,/navigationSequence\.current\+\+/);
  assert.match(switcher,/requestGate\.switchScope\(next\)/);
  assert.match(switcher,/setReconcileProfile\(next==="all"\?"":next\)/);
  assert.match(switcher,/setCases\(\[\]\)/);
  assert.match(switcher,/setRunViews\(\{\}\)/);
  assert.match(switcher,/selectCase\(undefined\)/);
  assert.match(source,/Review alerts — profile/);
  assert.match(source,/All profiles/);
  assert.match(source,/for\(const target of reconciliationScopes\(profile\)\)/);
  assert.match(source,/const manualTarget=manualReconciliationTarget/);
  assert.match(source,/body:JSON\.stringify\(\{profile:target\}\)/);
  assert.match(source,/Target sync profile: <strong>\{manualTarget/);
  assert.match(source,/disabled=\{busy\|\|!manualTarget\}/);
  assert.match(source,/if\(navigationId!==navigationSequence\.current\)return/);
  assert.match(source,/navigationId===navigationSequence\.current/);
  assert.match(source,/else window\.history\.replaceState\(null,"",next\)/);
  assert.doesNotMatch(switcher,/runReconciliation\(/);
});
test('dismissing an open review alert is single-click without changing the dismiss-only action', async () => {
  const source = await readFile(new URL('../review-ui/main.tsx', import.meta.url), 'utf8');
  const dismiss = source.match(/const dismissAlert=async \(\) => \{([\s\S]*?)\n  \};/)?.[1];
  assert.ok(dismiss, 'dismiss handler must remain available');
  assert.doesNotMatch(dismiss, /(?:window\.)?confirm\s*\(/);
  assert.match(dismiss, /if\(!selected\|\|selected\.status!=="open"\)return;/);
  assert.ok(dismiss.includes('api(`cases/${encodeURIComponent(dismissedCaseId)}/dismiss`,{method:"POST",body:"{}"})'));
  assert.match(dismiss, /setBusy\(true\)/);
  assert.match(dismiss, /Alert dismissed\. Select another alert/);
  const requestPosition=dismiss.indexOf("await api(`cases/");
  const clearedPosition=dismiss.indexOf("selectCase(undefined)");
  assert.ok(requestPosition>=0 && clearedPosition>requestPosition, "selection clears only after dismissal succeeds");
  assert.ok(dismiss.includes("selectedVersion===selectionVersion.current)selectCase(undefined)"), "do not clear newly selected cases");
  assert.doesNotMatch(dismiss, /selectCase\(result\.item/);
  assert.ok(source.includes('else window.history.replaceState(null,"",next)'), "clearing selection also removes the case URL parameter");
  assert.match(source, /onClick=\{dismissAlert\} disabled=\{busy\}>Dismiss alert only/);
});

test('review alert detail shows recorded evidence without redundant explanation and identity metadata', async () => {
  const source = await readFile(new URL('../review-ui/main.tsx', import.meta.url), 'utf8');
  const evidence = source.match(/<section className="preview alert-evidence">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(evidence, 'recorded alert evidence section must be present');
  assert.match(evidence, /<details><summary>Recorded alert evidence<\/summary>\s*<pre>\{JSON\.stringify\(selected\.decision\?\.context\|\|\{\},null,2\)\}<\/pre>/);
  assert.doesNotMatch(evidence, /Why this alert is open|Recorded reason:|First seen \/ opened|Recorded provider identities|Search Todoist candidates|Search Calendar candidates/);
  assert.doesNotMatch(source, /<h3>Why this alert is open<\/h3>/);
  assert.doesNotMatch(source, /<summary>Delivery failure details<\/summary>/);
  assert.match(evidence, /selected\.decision\?\.type\?\.startsWith\("operational_"\)/);
  assert.match(evidence, /A failed delivery is not replayed/);
});
