import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SYNC_RECEIVES, DLQ_RETENTION_SECONDS, failedDeliveryDisposition,
  isTransientDynamoDbFailure, quarantineFailedRecord,
  shortenTransientRetryVisibility, syncFailureQueueClient,
  transientRetryVisibilitySeconds,
} from "../dist/sqs-failure-policy.js";
import { handler } from "../dist/worker.js";
import { StateRepository } from "../dist/repository.js";
import { ManualInterventionService } from "../dist/manual-intervention.js";
import { OrphanRecoveringSynchronizer } from "../dist/orphan-recovery.js";
import { syncMessageGroupId } from "../dist/types.js";

function namedError(name, fields = {}) {
  const e = new Error(name);
  e.name = name;
  Object.assign(e, fields);
  return e;
}
const throttle = () => namedError("ProvisionedThroughputExceededException");
const record = (kind="calendar", profile="home", receiveCount="1") => ({
  messageId:`message-${profile}-${kind}`, receiptHandle:"receipt",
  attributes:{ApproximateReceiveCount:receiveCount,MessageGroupId:syncMessageGroupId(profile),SequenceNumber:"101",SentTimestamp:String(Date.now())},
  body:JSON.stringify({
    id:`delivery-${profile}-${kind}`,kind,profile,mode:"aws",receivedAt:new Date().toISOString(),
    headers:{},body:kind==="todoist"?JSON.stringify({event_name:"item:updated",event_data:{id:"task-1"}}):"",
  }),
});

test("transient DynamoDB classification is strict across wrapped errors and transaction reasons", () => {
  for (const name of ["ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded",
    "ServiceUnavailable", "InternalServerError", "TransactionInProgressException"]) {
    assert.equal(isTransientDynamoDbFailure(namedError(name)), true, name);
  }
  assert.equal(isTransientDynamoDbFailure(namedError("ReconciliationItemError", {cause:throttle()})), true);
  assert.equal(isTransientDynamoDbFailure(namedError("TransactionCanceledException", {
    CancellationReasons:[{Code:"None"},{Code:"ProvisionedThroughputExceeded"}],
  })), true);
  for (const error of [
    namedError("TransactionCanceledException"), // unknown cancellation == unsafe
    namedError("TransactionCanceledException",{CancellationReasons:[{Code:"ConditionalCheckFailed"},{Code:"ThrottlingError"}]}),
    namedError("TransactionCanceledException",{CancellationReasons:[{Code:"TransactionConflict"}]}),
    namedError("ConditionalCheckFailedException"),
    namedError("ErasureEpochChangedError"),
    namedError("ProviderError",{status:429,$retryable:{throttling:true}}),
    namedError("ProviderError",{status:400}),
  ]) assert.equal(isTransientDynamoDbFailure(error), false, error.name);
});

test("only safe incremental types can retry; the fifth receive is terminal", () => {
  const ddb=throttle();
  assert.deepEqual(failedDeliveryDisposition(ddb,{kind:"calendar"},false,1),{
    kind:"retry_fifo",reason:"transient_dynamodb",receiveCount:1,
  });
  assert.equal(failedDeliveryDisposition(ddb,{kind:"todoist"},false,4).kind,"retry_fifo");
  assert.equal(failedDeliveryDisposition(ddb,{kind:"calendar"},false,5).reason,"retries_exhausted");
  assert.equal(failedDeliveryDisposition(ddb,{kind:"calendar"},true,1).reason,"partial_provider_mutation");
  for(const kind of ["reconcile","repair","manual","orphan"]){
    assert.equal(failedDeliveryDisposition(ddb,{kind},false,1).reason,"unverified_delivery_type");
  }
  assert.equal(failedDeliveryDisposition(namedError("ConditionalCheckFailedException"),{kind:"calendar"},false,1).reason,"non_transient");
  assert.equal(MAX_SYNC_RECEIVES,5);
  assert.equal(DLQ_RETENTION_SECONDS,1209600);
  assert.deepEqual([1,2,3,4].map(transientRetryVisibilitySeconds),[30,60,120,240]);
});

