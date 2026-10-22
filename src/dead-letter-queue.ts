import {
  ChangeMessageVisibilityBatchCommand,
  DeleteMessageBatchCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { Delivery, Profile } from "./types.js";

const sqs = new SQSClient({});
const MAX_MESSAGES_TO_SCAN = 1_000;
const MAX_SWEEP_MS = 15_000;

function matchesProfile(body: string | undefined, profile: Profile, messageGroupId?: string): { matches: boolean; kind?: string } {
  if (!body) return { matches: messageGroupId === `sync:${profile}` };
  try {
    const delivery = JSON.parse(body) as Partial<Delivery>;
    return {
      matches: delivery.profile === profile || (typeof delivery.profile !== "string" && messageGroupId === `sync:${profile}`),
      kind: typeof delivery.kind === "string" ? delivery.kind : undefined,
    };
  } catch {
    return { matches: messageGroupId === `sync:${profile}` };
  }
}

/**
 * Remove only quarantined deliveries for the requested sync profile. Other
 * profiles' messages are made visible again before returning. Durable review
 * decisions and repair operations are stored separately and are not deleted.
 */
export async function clearDeadLetterMessagesForProfile(profile: Profile): Promise<{ deleted: number; byKind: Record<string, number> }> {
  const QueueUrl = process.env.DLQ_URL;
  if (!QueueUrl) {
    // Production Lambdas must have the DLQ configured. Local and unit-test
    // invocations without AWS queue configuration have no DLQ to sweep.
    if (process.env.AWS_LAMBDA_FUNCTION_NAME) throw new Error("DLQ_URL is not configured");
    return { deleted: 0, byKind: {} };
  }
  const startedAt = Date.now();
  const held: Array<{ Id: string; ReceiptHandle: string }> = [];
  const byKind: Record<string, number> = {};
  let deleted = 0;
  let scanned = 0;
  let page = 0;

  try {
    while (true) {
      if (Date.now() - startedAt > MAX_SWEEP_MS) throw new Error("DLQ profile clear exceeded its time limit; retry before starting reconciliation");
      const response = await sqs.send(new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ["MessageGroupId"],
      }));
      const messages = response.Messages || [];
      if (!messages.length) break;
      scanned += messages.length;
      if (scanned > MAX_MESSAGES_TO_SCAN) throw new Error("DLQ profile clear reached its scan limit; retry before starting reconciliation");

      const matches: Array<{ Id: string; ReceiptHandle: string; kind?: string }> = [];
      for (const message of messages) {
        if (!message.ReceiptHandle) continue;
        const match = matchesProfile(message.Body, profile, message.Attributes?.MessageGroupId);
        if (match.matches) matches.push({ Id: `m${page}-${matches.length}`, ReceiptHandle: message.ReceiptHandle, kind: match.kind });
        else held.push({ Id: `h${held.length}`, ReceiptHandle: message.ReceiptHandle });
      }

      if (matches.length) {
        const result = await sqs.send(new DeleteMessageBatchCommand({ QueueUrl, Entries: matches.map(({ Id, ReceiptHandle }) => ({ Id, ReceiptHandle })) }));
        if (result.Failed?.length) throw new Error(`Could not delete ${result.Failed.length} matching DLQ message(s); retry before starting reconciliation`);
        deleted += result.Successful?.length || 0;
        for (const match of matches) {
          if (match.kind) byKind[match.kind] = (byKind[match.kind] || 0) + 1;
        }
      }
      page += 1;
    }
  } finally {
    // Messages belonging to other profiles were received only to reach this
    // profile's FIFO group. Release them immediately instead of delaying them
    // for the DLQ visibility timeout.
    for (let offset = 0; offset < held.length; offset += 10) {
      const entries = held.slice(offset, offset + 10).map(({ Id, ReceiptHandle }) => ({ Id, ReceiptHandle, VisibilityTimeout: 0 }));
      const result = await sqs.send(new ChangeMessageVisibilityBatchCommand({ QueueUrl, Entries: entries }));
      if (result.Failed?.length) throw new Error(`Could not release ${result.Failed.length} unrelated DLQ message(s)`);
    }
  }

  console.info(JSON.stringify({ event: "profile_dlq_messages_cleared", profile, deleted, byKind, scanned }));
  return { deleted, byKind };
}
