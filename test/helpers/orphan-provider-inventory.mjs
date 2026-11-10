// Fresh three-profile inventories for pre-deletion proof and post-deletion
// readback. Always allocate independent arrays: tests mutate these fixtures.
export const ORPHAN_PROFILES = Object.freeze(["home", "antonio", "work"]);

export function emptyOrphanProviderInventories() {
  return ORPHAN_PROFILES.map(profile => ({
    profile,
    tasks: [],
    events: [],
    comments: [],
  }));
}

export function emptyOrphanProviderCatalog() {
  return Object.fromEntries(emptyOrphanProviderInventories().map(
    ({ profile, ...items }) => [profile, items],
  ));
}
