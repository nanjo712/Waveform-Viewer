/**
 * Pure state reducer for the Waveform Viewer application.
 *
 * This module has ZERO React or DOM dependencies — it defines only
 * the state shape, action types, and a pure reducer function.
 * React-specific wiring (Context, Provider, hooks) lives in @waveform-viewer/react-ui.
 */

import type {
    SignalDef,
    ScopeNode,
    VcdMetadata,
    QueryResult,
} from '../types/vcd.ts';
import type { FormatPlugin } from '../types/plugin.ts';
import { coreRadixPlugin } from '../plugins/coreRadixPlugin.ts';
import { coreFloatPlugin } from '../plugins/coreFloatPlugin.ts';

// ── State ──────────────────────────────────────────────────────────────

export interface AppState {
    /** WASM module loading status */
    wasmStatus: 'loading' | 'ready' | 'error';
    wasmError: string | null;

    /** Parsed VCD file data */
    fileLoaded: boolean;
    fileName: string | null;
    metadata: VcdMetadata | null;
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

export const initialState: AppState = {
    wasmStatus: 'loading',
    wasmError: null,
    fileLoaded: false,
    fileName: null,
    metadata: null,
    signals: [],
    hierarchy: null,
    selectedSignals: [],
    visibleRowIndices: [],
    viewStart: 0,
    viewEnd: 100,
    timeBegin: 0,
    timeEnd: 100,
    queryResult: null,
    searchQuery: '',
    sidebarCollapsed: false,
    unflattenChisel: false,
    signalFormats: {},
    formatPlugins: [coreRadixPlugin, coreFloatPlugin],
    activeSignalIndex: null,
};

// ── Actions ────────────────────────────────────────────────────────────

export type Action =
    | { type: 'WASM_READY' }
    | { type: 'WASM_ERROR'; error: string }
    | {
        type: 'FILE_LOADED';
        metadata: VcdMetadata;
        signals: SignalDef[];
        hierarchy: ScopeNode;
        fileName: string;
    }
    | { type: 'FILE_CLOSED' }
    | { type: 'TOGGLE_SIGNAL'; index: number }
    | { type: 'ADD_SIGNALS'; indices: number[] }
    | { type: 'REMOVE_SIGNALS'; indices: number[] }
    | { type: 'SELECT_SIGNALS'; indices: number[] }
    | { type: 'SET_VISIBLE_ROWS'; indices: number[] }
    | { type: 'REMOVE_SIGNAL'; index: number }
    | { type: 'SET_VIEW'; start: number; end: number }
    | { type: 'SET_QUERY_RESULT'; result: QueryResult }
    | { type: 'SET_SEARCH'; query: string }
    | { type: 'TOGGLE_SIDEBAR' }
    | { type: 'TOGGLE_UNFLATTEN_CHISEL' }
    | { type: 'MOVE_SIGNAL'; fromIdx: number; toIdx: number }
    | { type: 'SET_SIGNAL_FORMAT'; index: number; format: string }
    | { type: 'REGISTER_PLUGIN'; plugin: FormatPlugin }
    | { type: 'SET_ACTIVE_SIGNAL'; index: number | null };

// ── Reducer ────────────────────────────────────────────────────────────

export function appReducer(state: AppState, action: Action): AppState {
    switch (action.type) {
        case 'WASM_READY':
            return { ...state, wasmStatus: 'ready' };

        case 'WASM_ERROR':
            return { ...state, wasmStatus: 'error', wasmError: action.error };

        case 'FILE_LOADED': {
            const tBegin = action.metadata.timeBegin;
            const tEnd = action.metadata.timeEnd;
            // Default view: show only the last 100 timescale units
            const DEFAULT_VIEW_RANGE = 100;
            const totalRange = tEnd - tBegin;
            const viewStart = totalRange > DEFAULT_VIEW_RANGE
                ? tEnd - DEFAULT_VIEW_RANGE
                : tBegin;
            return {
                ...state,
                fileLoaded: true,
                fileName: action.fileName,
                metadata: action.metadata,
                signals: action.signals,
                hierarchy: action.hierarchy,
                selectedSignals: [],
                visibleRowIndices: [],
                viewStart,
                viewEnd: tEnd,
                timeBegin: tBegin,
                timeEnd: tEnd,
                queryResult: null,
            };
        }

        case 'FILE_CLOSED':
            return {
                ...initialState,
                wasmStatus: state.wasmStatus,
                wasmError: state.wasmError,
            };

        case 'TOGGLE_SIGNAL': {
            const idx = action.index;
            const sel = state.selectedSignals;
            const newSel = sel.includes(idx)
                ? sel.filter((i) => i !== idx)
                : [...sel, idx];
            return { ...state, selectedSignals: newSel };
        }

        case 'ADD_SIGNALS': {
            const currentSel = new Set(state.selectedSignals);
            action.indices.forEach((idx) => currentSel.add(idx));
            return { ...state, selectedSignals: Array.from(currentSel) };
        }

        case 'REMOVE_SIGNALS': {
            const toRemove = new Set(action.indices);
            return {
                ...state,
                selectedSignals: state.selectedSignals.filter((idx) => !toRemove.has(idx)),
            };
        }

        case 'SELECT_SIGNALS':
            return { ...state, selectedSignals: action.indices };

        case 'SET_VISIBLE_ROWS': {
            if (
                state.visibleRowIndices.length === action.indices.length &&
                state.visibleRowIndices.every((val, i) => val === action.indices[i])
            ) {
                return state;
            }
            return { ...state, visibleRowIndices: action.indices };
        }

        case 'REMOVE_SIGNAL':
            return {
                ...state,
                selectedSignals: state.selectedSignals.filter(
                    (i) => i !== action.index
                ),
            };

        case 'SET_VIEW':
            return { ...state, viewStart: action.start, viewEnd: action.end };

        case 'SET_QUERY_RESULT':
            return { ...state, queryResult: action.result };

        case 'SET_SEARCH':
            return { ...state, searchQuery: action.query };

        case 'TOGGLE_SIDEBAR':
            return { ...state, sidebarCollapsed: !state.sidebarCollapsed };

        case 'TOGGLE_UNFLATTEN_CHISEL':
            return { ...state, unflattenChisel: !state.unflattenChisel };

        case 'MOVE_SIGNAL': {
            const arr = [...state.selectedSignals];
            const [item] = arr.splice(action.fromIdx, 1);
            arr.splice(action.toIdx, 0, item);
            return { ...state, selectedSignals: arr };
        }

        case 'SET_SIGNAL_FORMAT':
            return {
                ...state,
                signalFormats: {
                    ...state.signalFormats,
                    [action.index]: action.format,
                },
            };

        case 'REGISTER_PLUGIN':
            // Prevent duplicate registering
            if (state.formatPlugins.some(p => p.id === action.plugin.id)) {
                return state;
            }
            return { ...state, formatPlugins: [...state.formatPlugins, action.plugin] };

        case 'SET_ACTIVE_SIGNAL':
            return { ...state, activeSignalIndex: action.index };

        default:
            return state;
    }
}
