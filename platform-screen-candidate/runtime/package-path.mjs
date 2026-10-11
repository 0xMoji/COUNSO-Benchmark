/** One lexical namespace rule for trusted synthetic package roots. No file I/O.
 * A valid target has a relative key; an invalid/escaping spelling never has one.
 * Callers still enforce existing-file and declared read/write allowlists.
 */
import path from 'node:path';
export function canonicalPackageTarget(packageRoot, suppliedPath) {
  if (typeof packageRoot !== 'string' || !packageRoot || packageRoot.includes('\\') || packageRoot.includes('\0')
      || typeof suppliedPath !== 'string' || !suppliedPath || suppliedPath.includes('\0')) return undefined;
  const root = path.resolve(packageRoot);
  let relative = suppliedPath.startsWith(packageRoot + '/') ? suppliedPath.slice(packageRoot.length + 1) : suppliedPath;
  const url = /^[a-z][a-z0-9+.-]*:/i.test(suppliedPath);
  const target = url ? suppliedPath : path.resolve(root, relative);
  const outside = url || target !== root && !target.startsWith(root + path.sep);
  if (relative.startsWith('./')) relative = relative.slice(2);
  const legal = !outside && !path.isAbsolute(relative) && !relative.includes('\\')
    && relative.split('/').every(part => part && part !== '.' && part !== '..');
  return {relative: legal ? relative : null, target, package_root: root, outside};
}
