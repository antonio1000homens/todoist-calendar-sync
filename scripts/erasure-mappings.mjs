export async function restoreMappings(mappingIds, { update, get, pause, timeoutMs = 60_000 }) {
  await Promise.all(mappingIds.map(UUID => update(UUID)));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await Promise.all(mappingIds.map(UUID => get(UUID)));
    if (current.every(mapping => mapping.State === "Enabled")) return;
    await pause(1000);
  }
  throw new Error("Previously enabled worker SQS mappings did not all return to Enabled state");
}
