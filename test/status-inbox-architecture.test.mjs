import test from 'node:test';
import assert from 'node:assert/strict';

// Architecture guard for issue #57: show_status must route through the recovery
// inbox so stale provider-auth decisions are revalidated before Slack rendering.
const { readFile } = await import('node:fs/promises');

const workerSource = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');
const inboxSource = await readFile(new URL('../src/status-inbox.ts', import.meta.url), 'utf8');

test('show_status uses the status recovery inbox', () => {
  assert.match(workerSource, /processStatusInbox/);
  assert.match(workerSource, /delivery\.manual\?\.command === "show_status"/);
});

test('status inbox revalidates provider auth decisions without provider writes', () => {
  assert.match(inboxSource, /operational_provider_auth/);
  assert.match(inboxSource, /findByTodoistTaskId/);
  assert.match(inboxSource, /listTasks/);
  assert.doesNotMatch(inboxSource, /upsertEvent|deleteEvent|upsertTask|deleteTask/);
  assert.match(inboxSource, /"stale"/);
  assert.match(inboxSource, /provider authentication recovered before status rendering/);
});
