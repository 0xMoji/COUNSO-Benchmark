// Coordinator-owned transport binding; candidate SDK namespace does not export this object.
import { RPCDataAPI } from './vendor/viz/app/lib/data-apis/rpc-data-api';
import type { VisualizationRPCCommand, VisualizationRPCRequestMap, CommandResultMap } from './vendor/viz/app/types';
declare global { interface Window { __FRAME_PROXY_IDENTIFIER__: string; } }
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.data?.command !== 'answer' || event.data?.identifier !== window.__FRAME_PROXY_IDENTIFIER__) return;
  const item = pending.get(event.data.messageUniqueId);
  if (!item) return;
  pending.delete(event.data.messageUniqueId);
  if (event.data.error) item.reject(event.data.error); else item.resolve(event.data.result);
});
export const sendMessage = <T extends VisualizationRPCCommand>(command: T, params: VisualizationRPCRequestMap[T]): Promise<CommandResultMap[T]> => {
  const messageUniqueId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(messageUniqueId, { resolve, reject });
    window.parent.postMessage({ identifier: window.__FRAME_PROXY_IDENTIFIER__, messageUniqueId, command, params }, '*');
  });
};
export const proxyDataAPI = new RPCDataAPI(sendMessage);
