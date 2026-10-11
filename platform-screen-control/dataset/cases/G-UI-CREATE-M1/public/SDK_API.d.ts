/**
 * Public SDK surface for the Frames-contract-aligned controlled proxy.
 * Upstream pin: dust-tt/dust 6b83eac6e43597cb154e892f2fc4bd9165f512c1.
 * The default React component is already inside the host function provider.
 * FrameRoot is optional presentation; do not recreate a function provider.
 * This declaration contains interface types, not task answers or app logic.
 */
declare module '@dust/frame' {
  import type { CSSProperties, HTMLAttributes, ReactNode, ReactElement } from 'react';
  export type FrameTheme = Partial<Record<`--${string}`, string | number>>;
  export interface FrameRootProps extends Omit<HTMLAttributes<HTMLDivElement>, 'style'> {
    children: ReactNode;
    theme?: FrameTheme;
    style?: CSSProperties & FrameTheme;
  }
  export const FrameRoot: (props: FrameRootProps) => ReactElement;
}

declare module '@dust/react-hooks' {
  import type { KeyedMutator } from 'swr';
  export interface FrameFile {
    file: File;
    revision: string | null;
    canWrite: boolean;
  }
  export type WriteFileErrorCode = 'read_only' | 'invalid_path' | 'conflict' | 'save_failed';
  export type WriteFileResult =
    | { success: true; revision: string }
    | { success: false; error: { code: WriteFileErrorCode; message: string } };
  export interface WriteFileOptions { revision: string; contentType?: string; }
  /** Package-relative paths, e.g. ./resources.json. null has no specific cause. */
  export function readFile(path: string): Promise<FrameFile | null>;
  /** Existing permitted file only; use the read revision, never construct one. */
  export function writeFile(path: string, content: string, options: WriteFileOptions): Promise<WriteFileResult>;
  /** Read-only proxy hook. It returns File|null, not FrameFile metadata. */
  export function useFile(path: string): File | null;
  /** Bare name declared by this package. The result must be validated as task data. */
  export function callFunction(name: string, input?: unknown): Promise<unknown>;
  export interface UseFrameFunctionResult {
    data: unknown;
    error: Error | undefined;
    isLoading: boolean;
    isValidating: boolean;
    mutate: KeyedMutator<unknown>;
  }
  /** input is required; name=null disables the query. Provider is already installed. */
  export function useFrameFunction(name: string | null, input: unknown): UseFrameFunctionResult;
  export interface UseFrameFunctionMutationResult {
    data: unknown;
    error: Error | undefined;
    isMutating: boolean;
    /** Official compatibility alias of isMutating. */
    isLoading: boolean;
    reset: () => void;
    trigger: (input: unknown) => Promise<unknown>;
  }
  /** name=null disables the mutation; trigger then rejects. */
  export function useFrameFunctionMutation(name: string | null): UseFrameFunctionMutationResult;
  export class SandboxFunctionCallError extends Error {
    readonly code: string;
    readonly status?: number;
    constructor(payload: { code: string; message: string; status?: number });
  }
  /** Proxy-supported local download, requiring an actual user-triggered action. */
  export function triggerUserFileDownload(options: { content: string | Blob; filename?: string }): Promise<void>;
}
