import {
    createContext,
    useContext,
    useReducer,
    useCallback,
    useEffect,
    type ReactNode,
    type Dispatch,
} from 'react';
import { VcdService } from '../wasm/vcdService';
import type {
    SignalDef,
    ScopeNode,
    VcdMetadata,
    QueryResult,
} from '../types/vcd';

// ── State ──────────────────────────────────────────────────────────────

interface AppState {
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

    /** Custom format overrides per signal index */
    signalFormats: Record<number, string>;
}

const initialState: AppState = {
    wasmStatus: 'loading',
    wasmError: null,
    fileLoaded: false,
    fileName: null,
    metadata: null,
    signals: [],
    hierarchy: null,
    selectedSignals: [],
    viewStart: 0,
    viewEnd: 100,
    timeBegin: 0,
    timeEnd: 100,
    queryResult: null,
    searchQuery: '',
    sidebarCollapsed: false,
    signalFormats: {},
};

// ── Actions ────────────────────────────────────────────────────────────

type Action =
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
    | { type: 'SELECT_SIGNALS'; indices: number[] }
    | { type: 'REMOVE_SIGNAL'; index: number }
    | { type: 'SET_VIEW'; start: number; end: number }
    | { type: 'SET_QUERY_RESULT'; result: QueryResult }
    | { type: 'SET_SEARCH'; query: string }
    | { type: 'TOGGLE_SIDEBAR' }
    | { type: 'MOVE_SIGNAL'; fromIdx: number; toIdx: number }
    | { type: 'SET_SIGNAL_FORMAT'; index: number; format: string };

function reducer(state: AppState, action: Action): AppState {
    switch (action.type) {
        case 'WASM_READY':
            return { ...state, wasmStatus: 'ready' };

        case 'WASM_ERROR':
            return { ...state, wasmStatus: 'error', wasmError: action.error };

        case 'FILE_LOADED': {
            const tBegin = action.metadata.timeBegin;
            const tEnd = action.metadata.timeEnd;
            return {
                ...state,
                fileLoaded: true,
                fileName: action.fileName,
                metadata: action.metadata,
                signals: action.signals,
                hierarchy: action.hierarchy,
                selectedSignals: [],
                viewStart: tBegin,
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

        case 'SELECT_SIGNALS':
            return { ...state, selectedSignals: action.indices };

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

        default:
            return state;
    }
}

// ── Context ────────────────────────────────────────────────────────────

interface AppContextValue {
    state: AppState;
    dispatch: Dispatch<Action>;
    vcdService: VcdService;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useAppContext(): AppContextValue {
    const ctx = useContext(AppContext);
    if (!ctx) throw new Error('useAppContext must be used within AppProvider');
    return ctx;
}

// ── Provider ───────────────────────────────────────────────────────────

const vcdService = new VcdService();

export function AppProvider({ children }: { children: ReactNode }) {
    const [state, dispatch] = useReducer(reducer, initialState);

    // Initialize WASM on mount
    useEffect(() => {
        vcdService
            .init()
            .then(() => dispatch({ type: 'WASM_READY' }))
            .catch((err: unknown) =>
                dispatch({
                    type: 'WASM_ERROR',
                    error: err instanceof Error ? err.message : String(err),
                })
            );
    }, []);

    // Query waveform data whenever view or selected signals change
    const doQuery = useCallback(() => {
        if (
            !vcdService.isFileLoaded ||
            state.selectedSignals.length === 0
        )
            return;

        try {
            const result = vcdService.query(
                state.viewStart,
                state.viewEnd,
                state.selectedSignals
            );
            dispatch({ type: 'SET_QUERY_RESULT', result });
        } catch (err) {
            console.error('Query failed:', err);
        }
    }, [state.viewStart, state.viewEnd, state.selectedSignals]);

    useEffect(() => {
        doQuery();
    }, [doQuery]);

    return (
        <AppContext.Provider value={{ state, dispatch, vcdService }}>
            {children}
        </AppContext.Provider>
    );
}
