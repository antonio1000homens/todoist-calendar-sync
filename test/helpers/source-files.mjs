import { readdir } from "node:fs/promises";
import path from "node:path";

/** Recursively list TypeScript source files for architecture/safety tests.
 * Stable ordering makes failure messages reproducible between platforms.
 */
export async function listTypeScriptSources(root) {
  const files = [];
  async function visit(folder) {
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
    }
  }
  await visit(root);
  return files.sort();
}
