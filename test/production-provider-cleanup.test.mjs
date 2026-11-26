import assert from 'node:assert/strict';
import test from 'node:test';
import { safeDeleteCalendar, safeDeleteTodoist } from '../scripts/production-provider-cleanup.mjs';

test('production cleanup retries transient Todoist deletion failures and is idempotent after a lost acknowledgement', async () => {
  let attempts = 0;
  const waits = [];
  await safeDeleteTodoist({ async deleteTask() {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('network reset'), { name: 'TypeError' });
    if (attempts === 2) throw Object.assign(new Error('already removed'), { status: 404 });
  } }, 'fixture-task', async (ms) => waits.push(ms));
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [250]);
});

test('production cleanup retries transient Calendar errors but does not retry permanent provider errors', async () => {
  let attempts = 0;
  const waits = [];
  await safeDeleteCalendar({ async deleteEvent() {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('busy'), { status: 503 });
  } }, 'fixture-event', async (ms) => waits.push(ms));
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [250]);

  attempts = 0;
  await assert.rejects(safeDeleteCalendar({ async deleteEvent() {
    attempts++;
    throw Object.assign(new Error('forbidden'), { status: 403 });
  } }, 'fixture-event', async () => {}), /forbidden/);
  assert.equal(attempts, 1);
});
