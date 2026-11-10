/**
 * Read-only Lambda EventSourceMapping fake shared by orphan inventory and
 * manifest capture regression tests. Reject every unexpected/mutating API.
 * Callers supply the readback/pagination variations they want to exercise.
 */
export function createLambdaMappingMock({
  functionArn,
  timeoutSeconds=135,
  configuration={},
  list,
  readback,
  recordConfiguration=true,
}={}) {
  if(typeof functionArn!=="string"||!functionArn
    ||typeof list!=="function"||typeof readback!=="function")
    throw new Error("Explicit Lambda identity and both read adapters are required");
  const calls=[];
  const lambda={
    async send(command) {
      const kind=command.constructor.name;
      const input=command.input;
      calls.push({kind,input});
      if(kind==="GetFunctionConfigurationCommand"&&recordConfiguration)
        return {FunctionArn:functionArn,Timeout:timeoutSeconds,State:"Active",
          LastUpdateStatus:"Successful",...configuration};
      if(kind==="ListEventSourceMappingsCommand")return list(input);
      if(kind==="GetEventSourceMappingCommand")return readback(input);
      throw new Error("Unexpected or mutating Lambda API "+kind);
    },
  };
  return {lambda,calls};
}
