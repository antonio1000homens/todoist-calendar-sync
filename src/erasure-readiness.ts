/** A deliberately separate, exact-match deployment opt-in for destructive erasure.
 * An operation-level confirmation is necessary but never sufficient.
 */
export function erasureExecutionEnabled(): boolean {
  return process.env.ERASURE_EXECUTION_ENABLED === "true"
    && process.env.ERASURE_PROTOCOL_VERSION === "1";
}
