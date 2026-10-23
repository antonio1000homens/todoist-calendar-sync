import assert from 'node:assert/strict';
import { documentClient } from '../../dist/dynamodb-capacity.js';

// Models the conditional reads/writes used by reconciliation, with atomic
// transactions and cloned items so tests exercise DynamoDB's persistence boundary.
export function reconciliationDatabase(t, initial = []) {
  let items = new Map(initial.map((item) => [identity(item), structuredClone(item)]));
  const calls = [];
  const original = documentClient.send;
  const fault = { beforeWrite: undefined, failTransaction: false };
  const failure = () => Object.assign(new Error('condition failed'), { name: 'ConditionalCheckFailedException' });
  function identity(item) { return JSON.stringify([item.pk, item.sk]); }
  function attribute(input, name) { return input.ExpressionAttributeNames?.[name] || name; }
  function check(input, item) {
    const values = input.ExpressionAttributeValues || {};
    return !input.ConditionExpression || input.ConditionExpression.split(' AND ').every((part) => {
      const missing = part.match(/^attribute_not_exists\((.+)\)$/);
      if (missing) return item?.[attribute(input, missing[1])] === undefined;
      const equal = part.match(/^([#\w]+) = (:\w+)$/);
      assert.ok(equal, `unsupported test condition: ${part}`);
      return item?.[attribute(input, equal[1])] === values[equal[2]];
    });
  }
  function write(input, type, target) {
    // A stub that accepts any update would miss the reserved-word regression.
    assert.doesNotMatch(input.UpdateExpression || '', /(?:^|[^#\w])result\s*=/i);
    const id = identity(input.Item || input.Key);
    const current = target.get(id);
    if (!check(input, current)) throw failure();
    if (type === 'Put') { target.set(id, structuredClone(input.Item)); return; }
    const next = { ...current, ...input.Key };
    const [set, remove] = input.UpdateExpression.slice(4).split(' REMOVE ');
    for (const assignment of set.split(', ')) {
      const [name, value] = assignment.split(' = ');
      assert.ok(value in input.ExpressionAttributeValues, `missing update value ${value}`);
      next[attribute(input, name)] = structuredClone(input.ExpressionAttributeValues[value]);
    }
    for (const name of remove?.split(', ') || []) delete next[attribute(input, name)];
    target.set(id, next);
  }
  documentClient.send = async (command) => {
    calls.push(command);
    const input = command.input;
    const type = command.constructor.name;
    if (type === 'GetCommand') return { Item: structuredClone(items.get(identity(input.Key))) };
    if (type === 'QueryCommand') {
      const diagnosticPrefix = input.ExpressionAttributeValues[':prefix'] === 'ITEM#';
      const rows = [...items.values()].filter((row) => row.pk === input.ExpressionAttributeValues[':pk']
        && (!diagnosticPrefix || row.sk.startsWith('ITEM#')))
        .sort((a, b) => a.sk.localeCompare(b.sk));
      const start = input.ExclusiveStartKey ? rows.findIndex((row) => row.sk === input.ExclusiveStartKey.sk) + 1 : 0;
      if (diagnosticPrefix) {
        const selected = rows.slice(start, start + (input.Limit || 100));
        const last = selected.at(-1);
        return { Items: structuredClone(selected),
          LastEvaluatedKey: last && start + selected.length < rows.length ? { pk: last.pk, sk: last.sk } : undefined };
      }
      const row = rows[start];
      return {
        Items: row?.notificationPending ? [structuredClone(row)] : [],
        LastEvaluatedKey: row && start + 1 < rows.length ? { pk: row.pk, sk: row.sk } : undefined,
      };
    }
    if (fault.beforeWrite) { const callback = fault.beforeWrite; fault.beforeWrite = undefined; callback(items, input); }
    if (type === 'TransactWriteCommand') {
      if (fault.failTransaction) throw new Error('synthetic transaction failure');
      const staged = structuredClone(items);
      try {
        for (const entry of input.TransactItems) {
          const [operation, payload] = Object.entries(entry)[0];
          write(payload, operation, staged);
        }
      } catch (error) {
        if (error.name !== 'ConditionalCheckFailedException') throw error;
        throw Object.assign(new Error('transaction cancelled'), {
          name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        });
      }
      items = staged;
      return {};
    }
    assert.ok(['PutCommand', 'UpdateCommand'].includes(type), `unexpected command ${type}`);
    write(input, type === 'PutCommand' ? 'Put' : 'Update', items);
    return {};
  };
  t.after(() => { documentClient.send = original; });
  return { calls, fault, get: (pk, sk = 'STATE') => structuredClone(items.get(identity({ pk, sk }))) };
}
