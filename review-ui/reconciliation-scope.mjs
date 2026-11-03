/** Explicit review filter vs. single-profile reconciliation semantics.
 * No provider or API side effects belong in this module. */
export const SYNC_PROFILES=Object.freeze(["home","antonio","work"]);
export const REVIEW_FILTERS=Object.freeze(["all",...SYNC_PROFILES]);
export const isSyncProfile=value=>SYNC_PROFILES.includes(value);
export function reconciliationScopes(filter) {
  return filter==="all"?[...SYNC_PROFILES]:isSyncProfile(filter)?[filter]:[];
}
export function manualReconciliationTarget({filter,selectedProfile,chosenProfile}={}) {
  if (isSyncProfile(selectedProfile)) return selectedProfile;
  if (filter==="all") return isSyncProfile(chosenProfile)?chosenProfile:undefined;
  return isSyncProfile(filter)?filter:undefined;
}
export function reviewScopeLabel(filter) {
  return filter==="all"?"all profiles":isSyncProfile(filter)?`profile ${filter}`:"no profile";
}
/** Invalidate any earlier result when the filter changes, even if it switches
 * from home to work and back before the first home response arrives. Also
 * serialize successive requests within an individual lane. */
export function createScopedRequestGate(initialScope="home") {
  let scope=initialScope,epoch=0;
  const latest=new Map();
  return {
    switchScope(next) {
      if(next!==scope){scope=next;epoch++;latest.clear();}
    },
    begin(lane) {
      const sequence=(latest.get(lane)||0)+1;
      latest.set(lane,sequence);
      return {scope,epoch,lane,sequence};
    },
    current(token) {
      return Boolean(token&&token.scope===scope&&token.epoch===epoch
        &&latest.get(token.lane)===token.sequence);
    },
  };
}
