import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositorySource = await readFile(new URL("../src/repository.ts", import.meta.url), "utf8");

test("putMapping storage keys override stale DynamoDB pk/sk fields", () => {
  const putMapping = repositorySource.match(/async putMapping\(mapping: Mapping\): Promise<void>\s*\{[\s\S]*?\n\s*\}/)?.[0] || "";

  assert.match(putMapping, /Item:\s*\{\s*\.\.\.item\s*,\s*\.\.\.key\(`EVENT#/);
  assert.match(putMapping, /Item:\s*\{\s*\.\.\.item\s*,\s*\.\.\.key\(`TASK#/);
  assert.match(putMapping, /Item:\s*\{\s*\.\.\.item\s*,\s*\.\.\.key\(`TASKOWNER#/);
  assert.match(putMapping, /mappingEventLookupAttributes\(mapping\)/);
  assert.match(putMapping, /mappingLookupAttributes\(mapping\)/);
  assert.match(putMapping, /mappingOwnerLookupAttributes\(mapping\)/);
  assert.doesNotMatch(putMapping, /Item:\s*\{\s*\.\.\.key\([^}]+\)\s*,\s*\.\.\.item\s*\}/);
});

test("mapping index keys remain distinct even when the domain object carries a stale storage key", () => {
  const mapping = {
    profile: "home",
    eventId: "event-new",
    taskId: "task-1",
    pk: "EVENT#home#event-old",
    sk: "MAP",
  };
  const item = { ...mapping, updatedAt: "2099-01-01T00:00:00.000Z" };
  const index = (pk) => ({ ...item, pk, sk: "MAP" });

  const items = [
    index(`EVENT#${mapping.profile}#${mapping.eventId}`),
    index(`TASK#${mapping.profile}#${mapping.taskId}`),
    index(`TASKOWNER#${mapping.taskId}`),
  ];

  assert.deepEqual(items.map(({ pk, sk }) => [pk, sk]), [
    ["EVENT#home#event-new", "MAP"],
    ["TASK#home#task-1", "MAP"],
    ["TASKOWNER#task-1", "MAP"],
  ]);
  assert.equal(new Set(items.map(({ pk, sk }) => `${pk}|${sk}`)).size, 3);
});

test("recurrence-link storage key also overrides stale pk/sk fields", () => {
  const putRecurrenceLink = repositorySource.match(/async putRecurrenceLink\(link: RecurrenceLink\): Promise<void>\s*\{[\s\S]*?\n\s*\}/)?.[0] || "";
  assert.match(putRecurrenceLink, /Item:\s*\{\s*\.\.\.link\s*,\s*updatedAt:\s*now\(\)\s*,\s*\.\.\.key\(`RECURRENCE#/);
  assert.match(putRecurrenceLink, /recurrenceLookupAttributes\(link\)/);
});

test("deletes remove canonical rows and let DynamoDB remove derived GSI entries", () => {
  const deleteMapping = repositorySource.match(/async deleteMapping\(mapping: Mapping\): Promise<void>[\s\S]*?\n  async acceptTaskVersion/)?.[0] || "";
  const deleteRecurrence = repositorySource.match(/async deleteRecurrenceLink\(profile: Profile, seriesId: string\): Promise<void>\s*\{[\s\S]*?\n\s*\}/)?.[0] || "";
  assert.match(deleteMapping, /Key: key\(`EVENT#/);
  assert.match(deleteMapping, /Key: key\(`TASK#/);
  assert.match(deleteRecurrence, /Key: key\(`RECURRENCE#/);
  assert.doesNotMatch(deleteMapping, /IndexName:\s*PROFILE_LOOKUP_INDEX_NAME/);
  assert.doesNotMatch(deleteRecurrence, /IndexName:\s*PROFILE_LOOKUP_INDEX_NAME/);
});
