/**
 * Pure state reducer for the Waveform Viewer application.
 *
 * This module has ZERO React or DOM dependencies — it defines only
 * the state shape, action types, and a pure reducer function.
 * React-specific wiring (Context, Provider, hooks) lives in @waveform-viewer/react-ui.
 */
import type { SignalDef, ScopeNode, WaveformMetadata, QueryResult } from '../types/waveform.ts';
import type { FormatPlugin } from '../types/plugin.ts';
export interface AppState {
    /** WASM module loading status */
    wasmStatus: 'loading' | 'ready' | 'error';
    wasmError: string | null;
    /** Parsed VCD file data */
    fileLoaded: boolean;
    fileName: string | null;
    metadata: WaveformMetadata | null;
    signals: SignalDef[];
    hierarchy: ScopeNode | null;
    /** Selected signal indices to display in the waveform view */
    selectedSignals: number[];
    /** Indices of signals currently visible in the virtual scroll window */
    visibleRowIndices: number[];
    /** Viewport: the time range currently visible */
    viewStart: number;
    viewEnd: number;
    /** Full time range of the loaded file */
    timeBegin: number;
    timeEnd: number;
    /** Waveform query result for the current view */
    queryResult: QueryResult | null;
    /** Search filter for signal names */
    searchQuery: string;
    /** Sidebar collapsed state */
    sidebarCollapsed: boolean;
    /** Unflatten Chisel Signals mode */
    unflattenChisel: boolean;
    /** Custom format overrides per signal index */
    signalFormats: Record<number, string>;
    /** Dynamically loaded viewer format plugins */
    formatPlugins: FormatPlugin[];
    /** The signal currently active for setting UI properties (like format) */
    activeSignalIndex: number | null;
}
export declare const initialState: AppState;
export type Action = {
    type: 'WASM_READY';
} | {
    type: 'WASM_ERROR';
    error: string;
} | {
    type: 'FILE_LOADED';
    metadata: WaveformMetadata;
    signals: SignalDef[];
    hierarchy: ScopeNode;
    fileName: string;
} | {
    type: 'FILE_CLOSED';
} | {
    type: 'TOGGLE_SIGNAL';
    index: number;
} | {
    type: 'ADD_SIGNALS';
    indices: number[];
} | {
    type: 'REMOVE_SIGNALS';
    indices: number[];
} | {
    type: 'SELECT_SIGNALS';
    indices: number[];
} | {
    type: 'SET_VISIBLE_ROWS';
    indices: number[];
} | {
    type: 'REMOVE_SIGNAL';
    index: number;
} | {
    type: 'SET_VIEW';
    start: number;
    end: number;
} | {
    type: 'SET_QUERY_RESULT';
    result: QueryResult;
} | {
    type: 'SET_SEARCH';
    query: string;
} | {
    type: 'TOGGLE_SIDEBAR';
} | {
    type: 'TOGGLE_UNFLATTEN_CHISEL';
} | {
    type: 'MOVE_SIGNAL';
    fromIdx: number;
    toIdx: number;
} | {
    type: 'SET_SIGNAL_FORMAT';
    index: number;
    format: string;
} | {
    type: 'REGISTER_PLUGIN';
    plugin: FormatPlugin;
} | {
    type: 'SET_ACTIVE_SIGNAL';
    index: number | null;
};
export declare function appReducer(state: AppState, action: Action): AppState;
