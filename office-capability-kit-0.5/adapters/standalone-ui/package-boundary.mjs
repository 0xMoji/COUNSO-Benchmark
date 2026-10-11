import {lstat,realpath,readdir,readFile} from 'node:fs/promises';
import {resolve,dirname,join,posix} from 'node:path';
import {createHash} from 'node:crypto';
const digest=x=>createHash('sha256').update(x).digest('hex');
export function safeAsset(asset){
 if(typeof asset!=='string'||!asset.startsWith('/')||asset.startsWith('//')||asset.includes('\\')||asset.includes('%')||asset.includes('?')||asset.includes('#')||asset.includes(':')||!/^\/[A-Za-z0-9_./-]+$/.test(asset)||posix.normalize(asset)!==asset||asset.slice(1).split('/').some(x=>x==='.'||x==='..'||x===''))throw new Error('Invalid declared static asset path');
 return asset;
}
export async function noSymlinks(path){
 let current=resolve(path);while(true){const st=await lstat(current);if(st.isSymbolicLink())throw new Error('Symlink files and parent directories are not accepted in a frozen package');const parent=dirname(current);if(parent===current)break;current=parent;}
 return realpath(path);
}
export async function frozenPackage(directory){
 const root=await noSymlinks(directory);if(!(await lstat(root)).isDirectory())throw new Error('Static package root must be a directory');const files=[];
 async function walk(dir){for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(dir,entry.name),actual=await noSymlinks(path);if(actual!==root&&!actual.startsWith(root+'/'))throw new Error('Static package escape');if(entry.isDirectory())await walk(path);else if(entry.isFile()){const asset=safeAsset('/'+path.slice(root.length+1));const bytes=await readFile(actual);files.push({path:asset.slice(1),sha256:digest(bytes),bytes:bytes.length});}else throw new Error('Static package must contain ordinary files/directories only');}}
 await walk(root);return {root,files,digest:digest(JSON.stringify(files))};
}
export async function verifiedAsset(root,asset){
 safeAsset(asset);const path=resolve(root,asset.slice(1));if(!path.startsWith(root+'/'))throw new Error('Static path escape');const actual=await noSymlinks(path);if(actual!==path||!actual.startsWith(root+'/'))throw new Error('Static path changed or escaped frozen root');if(!(await lstat(actual)).isFile())throw new Error('Declared asset is not a file');return actual;
}
