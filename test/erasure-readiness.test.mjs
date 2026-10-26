import test from "node:test";
import assert from "node:assert/strict";
import { erasureExecutionEnabled } from "../dist/erasure-readiness.js";

test("execution requires an exact deployment opt-in and protocol v1", t=>{
  const previous={enabled:process.env.ERASURE_EXECUTION_ENABLED,protocol:process.env.ERASURE_PROTOCOL_VERSION};
  t.after(()=>{
    for(const [key,value] of Object.entries({ERASURE_EXECUTION_ENABLED:previous.enabled,
      ERASURE_PROTOCOL_VERSION:previous.protocol})) {
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  });

  delete process.env.ERASURE_EXECUTION_ENABLED;
  process.env.ERASURE_PROTOCOL_VERSION="1";
  assert.equal(erasureExecutionEnabled(),false);
  process.env.ERASURE_EXECUTION_ENABLED="TRUE";
  assert.equal(erasureExecutionEnabled(),false);
  process.env.ERASURE_EXECUTION_ENABLED="true";
  delete process.env.ERASURE_PROTOCOL_VERSION;
  assert.equal(erasureExecutionEnabled(),false);
  process.env.ERASURE_PROTOCOL_VERSION="0";
  assert.equal(erasureExecutionEnabled(),false);
  process.env.ERASURE_PROTOCOL_VERSION="1";
  assert.equal(erasureExecutionEnabled(),true);
});
