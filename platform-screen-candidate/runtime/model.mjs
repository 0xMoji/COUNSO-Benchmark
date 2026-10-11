import fs from 'node:fs';
import path from 'node:path';
import { canonicalPackageTarget } from './package-path.mjs';
import { createHash, randomUUID } from 'node:crypto';
const copy = x => structuredClone(x);
const sha = x => createHash('sha256').update(x).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
export function validateSchema(value, schema, at = '$') {
  const errors = [];
  const bad = m => errors.push(`${at}: ${m}`);
  const supported = new Set(['type','required','additionalProperties','properties','const','enum','items','uniqueItems','minLength','format','minimum','multipleOf']);
  for (const key of Object.keys(schema)) if (!supported.has(key)) throw new Error('Unsupported frozen schema keyword: ' + key);
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) bad('const mismatch');
  if (schema.enum && !schema.enum.some(x => JSON.stringify(value) === JSON.stringify(x))) bad('enum mismatch');
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (schema.type && (schema.type === 'integer' ? !Number.isInteger(value) : type !== schema.type)) return [...errors, `${at}: type mismatch`];
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) bad(`missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...validateSchema(item, schema.properties[key], `${at}.${key}`));
      else if (schema.additionalProperties === false) bad(`unexpected ${key}`);
    }
  }
  if (type === 'array') {
    if (schema.uniqueItems && new Set(value.map(x => JSON.stringify(x))).size !== value.length) bad('duplicate items');
    if (schema.items) value.forEach((item, i) => errors.push(...validateSchema(item, schema.items, `${at}[${i}]`)));
  }
  if (type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) bad('too short');
    if (schema.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) bad('invalid date');
    if (schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))) bad('invalid date-time');
  }
  if (type === 'number' && schema.minimum !== undefined && value < schema.minimum) bad('below minimum');
  if (type === 'number' && schema.multipleOf !== undefined && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) bad('not a declared multiple');
  return errors;
}
export class ProxySession {
  constructor({ kind, files, contract, artifactDir }) {
    this.id = randomUUID(); this.kind = kind; this.contract = contract; this.root = `controlled-${this.id}/frame`;
    this.files = new Map(); this.events = []; this.faults = []; this.pending = new Map(); this.requests = new Map();
    this.canWrite = true; this.artifactDir = artifactDir; this.prevHash = '0'.repeat(64);
    if (artifactDir) fs.mkdirSync(artifactDir, { recursive: true });
    for (const [p, entry] of Object.entries(files)) {
      const key = this.relative(p); if (!key) throw new Error('Invalid fixture path');
      const content = typeof entry === 'string' ? entry : (entry.content ?? JSON.stringify(entry.value));
      const revision = typeof entry === 'object' ? (entry.revision ?? '1') : '1';
      if (!/^[1-9][0-9]*$/.test(revision)) throw new Error('Invalid initial revision');
      const contentType = typeof entry === 'object' ? (entry.contentType ?? 'application/json') : 'application/json';
      const canWrite = typeof entry === 'object' ? entry.canWrite !== false : true;
      this.files.set(key, { content, contentType, revision, canWrite });
    }
    this.log('SESSION_CREATED', { kind, package_root: this.root, file_hashes: this.fileHashes(), native_platform: 'UNKNOWN', implementation: 'CONTROLLED_PROXY' });
  }
  relative(p) { return canonicalPackageTarget(this.root, p)?.relative ?? null; }
  fileHashes() { return Object.fromEntries([...this.files].map(([p, f]) => [p, { sha256: sha(f.content), revision: f.revision, canWrite: f.canWrite }])); }
  log(type, data = {}) {
    const event = { seq: this.events.length, observed_utc: new Date().toISOString(), observed_monotonic_ms: performance.now(), type, ...copy(data), previous_hash: this.prevHash };
    event.sha256 = sha(JSON.stringify(event)); this.prevHash = event.sha256; this.events.push(event);
    if (this.artifactDir) fs.appendFileSync(path.join(this.artifactDir, 'events.jsonl'), JSON.stringify(event) + '\n');
    return event;
  }
  snapshot() { return { sessionId: this.id, kind: this.kind, packageRoot: this.root, canWrite: this.canWrite,
    files: Object.fromEntries([...this.files].map(([p, f]) => [p, copy(f)])), pending: [...this.pending.keys()], ledgerHead: this.prevHash }; }
  async control(action) {
    const { op } = action;
    if (op === 'setReadOnly') { if (typeof action.readOnly !== 'boolean') throw new Error('readOnly must be boolean'); this.canWrite = !action.readOnly; }
    else if (op === 'replaceFiles') {
      const replacements = [];
      for (const [p, item] of Object.entries(action.files)) {
        const key = this.relative(p); if (!key || !Object.hasOwn(this.contract.source_files, key)) throw new Error('Fixture path outside declared package');
        const content = typeof item === 'string' ? item : JSON.stringify(item);
        const value = JSON.parse(content); const errs = validateSchema(value, this.contract.source_files[key]);
        if (errs.length) throw new Error(errs.join('; '));
        const old = this.files.get(key); if (!old) throw new Error('Replacement requires existing file');
        replacements.push([key, { ...old, content, revision: (BigInt(old.revision) + 1n).toString() }]);
      }
      for (const [key, item] of replacements) this.files.set(key, item);
    } else if (op === 'setFileCapability') {
      const f = this.files.get(this.relative(action.path)); if (!f || typeof action.canWrite !== 'boolean') throw new Error('Unknown file or invalid capability'); f.canWrite = action.canWrite;
    } else if (op === 'setFault') {
      if (!({ getFile: ['delay','hold','read_fail'], writeFile: ['delay','hold','read_only','conflict','save_failed'], callFunction: ['delay','hold','function_fail'] }[action.command] ?? []).includes(action.effect)) throw new Error('Unsupported fault');
      if (action.phase && !['before_process', 'after_process'].includes(action.phase)) throw new Error('Invalid fault phase');
      if (['read_only','conflict'].includes(action.effect) && action.phase === 'after_process') throw new Error('Permission/conflict refusal must occur before a file commit');
      const count = action.count ?? 1; if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Invalid fault count');
      if (action.delay_ms !== undefined && (!Number.isInteger(action.delay_ms) || action.delay_ms < 0 || action.delay_ms > 900000)) throw new Error('Invalid fault delay');
      if (action.path !== undefined) {
        const key = this.relative(action.path), paths = action.command === 'getFile' ? this.contract.read_paths : action.command === 'writeFile' ? this.contract.write_paths : [];
        if (!key || !this.files.has(key) || !Object.hasOwn(this.contract.source_files, key) || !paths.includes('./' + key)) throw new Error('Fault path outside declared existing package target');
      }
      this.faults.push({ ...copy(action), count, faultId: randomUUID(), phase: action.phase ?? (['delay', 'hold'].includes(action.effect) ? 'after_process' : 'before_process') });
    } else if (op === 'release') {
      const p = this.pending.get(action.pendingId); if (!p) throw new Error('Unknown pending call');
      if (action.outcome && !({ callFunction: ['function_fail'], getFile: ['read_fail'], writeFile: ['save_failed'] }[p.command] ?? []).includes(action.outcome)) throw new Error('Invalid held response outcome');
      this.pending.delete(action.pendingId); p.resolve(action.outcome ?? null);
    } else if (op === 'clearFaults') this.faults = [];
    else throw new Error('Unknown control');
    this.log('TRUSTED_CONTROL', { action, file_hashes: this.fileHashes(), canWrite: this.canWrite });
    return this.snapshot();
  }
  async rpc(request) {
    if (typeof request.messageUniqueId !== 'string' || request.messageUniqueId.length > 128) return { error: { code: 'invalid_request', message: 'Invalid message identity.' } };
    if (this.requests.has(request.messageUniqueId)) { this.log('RPC_DUPLICATE', { messageUniqueId: request.messageUniqueId }); return this.requests.get(request.messageUniqueId); }
    const result = this.process(request); this.requests.set(request.messageUniqueId, result); return result;
  }
  async process(request) {
    const { command, params, messageUniqueId } = request;
    const requestSeq = this.log('RPC_ACCEPTED', { command, params, messageUniqueId }).seq;
    const requestTarget = command === 'writeFile' ? this.relative(params?.path) : command === 'getFile' ? this.relative(params?.fileId) : null;
    const declaredTarget = requestTarget && this.files.has(requestTarget) && Object.hasOwn(this.contract.source_files, requestTarget)
      && (command === 'writeFile' ? this.contract.write_paths : this.contract.read_paths).includes('./' + requestTarget);
    const fault = this.faults.find(f => f.count > 0 && f.command === command
      && ((command === 'getFile' || command === 'writeFile')
        ? declaredTarget && (f.path === undefined || this.relative(f.path) === requestTarget) : f.path === undefined));
    if (fault) { fault.count--; this.log('FAULT_MATCHED', { requestSeq, faultId: fault.faultId, effect: fault.effect, phase: fault.phase }); }
    let releaseOutcome = null;
    const wait = async () => {
      if (fault?.effect === 'delay') await sleep(fault.delay_ms ?? 250);
      if (fault?.effect === 'hold') {
        const pendingId = randomUUID(); this.log('RESPONSE_HELD', { requestSeq, pendingId, phase: fault.phase });
        releaseOutcome = await new Promise(resolve => this.pending.set(pendingId, { resolve, requestSeq, command }));
        this.log('RESPONSE_RELEASED', { requestSeq, pendingId, outcome: releaseOutcome });
      }
    };
    if (fault?.phase === 'before_process') await wait();
    let answer;
    try {
      const forced = fault && !['delay', 'hold'].includes(fault.effect) && fault.phase === 'before_process';
      answer = releaseOutcome ? this.faultResult(releaseOutcome, command) : forced ? this.faultResult(fault.effect, command) : this.execute(command, params, requestSeq);
      if (fault?.phase === 'after_process') { await wait(); if (!['delay', 'hold'].includes(fault.effect)) answer = this.faultResult(fault.effect, command); }
      if (releaseOutcome) answer = this.faultResult(releaseOutcome, command);
    } catch (error) { answer = { error: { code: 'controlled_source_error', message: error.message } }; }
    this.log('RPC_RESULT', { requestSeq, command, messageUniqueId, answer, file_hashes: this.fileHashes() });
    return answer;
  }
  faultResult(effect, command) {
    if (effect === 'read_fail' && command === 'getFile') return { result: { fileBlob: null } };
    if (['read_only', 'conflict', 'save_failed'].includes(effect) && command === 'writeFile') return { result: { success: false, error: { code: effect, message: `Controlled ${effect} refusal.` } } };
    return { error: { code: 'controlled_function_failure', message: 'Controlled source failure.' } };
  }
  execute(command, params, requestSeq) {
    if (command === 'getFile') {
      const key = this.relative(params?.fileId); const f = key && this.files.get(key);
      if (!f || !this.contract.read_paths.includes('./' + key)) return { result: { fileBlob: null } };
      return { result: { fileContent: f.content, contentType: f.contentType, revision: f.revision,
        canWrite: this.canWrite && f.canWrite && this.contract.write_paths.includes('./' + key) } };
    }
    if (command === 'writeFile') {
      const refusal = (code, message) => ({ result: { success: false, error: { code, message } } });
      if (!this.canWrite) return refusal('read_only', 'This Frame is read-only.');
      const key = this.relative(params?.path), f = key && this.files.get(key);
      if (!key || !f || !this.contract.write_paths.includes('./' + key)) return refusal('invalid_path', "Choose a file inside this Frame's folder.");
      if (!f.canWrite) return refusal('read_only', 'You cannot edit this file.');
      if (typeof params?.revision !== 'string' || !/^[1-9][0-9]*$/.test(params.revision) || typeof params.content !== 'string') return refusal('save_failed', 'Invalid write payload; no save was performed.');
      if (params.revision !== f.revision) return refusal('conflict', 'This file changed since it was loaded. Reload it before saving.');
      // The official file API writes an opaque string. Do not silently protect
      // a candidate's invalid business draft with evaluator/schema enforcement.
      const beforeRevision = f.revision; f.content = params.content; f.contentType = params.contentType ?? 'text/plain'; f.revision = (BigInt(f.revision) + 1n).toString();
      this.log('FILE_COMMITTED', { requestSeq, path: key, beforeRevision, revision: f.revision, content_sha256: sha(f.content), content: f.content });
      if (this.artifactDir) fs.writeFileSync(path.join(this.artifactDir, 'persisted-draft.json'), f.content);
      return { result: { success: true, revision: f.revision } };
    }
    if (command === 'callFunction') {
      if (params?.functionIdOrSlug !== 'load-data') return { error: { code: 'invalid_function_reference', message: 'Expected a bare function name declared by this Frame.' } };
      const errors = validateSchema(params.input, this.contract.function.input_schema);
      if (errors.length) return { error: { code: 'invalid_input', message: errors.join('; ') } };
      const file = this.files.get(this.kind === 'dashboard' ? 'dataset.json' : 'resources.json');
      const snapshot = JSON.parse(file.content);
      const result = this.kind === 'dashboard' ? { snapshot, scope: copy(params.input) } : snapshot;
      this.log('DETERMINISTIC_FUNCTION', { requestSeq, bound_function: this.id + '/load-data', input: params.input, output_sha256: sha(JSON.stringify(result)), external_calls: 0, llm_calls: 0 });
      return { result };
    }
    if (command === 'getUserIdentity') return { result: { isAuthenticated: false, isWorkspaceMember: false, isFrameAuthor: false, isPodEditor: false, isPodMember: false, user: null } };
    if (command === 'setContentHeight') return { result: null };
    if (command === 'downloadFileRequest') {
      const filename = path.basename(params?.filename ?? 'download.txt');
      if (!params || typeof params.contentBase64 !== 'string') throw new Error('Invalid download payload');
      const bytes = Buffer.from(params.contentBase64, 'base64');
      this.log('DOWNLOAD_CAPTURED', { requestSeq, filename, sha256: sha(bytes), bytes: bytes.length });
      if (this.artifactDir) { const dir = path.join(this.artifactDir, 'downloads'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${requestSeq}-${filename}`), bytes); }
      return { result: { filename } };
    }
    return { error: { code: 'unsupported_command', message: 'Command outside the minimal controlled proxy surface.' } };
  }
}
