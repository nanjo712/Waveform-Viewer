/**
 * Message protocol types for communication between
 * the VSCode extension host and the webview.
 */

import type {
    SignalDef,
    ScopeNode,
    VcdMetadata,
} from '@waveform-viewer/core';

// ── Host → Webview messages ────────────────────────────────────────

export type HostToWebviewMessage =
    | { type: 'init'; wasmJsUri: string; wasmBinaryUri: string; workerUri: string }
    | { type: 'fileOpened'; fileName: string; fileSize: number }
    | { type: 'fileSliceResponse'; requestId: number; data: ArrayBuffer }
    | { type: 'signalToggle'; index: number }
    | { type: 'signalAdd'; indices: number[] }
    | { type: 'signalRemove'; indices: number[] }
    | { type: 'setSearch'; query: string }
    | { type: 'toggleChisel' };

// ── Webview → Host messages ────────────────────────────────────────

export type WebviewToHostMessage =
    | { type: 'ready' }
    | { type: 'wasmReady' }
    | { type: 'fileSliceRequest'; requestId: number; offset: number; length: number }
    | { type: 'stateUpdate'; state: WebviewStateSnapshot }
    | { type: 'error'; message: string };

// ── Shared state snapshot (webview → host for tree/statusbar) ──────

export interface WebviewStateSnapshot {
    fileLoaded: boolean;
    fileName: string | null;
    metadata: VcdMetadata | null;
    signals: SignalDef[];
    hierarchy: ScopeNode | null;
    selectedSignals: number[];
    unflattenChisel: boolean;
    searchQuery: string;
    viewStart: number;
    viewEnd: number;
    timeBegin: number;
    timeEnd: number;
}
