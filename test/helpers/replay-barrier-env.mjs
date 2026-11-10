/**
 * Deterministic test-only environment setup for the disabled legacy HMAC
 * admission reader. Callers own cleanup, so per-test and per-file fixtures
 * share one exact implementation without changing production flags.
 */
export function enableReplayBarrierFixture({keySeed,extra={}}) {
  if(!Number.isInteger(keySeed)||keySeed<0||keySeed>255)
    throw new Error("Replay fixture requires a byte-sized key seed");
  const values={
    ERASURE_REPLAY_BARRIER_VERSION:"1",
    ERASURE_PROTOCOL_VERSION:"1",
    ERASURE_REPLAY_HMAC_KEYS:JSON.stringify({v1:Buffer.alloc(32,keySeed).toString("base64")}),
    ERASURE_REPLAY_HMAC_CURRENT_KEY:"v1",
    ...extra,
  };
  const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  Object.assign(process.env,values);
  return ()=>{
    for(const [key,value] of Object.entries(previous))
      if(value===undefined)delete process.env[key];
      else process.env[key]=value;
  };
}
