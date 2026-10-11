// Read-only source hash inventory. Print JSON; callers save outside a frozen tree.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const sha = x => createHash('sha256').update(x).digest('hex');
export async function runtimeHashes() {
  const files = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (['node_modules','.build','RUNTIME_BUILD_MANIFEST.json'].includes(entry.name)) continue;
      const f = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Unexpected source symlink');
      if (entry.isDirectory()) await walk(f);
      else if (entry.isFile()) { const bytes = await fs.readFile(f); files.push({ path: path.relative(ROOT, f).split(path.sep).join('/'), sha256: sha(bytes), bytes: bytes.length }); }
    }
  }
  await walk(ROOT); files.sort((a,b) => a.path.localeCompare(b.path));
  return { schema_version: 1, measurement: 'CONTROLLED_FRAME_PROXY', source_hashes: files,
    source_list_sha256: sha(JSON.stringify(files)), package_lock_sha256: sha(await fs.readFile(path.join(ROOT,'package-lock.json'))),
    native_counso_status: 'UNKNOWN', browser_functional_status: 'UNKNOWN_UNTIL_BOUND_RECEIPTS', observed_node: process.version,
    hash_observed_utc: new Date().toISOString(), generated_artifacts_excluded: ['node_modules','.build','RUNTIME_BUILD_MANIFEST.json'] };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await runtimeHashes(), null, 2));
