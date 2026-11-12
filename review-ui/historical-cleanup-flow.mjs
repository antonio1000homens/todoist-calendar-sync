export function claimHistoricalCleanup(locks,key){
  if(locks.has(key))return false;
  locks.add(key);
  return true;
}

export function cleanupSelectionIsCurrent(requestVersion,currentVersion){
  return requestVersion===currentVersion;
}
