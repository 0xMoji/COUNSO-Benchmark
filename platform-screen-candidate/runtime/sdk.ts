// Coordinator-owned binding adapter. The imported RPC class and function hooks
// are unmodified pinned Dust sources; this file is not an official Dust module.
import { proxyDataAPI, sendMessage } from './runtime-data';
import { useEffect, useState } from 'react';
export { SandboxFunctionCallError } from './vendor/viz/app/lib/data-apis/sandbox-function-call-error';
export {
  useFrameFunction, useFrameFunctionMutation, useUserIdentity,
  useFrameFunction as usePodFunction,
  useFrameFunctionMutation as usePodFunctionMutation,
} from './vendor/viz/app/lib/frame-function-hooks';
import type { WriteFileParams } from './vendor/viz/app/types';

export const callFunction = (functionId: string, input?: unknown) => proxyDataAPI.callFunction(functionId, input);
export const readFile = (path: string) => proxyDataAPI.fetchFile(path);
export const writeFile = (path: string, content: string, options: Pick<WriteFileParams, 'revision' | 'contentType'>) => proxyDataAPI.writeFile({ ...options, path, content });
// The read-only File hook below is a declared proxy implementation. Only its
// public File|null signature comes from Dust's runtime-import binding.
export function useFile(path: string): File | null {
  const [file, setFile] = useState<File | null>(null);
  useEffect(() => { let active = true; setFile(null); readFile(path).then(r => { if (active) setFile(r?.file ?? null); }); return () => { active = false; }; }, [path]);
  return file;
}
export async function triggerUserFileDownload({ content, filename }: { content: string | Blob; filename?: string }): Promise<void> {
  if (!navigator.userActivation.isActive) throw new Error('Downloads require an actual user-triggered action.');
  await sendMessage('downloadFileRequest', { blob: content instanceof Blob ? content : new Blob([content]), filename });
}
export async function captureScreenshot(_name?: string): Promise<void> {
  throw new Error('SDK captureScreenshot is unsupported by this minimal controlled proxy; trusted browser capture is separate.');
}
