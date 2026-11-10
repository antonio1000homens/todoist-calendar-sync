// Shared, provider-free decision fixtures for status-inbox tests.
// Tests must never use Slack or DynamoDB to set up the status inbox.
export const TEST_SLACK_CHANNEL = "CTESTCHANNEL";

export function decision(id, type = "operational_dlq", profile = "antonio") {
  return {
    decisionId: id,
    profile,
    type,
    severity: "warning",
    status: "pending",
    createdAt: "2026-09-07T20:00:00.000Z",
    decisionDeadline: "2026-09-14T20:00:00.000Z",
    context: {},
    fingerprint: id,
    permittedActions: [{ id: "reconcile_now", label: "Reconcile now" }],
  };
}

export class FakeStore {
  constructor(decisions) {
    this.decisions = new Map(decisions.map(item => [item.decisionId, { ...item }]));
    this.failNextReadFor = new Set();
    this.finishes = [];
  }

  async get(id) {
    if (this.failNextReadFor.delete(id)) throw new Error(`read failed for ${id}`);
    const item = this.decisions.get(id);
    return item ? { ...item } : undefined;
  }

  async finish(id, status, resolution, actor) {
    this.finishes.push({ id, status, resolution, actor });
    const previous = this.decisions.get(id);
    if (previous) this.decisions.set(id, { ...previous, status });
  }

  async listPending(profile) {
    return [...this.decisions.values()]
      .filter(item => item.status === "pending" && (!profile || item.profile === profile))
      .map(item => ({ ...item }));
  }

  markPosted(id, ts) {
    this.decisions.set(id, {
      ...this.decisions.get(id),
      slackMessageTs: ts,
      slackChannelId: TEST_SLACK_CHANNEL,
    });
  }
}
