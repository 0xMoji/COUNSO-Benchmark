import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createHash } from 'node:crypto';
import * as esbuild from 'esbuild';
import ts from 'typescript';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const sha = x => createHash('sha256').update(x).digest('hex');

// Fail-only attribution. Never infer candidate responsibility from an arbitrary
// esbuild/OS error string. Other exceptions keep their original unknown origin.
export class CandidatePackageError extends Error {
  constructor(code,reason,{source_file,line=null,column=null,source_sha256=null}={}) {
    super(reason);this.name='CandidatePackageError';
    this.diagnostic={schema_version:1,origin:'TRUSTED_COMPILER_INPUT_GUARD',code,source_file,line,column,reason,source_sha256,phase:'PRE_EXECUTION_SOURCE_VALIDATION'};
  }
}

let officialBundlerPromise;
export let officialCompilerEvidence = null;
// Build the unmodified official graph bundler outside the immutable source tree.
export async function loadOfficialBundler() {
  if (!officialBundlerPromise) officialBundlerPromise = (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'counso-frame-compiler-'));
    const dest = path.join(dir, 'official-bundler.mjs');
    await esbuild.build({ entryPoints: [path.join(ROOT, 'vendor/front/lib/api/bundler/bundle_module.ts')], outfile: dest,
      bundle: true, platform: 'node', format: 'esm', packages: 'external',
      alias: { '@app': path.join(ROOT, 'vendor/front') },
      plugins: [{ name: 'installed-official-esbuild', setup(build) { build.onResolve({ filter: /^esbuild$/ }, () => ({ path: fileURLToPath(import.meta.resolve('esbuild')), external: true })); } }], logLevel: 'silent' });
    officialCompilerEvidence = { emitted_sha256: sha(await fs.readFile(dest)), generated_outside_source_bundle: true };
    return (await import(dest)).bundleModule;
  })();
  return officialBundlerPromise;
}
async function sourceReader(packageDir, functionEntries) {
  const root = await fs.realpath(packageDir), files = [];
  async function walk(dir) {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) throw new Error('Source symlinks are prohibited in the controlled compiler.');
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile()) files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  await walk(root);
  const sourceHashes = {};
  let candidateFailure=null;
  const inputFailure=error=>{candidateFailure=error;throw error};
  return { sourceHashes,get candidateFailure(){return candidateFailure}, list: async () => files, read: async rel => {
    const full = path.resolve(root, rel);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Source path escaped package root.');
    if (rel.startsWith('functions/') || functionEntries.has(rel)) throw new Error('Candidate function entrypoints may not be compiled or executed.');
    if (!/\.(tsx?|jsx?|json)$/.test(rel)) throw new Error('Unsupported candidate import file.');
    let content; try { content = await fs.readFile(full, 'utf8'); } catch { return null; }
    if (!rel.endsWith('.json')) {
      const source = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      if(source.parseDiagnostics.length){
        const first=source.parseDiagnostics[0],position=source.getLineAndCharacterOfPosition(first.start??0);
        inputFailure(new CandidatePackageError('INVALID_TSX',ts.flattenDiagnosticMessageText(first.messageText,' '),{source_file:rel,line:position.line+1,column:position.character+1,source_sha256:sha(content)}));
      }
      const rejectImport=(node,reason)=>{const position=source.getLineAndCharacterOfPosition(node.getStart(source));inputFailure(new CandidatePackageError('PROHIBITED_IMPORT',reason,{source_file:rel,line:position.line+1,column:position.character+1,source_sha256:sha(content)}))};
      const visit = node => {
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) rejectImport(node,'Candidate dynamic imports and require calls are prohibited.');
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const spec = node.moduleSpecifier.text;
          if (spec.startsWith('./') || spec.startsWith('../')) {
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
            if (target.startsWith('..') || path.posix.isAbsolute(target)) rejectImport(node,'Refusing import outside module root.');
            if (target.startsWith('functions/') || ['', '.tsx','.ts','.jsx','.js','.json'].some(ext => functionEntries.has(target + ext))) rejectImport(node,'Candidate function entrypoints may not be compiled or executed.');
          } else if (!['react','@dust/frame','@dust/react-hooks'].includes(spec)) rejectImport(node,'Import outside minimal public proxy surface: ' + spec);
        }
        ts.forEachChild(node, visit);
      }; visit(source);
    }
    sourceHashes[rel] = sha(content); return content;
  } };
}
export async function compileFrame(packageDir) {
  const manifestText = await fs.readFile(path.join(packageDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  if (manifest.version !== 1 || typeof manifest.description !== 'string' || !Array.isArray(manifest.functions) || manifest.functions.length !== 1 || !Array.isArray(manifest.databases ?? []) || (manifest.databases?.length ?? 0) !== 0) throw new Error('Unsupported controlled manifest.');
  const entry = manifest.uiEntryPoint ?? 'index.tsx';
  if (entry.startsWith('/') || entry.includes('\\') || entry.split('/').some(x => !x || x === '.' || x === '..')) throw new Error('Unsafe UI entry path.');
  try {
    if(!(await fs.stat(path.join(packageDir,entry))).isFile())throw new CandidatePackageError('MISSING_ENTRY','Required UI entry is not a regular file',{source_file:entry});
  } catch(error) {
    if(error?.code==='ENOENT'||error?.code==='ENOTDIR')throw new CandidatePackageError('MISSING_ENTRY','Required UI entry file is absent',{source_file:entry});
    throw error;
  }
  for (const fn of manifest.functions) {
    if (fn.name !== 'load-data' || fn.executionMode !== 'fast') throw new Error('Only the deterministic load-data function is supported.');
    if (typeof fn.description !== 'string' || fn.description.length > 255 || typeof fn.entryPoint !== 'string' || fn.entryPoint.startsWith('/') || fn.entryPoint.includes('\\') || fn.entryPoint.split('/').some(x => !x || x === '.' || x === '..')) throw new Error('Invalid controlled function manifest.');
    if (fn.defaultStake !== undefined && !['never_ask','low','high'].includes(fn.defaultStake)) throw new Error('Invalid function stake.');
  }
  const bundleModule = await loadOfficialBundler();
  const reader = await sourceReader(packageDir, new Set((manifest.functions ?? []).map(f => f.entryPoint)));
  const result = await bundleModule({ entryRelPath: entry, reader, esbuild: { format: 'esm', jsx: 'preserve', platform: 'browser', minify: false } });
  // The unmodified official bundler wraps reader exceptions in BundleError.
  // Recover only the guard instance retained out of band, never its error text.
  if(reader.candidateFailure)throw reader.candidateFailure;
  if (result.isErr()) throw result.error;
  const graphCode = result.value.code;
  const allowed = new Set(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@dust/frame', '@dust/react-hooks']);
  const adapter = path.join(ROOT, 'sdk.ts');
  const output = await esbuild.build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {FrameFunctionHooksProvider} from './vendor/viz/app/lib/frame-function-hooks'; import {proxyDataAPI} from './runtime-data'; import App from 'candidate-source'; createRoot(document.getElementById('app')).render(React.createElement(FrameFunctionHooksProvider,{dataAPI:proxyDataAPI},React.createElement(App)));`, resolveDir: ROOT, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', minify: false,
    define:{'process.env.NODE_ENV':'"development"'},
    alias: { '@viz': path.join(ROOT, 'vendor/viz') },
    plugins: [{ name: 'pinned-frame-source', setup(build) {
      build.onResolve({ filter: /^candidate-source$/ }, () => ({ path: 'candidate', namespace: 'candidate' }));
      build.onLoad({ filter: /.*/, namespace: 'candidate' }, () => ({ contents: graphCode, loader: 'tsx', resolveDir: ROOT }));
      build.onResolve({ filter: /.*/, namespace: 'candidate' }, args => {
        if (!allowed.has(args.path)) return { errors: [{ text: `Import outside minimal public proxy surface: ${args.path}` }] };
        if (args.path === '@dust/frame') return { path: path.join(ROOT, 'vendor/viz/components/dust/frame/index.tsx') };
        if (args.path === '@dust/react-hooks') return { path: adapter };
        return build.resolve(args.path, { resolveDir: ROOT, kind: args.kind });
      });
    }}], logLevel: 'silent', metafile: true });
  const code = output.outputFiles[0].text;
  return { code, manifest, evidence: { graph_sha256: sha(graphCode), bundle_sha256: sha(code), esbuild_version: esbuild.version,
    import_surface: [...allowed], original_source_location_tagging: 'NOT_IMPLEMENTED', native_publish: 'UNKNOWN', typecheck: 'NOT_PERFORMED',
    syntax_and_bundle: 'PASS',build_mode:'FIXED_REACT_DEVELOPMENT_NO_ENV_INHERITANCE', source_files_read: reader.sourceHashes, manifest_sha256: sha(manifestText), official_compiler: officialCompilerEvidence, metafile: output.metafile } };
}