test("SQS retry only changes original receipt visibility, while quarantine preserves original body and group", async (t) => {
  const sent=[];
  t.mock.method(syncFailureQueueClient,"send",async cmd=>{sent.push(cmd);return {}});
  const oldDlq=process.env.DLQ_URL,oldSource=process.env.SYNC_QUEUE_URL;
  process.env.DLQ_URL="https://example.test/dlq.fifo";
  process.env.SYNC_QUEUE_URL="https://example.test/source.fifo";
  t.after(()=>{
    if(oldDlq===undefined)delete process.env.DLQ_URL;else process.env.DLQ_URL=oldDlq;
    if(oldSource===undefined)delete process.env.SYNC_QUEUE_URL;else process.env.SYNC_QUEUE_URL=oldSource;
  });
  const message=record("calendar","work");
  await shortenTransientRetryVisibility(message,2);
  assert.equal(sent[0].constructor.name,"ChangeMessageVisibilityCommand");
  assert.equal(sent[0].input.QueueUrl,process.env.SYNC_QUEUE_URL);
  assert.equal(sent[0].input.ReceiptHandle,message.receiptHandle);
  assert.equal(sent[0].input.VisibilityTimeout,60);
  await quarantineFailedRecord(message,"work");
  assert.equal(sent[1].constructor.name,"SendMessageCommand");
  assert.equal(sent[1].input.QueueUrl,process.env.DLQ_URL);
  assert.equal(sent[1].input.MessageBody,message.body);
  assert.equal(sent[1].input.MessageGroupId,"sync:work");
  assert.match(sent[1].input.MessageDeduplicationId,/^[a-f0-9]{64}$/);
});

