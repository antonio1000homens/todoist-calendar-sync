const terminalOperationStatuses = new Set(["succeeded", "cancelled"]);

export function summarizeLegacyCutover(rows, queueState = {}) {
  const pendingByStatus = {};
  const fencesByProfile = {};
  const replayMarkersByProfile = {};
  const journalsByProfile = {};
  const leasesByProfile = {};
  let terminalOperations = 0;
  let orphanConfirmations = 0;
  const terminalOperationIds = new Set();
  const confirmationOperationIds = new Set();
  for (const row of rows) {
    const pk = typeof row?.pk === "string" ? row.pk : "";
    const sk = typeof row?.sk === "string" ? row.sk : "";
    if (pk.startsWith("ERASURE_OPERATION#") && sk === "STATE") {
      const status = typeof row.status === "string" ? row.status : "unknown";
      if (!terminalOperationStatuses.has(status)) pendingByStatus[status] = (pendingByStatus[status] || 0) + 1;
      else {
        terminalOperations += 1;
        terminalOperationIds.add(pk.slice("ERASURE_OPERATION#".length));
      }
    } else if (pk.startsWith("ERASURE_OPERATION#")) {
      pendingByStatus.unknown_operation_record = (pendingByStatus.unknown_operation_record || 0) + 1;
    } else if (pk.startsWith("ERASURE_CONFIRMATION#") && sk === "STATE") {
      confirmationOperationIds.add(pk.slice("ERASURE_CONFIRMATION#".length));
    } else if (pk.startsWith("ERASURE_CONFIRMATION#")) {
      orphanConfirmations += 1;
    } else if (pk.startsWith("ERASURE#") && sk === "FENCE") {
      const profile = pk.slice("ERASURE#".length);
      fencesByProfile[profile] = (fencesByProfile[profile] || 0) + 1;
    } else if (pk.startsWith("ERASURE#") && sk === "JOURNAL") {
      const profile = pk.slice("ERASURE#".length);
      journalsByProfile[profile] = (journalsByProfile[profile] || 0) + 1;
    } else if (pk.startsWith("ERASURE#") && sk === "SCOPED_ADMISSION") {
      const profile = pk.slice("ERASURE#".length);
      const grants = Array.isArray(row.grants) ? row.grants : [];
      const activeGrants = grants.filter(grant => Number(grant?.expiresAt) > Date.now()).length;
      const activeExclusive = typeof row.exclusiveOwner === "string"
        && Number(row.exclusiveUntil) > Date.now();
      if (activeGrants || activeExclusive) leasesByProfile[profile] =
        (leasesByProfile[profile] || 0) + activeGrants + Number(activeExclusive);
      replayMarkersByProfile[profile] = (replayMarkersByProfile[profile] || 0) + 1;
    } else if (pk.startsWith("ERASURE#") && sk === "EPOCH") {
      const profile = pk.slice("ERASURE#".length);
      replayMarkersByProfile[profile] = (replayMarkersByProfile[profile] || 0) + 1;
    } else if (pk.startsWith("ERASURE#")) {
      const profile = pk.slice("ERASURE#".length);
      leasesByProfile[profile] = (leasesByProfile[profile] || 0) + 1;
    }
  }
  for (const operationId of confirmationOperationIds)
    if (!terminalOperationIds.has(operationId)) orphanConfirmations += 1;
  const queues = Object.fromEntries(["operations", "deadLetter"].map(name => {
    const value = queueState[name] || {};
    return [name, {
      visible: Number(value.visible || 0),
      inFlight: Number(value.inFlight || 0),
      delayed: Number(value.delayed || 0),
    }];
  }));
  const queueMessages = Object.values(queues).reduce((sum, queue) =>
    sum + queue.visible + queue.inFlight + queue.delayed, 0);
  const pendingOperations = Object.values(pendingByStatus).reduce((sum, count) => sum + count, 0);
  const fences = Object.values(fencesByProfile).reduce((sum, count) => sum + count, 0);
  const journals = Object.values(journalsByProfile).reduce((sum, count) => sum + count, 0);
  const activeLeases = Object.values(leasesByProfile).reduce((sum, count) => sum + count, 0);
  const replayMarkers = Object.values(replayMarkersByProfile).reduce((sum, count) => sum + count, 0);
  const idle = pendingOperations === 0 && orphanConfirmations === 0 && fences === 0
    && journals === 0 && activeLeases === 0 && queueMessages === 0;
  return {
    mode: "legacy-erasure-cutover-audit",
    pendingOperations,
    pendingByStatus,
    terminalOperations,
    orphanConfirmations,
    fences,
    fencesByProfile,
    journals,
    journalsByProfile,
    activeLeases,
    leasesByProfile,
    replayMarkers,
    replayMarkersByProfile,
    queues,
    queueMessages,
    idle,
    clean: idle && replayMarkers === 0 && terminalOperations === 0 && orphanConfirmations === 0,
  };
}
