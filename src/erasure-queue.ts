import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const queue = new SQSClient({});

function queueUrl(): string {
  const value=process.env.ERASURE_OPERATION_QUEUE_URL?.trim();
  if(!value) throw new Error("ERASURE_OPERATION_QUEUE_URL is not configured");
  return value;
}

export function erasureOperationDelaySeconds(nextRunAt?: number, now=Date.now()): number {
  if(nextRunAt===undefined) return 0;
  if(!Number.isFinite(nextRunAt)) throw new Error("Invalid erasure operation next-run time");
  return Math.min(900,Math.max(0,Math.ceil((nextRunAt-now)/1000)));
}

/** Queue payloads contain only the durable operation identity, never item selections or evidence. */
export async function enqueueErasureOperation(operationId: string, nextRunAt?: number): Promise<void> {
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new Error("Invalid erasure operation ID");
  await queue.send(new SendMessageCommand({QueueUrl:queueUrl(),
    MessageBody:JSON.stringify({version:1,operationId}),
    DelaySeconds:erasureOperationDelaySeconds(nextRunAt)}));
}