function setupHandler(t,{receive="1",failure=throttle(),kind="calendar",profile="home",priorMutation=false,
 completed=false,failHandoff=false,failVisibility=false}={}){
  const older={protocol:process.env.ERASURE_PROTOCOL_VERSION,source:process.env.SYNC_QUEUE_URL,dlq:process.env.DLQ_URL};
  // State fixtures exercise the worker without AWS or provider calls.
  delete process.env.ERASURE_PROTOCOL_VERSION;
  process.env.SYNC_QUEUE_URL="https://example.test/source.fifo";
  process.env.DLQ_URL="https://example.test/dlq.fifo";
  t.after(()=>{
    for(const [key,value] of [["ERASURE_PROTOCOL_VERSION",older.protocol],["SYNC_QUEUE_URL",older.source],["DLQ_URL",older.dlq]]){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  });
  const sent=[];
  t.mock.method(syncFailureQueueClient,"send",async cmd=>{
    sent.push(cmd);
    if(cmd.constructor.name==="SendMessageCommand"&&failHandoff)throw new Error("SQS handoff unavailable");
    if(cmd.constructor.name==="ChangeMessageVisibilityCommand"&&failVisibility)throw new Error("SQS visibility unavailable");
    return {};
  });
  t.mock.method(StateRepository.prototype,"isDeliveryCompleted",async()=>{if(!completed && !priorMutation)throw failure;return completed;});
  const mark=t.mock.method(StateRepository.prototype,"markDeliveryCompleted",async()=>{});
  t.mock.method(StateRepository.prototype,"getSyncToken",async()=> "token");
  t.mock.method(StateRepository.prototype,"mutationAllowed",async()=>true);
  t.mock.method(StateRepository.prototype,"audit",async()=>{});
  const write=t.mock.method(StateRepository.prototype,"recordMutation",async()=>{throw failure;});
  const provider=t.mock.method(OrphanRecoveringSynchronizer.prototype,"process",async function(delivery){
    if(priorMutation)await this.state.recordMutation(delivery.profile);
  });
  t.mock.method(ManualInterventionService.prototype,"interceptTodoistDeletion",async()=>false);
  const alerts=t.mock.method(ManualInterventionService.prototype,"reportDeliveryFailure",async()=>{});
  return {record:record(kind,profile,receive),sent,mark,write,provider,alerts};
}

test("short DynamoDB throttling retries IN PLACE without ack, DLQ or provider writes",async t=>{
  const f=setupHandler(t);
  const result=await handler({Records:[f.record]},{awsRequestId:"req-1"});
  assert.deepEqual(result,{batchItemFailures:[{itemIdentifier:f.record.messageId}]});
  assert.deepEqual(f.sent.map(c=>c.constructor.name),["ChangeMessageVisibilityCommand"]);
  assert.equal(f.provider.mock.callCount(),0);
  assert.equal(f.mark.mock.callCount(),0);
  assert.equal(f.alerts.mock.callCount(),0);
});

test("visibility API failure cannot acknowledge or lose the source FIFO message",async t=>{
  const f=setupHandler(t,{failVisibility:true});
  const result=await handler({Records:[f.record]},{awsRequestId:"req-visibility"});
  assert.deepEqual(result.batchItemFailures,[{itemIdentifier:f.record.messageId}]);
  assert.equal(f.sent[0].constructor.name,"ChangeMessageVisibilityCommand");
  assert.equal(f.mark.mock.callCount(),0);
});

test("persistent DynamoDB throttling exhausts native attempts and quarantines instead of looping",async t=>{
  const f=setupHandler(t,{receive:"5"});
  const result=await handler({Records:[f.record]},{awsRequestId:"req-5"});
  assert.deepEqual(result.batchItemFailures,[{itemIdentifier:f.record.messageId}]);
  assert.equal(f.sent.length,0,"native SQS DLQ redrive handles the original message at receive limit");
  assert.equal(f.mark.mock.callCount(),0);
  assert.equal(f.alerts.mock.callCount(),1);
});

test("ambiguous provider mutation plus DynamoDB throttle is quarantined directly, never retried",async t=>{
  const f=setupHandler(t,{priorMutation:true,kind:"calendar"});
  const result=await handler({Records:[f.record]},{awsRequestId:"req-partial"});
  assert.deepEqual(result,{batchItemFailures:[]});
  assert.deepEqual(f.sent.map(c=>c.constructor.name),["SendMessageCommand"]);
  assert.equal(f.write.mock.callCount(),1);
  assert.equal(f.mark.mock.callCount(),0);
});

test("nonretryable conditional failure is not blindly retried",async t=>{
  const f=setupHandler(t,{failure:namedError("ConditionalCheckFailedException")});
  const result=await handler({Records:[f.record]},{awsRequestId:"req-conditional"});
  assert.deepEqual(result,{batchItemFailures:[]});
  assert.equal(f.sent[0].constructor.name,"SendMessageCommand");
  assert.equal(f.mark.mock.callCount(),0);
});

test("DLQ handoff failure retains original source message without marking it completed",async t=>{
  const f=setupHandler(t,{failure:namedError("ConditionalCheckFailedException"),failHandoff:true});
  const result=await handler({Records:[f.record]},{awsRequestId:"req-failed-handoff"});
  assert.deepEqual(result.batchItemFailures,[{itemIdentifier:f.record.messageId}]);
  assert.equal(f.mark.mock.callCount(),0);
});

test("redelivery after a durable delivery receipt skips all providers and duplicate writes",async t=>{
  const f=setupHandler(t,{completed:true,receive:"2"});
  const result=await handler({Records:[f.record]},{awsRequestId:"req-duplicate"});
  assert.deepEqual(result,{batchItemFailures:[]});
  assert.equal(f.provider.mock.callCount(),0);
  assert.equal(f.mark.mock.callCount(),0);
  assert.equal(f.sent.length,0);
});

test("home, antonio and work keep independent FIFO retry lanes",()=>{
  for(const profile of ["home","antonio","work"]){
    const input=record("todoist",profile);
    assert.equal(input.attributes.MessageGroupId,`sync:${profile}`);
    assert.equal(failedDeliveryDisposition(throttle(),{kind:"todoist"},false,2).kind,"retry_fifo");
  }
});
