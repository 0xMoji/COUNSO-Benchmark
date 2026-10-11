// Synthetic controls only. No server/listen, browser, CI, candidate or LLM calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProxySession, validateSchema } from './model.mjs';
import { compileFrame } from './compiler.mjs';
const contract = { source_files: { 'resources.json': { type: 'object' }, 'draft.json': { type: 'object' } }, read_paths: ['./resources.json','./draft.json'], write_paths: ['./draft.json'], function: { input_schema: { type: 'object', properties: {}, additionalProperties: false } } };
const session = () => new ProxySession({ kind: 'planner', files: { 'resources.json': { content: '{"synthetic":true}', revision: '1', canWrite: false }, 'draft.json': { content: '{"synthetic":true}', revision: '1', canWrite: true } }, contract });
let requestId = 0;
const request = (s, command, params) => s.rpc({ identifier: s.id, messageUniqueId: String(++requestId), command, params });
const waitPending = async s => { for (let i = 0; i < 100; i++) { if (s.pending.size) return [...s.pending.keys()][0]; await new Promise(r => setImmediate(r)); } throw new Error('No pending request'); };
test('read metadata, opaque actual write and conflict are observed', async () => {
  const s = session(); const first = await request(s,'getFile',{fileId:'./draft.json'});
  assert.equal(first.result.revision,'1'); assert.equal(first.result.canWrite,true);
  const write = await request(s,'writeFile',{path:'./draft.json',content:'intentionally not JSON',revision:'1'});
  assert.deepEqual(write.result,{success:true,revision:'2'}); assert.equal(s.files.get('draft.json').content,'intentionally not JSON');
  const stale = await request(s,'writeFile',{path:'./draft.json',content:'wrong overwrite',revision:'1'});
  assert.equal(stale.result.error.code,'conflict'); assert.equal(s.files.get('draft.json').content,'intentionally not JSON');
  assert.equal(s.events.filter(x=>x.type==='FILE_COMMITTED').length,1);
});
test('read-only, path escapes and missing revisions cause zero commits', async () => {
  const s = session(); await s.control({op:'setReadOnly',readOnly:true});
  assert.equal((await request(s,'writeFile',{path:'./draft.json',content:'x',revision:'1'})).result.error.code,'read_only');
  await s.control({op:'setReadOnly',readOnly:false});
  assert.equal((await request(s,'writeFile',{path:'../draft.json',content:'x',revision:'1'})).result.error.code,'invalid_path');
  assert.equal((await request(s,'writeFile',{path:'./draft.json',content:'x'})).result.error.code,'save_failed');
  assert.equal(s.events.filter(x=>x.type==='FILE_COMMITTED').length,0);
});
test('functions are name-bound deterministic data, not candidate function code', async () => {
  const s = session(); assert.deepEqual((await request(s,'callFunction',{functionIdOrSlug:'load-data',input:{}})).result,{synthetic:true});
  assert.equal((await request(s,'callFunction',{functionIdOrSlug:'another-frame/load-data',input:{}})).error.code,'invalid_function_reference');
  assert.equal((await request(s,'callFunction',{functionIdOrSlug:'load-data',input:{undeclared:true}})).error.code,'invalid_input');
});
test('held old error is released explicitly without consuming another request fault', async () => {
  const s=session();await s.control({op:'setFault',command:'callFunction',effect:'hold',phase:'before_process'});
  const pending=request(s,'callFunction',{functionIdOrSlug:'load-data',input:{}}),id=await waitPending(s);
  await s.control({op:'release',pendingId:id,outcome:'function_fail'});assert.equal((await pending).error.code,'controlled_function_failure');
  assert.equal(s.events.filter(x=>x.type==='DETERMINISTIC_FUNCTION').length,0);
});
test('late acknowledgement keeps exact actual prior commit revision', async () => {
  const s=session();await s.control({op:'setFault',command:'writeFile',effect:'hold',phase:'after_process'});
  const pending=request(s,'writeFile',{path:'./draft.json',revision:'1',content:'{"saved":"A"}'}),id=await waitPending(s);
  assert.equal(s.files.get('draft.json').revision,'2');
  await s.control({op:'replaceFiles',files:{'draft.json':{saved:'later-authority'}}});
  await s.control({op:'release',pendingId:id}); assert.equal((await pending).result.revision,'2'); assert.equal(s.files.get('draft.json').revision,'3');
});
test('same-schema control validates all supported numeric constraints',()=>{
  assert.ok(validateSchema(16,{type:'integer',multipleOf:15}).length); assert.equal(validateSchema(30,{type:'integer',multipleOf:15}).length,0);
  assert.throws(()=>validateSchema('x',{type:'string',unrecognizedConstraint:true}),/Unsupported frozen schema/);
});
test('official graph compiler accepts only the permitted UI closure',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'counso-offline-controls-'));
  await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify({version:1,description:'Independent synthetic compiler control',functions:[{name:'load-data',description:'Deterministic source only',executionMode:'fast',entryPoint:'functions/load-data.ts'}],databases:[]}));
  const set=source=>fs.writeFile(path.join(dir,'index.tsx'),source);
  await set(`import React from 'react';import {FrameRoot} from '@dust/frame';import {useFrameFunction} from '@dust/react-hooks';export default function App(){useFrameFunction(null,{});return <FrameRoot>synthetic control</FrameRoot>}`);
  const compiled=await compileFrame(dir);assert.match(compiled.evidence.bundle_sha256,/^[a-f0-9]{64}$/);assert.deepEqual(Object.keys(compiled.evidence.source_files_read),['index.tsx']);
  await set(`import x from 'next';export default ()=>null`);await assert.rejects(compileFrame(dir),/outside minimal public proxy surface/);
  await set(`export default ()=>{import('react');return null}`);await assert.rejects(compileFrame(dir),/dynamic imports/);
  await fs.mkdir(path.join(dir,'functions'));await fs.writeFile(path.join(dir,'functions/load-data.ts'),'throw new Error("MUST NEVER READ OR EXECUTE")');
  await set(`import x from './functions/load-data';export default ()=>null`);await assert.rejects(compileFrame(dir),/function entrypoints/);
  await set(`import x from '../outside';export default ()=>null`);await assert.rejects(compileFrame(dir),/outside module root/);
});
