/**
 * React Context + Provider for the Waveform Viewer application state.
 *
 * Imports the pure reducer and types from @waveform-viewer/core.
 * The PlatformAdapter and VcdService are created by the app package
 * and passed in as props to <AppProvider>.
 */

import {
    createContext,
    useContext,
    useReducer,
    useCallback,
    useEffect,
    useRef,
    type ReactNode,
    type Dispatch,
} from 'react';

import {
    appReducer,
    initialState,
    WaveformService,
} from '@waveform-viewer/core';
import type {
    AppState,
    Action,
    PlatformAdapter,
    FormatPlugin,
} from '@waveform-viewer/core';

// ── Context ────────────────────────────────────────────────────────────

export interface AppContextValue {
    state: AppState;
    dispatch: Dispatch<Action>;
    waveformService: WaveformService;
    adapter: PlatformAdapter;
}

const AppContext = createContext<AppContextValue | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useAppContext(): AppContextValue {
    const ctx = useContext(AppContext);
    if (!ctx) throw new Error('useAppContext must be used within AppProvider');
    return ctx;
}

// ── Provider ───────────────────────────────────────────────────────────

export interface AppProviderProps {
    adapter: PlatformAdapter;
    waveformService: WaveformService;
    autoInitWasm?: boolean;
    children: ReactNode;
}

export function AppProvider({ adapter, waveformService, autoInitWasm = false, children }: AppProviderProps) {
    const [state, dispatch] = useReducer(appReducer, initialState);

    // Bind window.WaveformViewer globally so plugins can register themselves
    useEffect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).WaveformViewer = {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...((globalThis as any).WaveformViewer || {}),
            registerPlugin: (plugin: FormatPlugin) => {
                dispatch({ type: 'REGISTER_PLUGIN', plugin });
                console.log(`Plugin registered: ${plugin.name} (${plugin.id})`);
            }
        };
    }, []);

    // Initialize WASM on mount
    useEffect(() => {
        if (!autoInitWasm) return;

        waveformService
            .init()
            .then(() => dispatch({ type: 'WASM_READY' }))
            .catch((err: unknown) =>
                dispatch({
                    type: 'WASM_ERROR',
                    error: err instanceof Error ? err.message : String(err),
                })
            );
    }, [waveformService, autoInitWasm]);

    // ── Query Optimization State ───────────────────────────────────────────
    // Query waveform data whenever view or visible signals change
    useEffect(() => {
        if (!state.fileLoaded || !waveformService.isFileLoaded || state.visibleRowIndices.length === 0) return;

        const w = state.viewEnd - state.viewStart;
        if (w <= 0) return;

        // We need new data. Calculate padded range (1x width on each side).
        const reqStart = Math.max(0, state.viewStart - w);
        const reqEnd = state.viewEnd + w;

        const executeQuery = async () => {
            // Heuristic for LOD: assume the canvas is roughly window.innerWidth in width.
            const canvasWidth = typeof window !== 'undefined' ? window.innerWidth : 1000;
            const pixelTimeStep = w / canvasWidth;

            try {
                const result = await waveformService.query(
                    reqStart,
                    reqEnd,
                    state.visibleRowIndices,
                    undefined, // AbortSignal no longer needed, managed by Service queue
                    pixelTimeStep,
                    (partialResult) => {
                        // PROGRESSIVE RENDERING: Streaming partial updates directly to canvas
                        dispatch({ type: 'SET_QUERY_RESULT', result: partialResult });
                    }
                );

                dispatch({ type: 'SET_QUERY_RESULT', result });
            } catch (err: unknown) {
                if (err instanceof Error && err.name === 'AbortError') {
                    // This query was kicked out of the Service queue by a newer one.
                    // This is expected, do nothing.
                    return;
                }
                console.error('Query failed:', err);
            }
        };

        // Fire and forget
        executeQuery();
    }, [waveformService, state.fileLoaded, state.viewStart, state.viewEnd, state.visibleRowIndices, dispatch, state.queryCounter]);

    return (
        <AppContext.Provider value={{ state, dispatch, waveformService, adapter }}>
            {children}
        </AppContext.Provider>
    );
}
