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
    VcdService,
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
    vcdService: VcdService;
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
    vcdService: VcdService;
    autoInitWasm?: boolean;
    children: ReactNode;
}

export function AppProvider({ adapter, vcdService, autoInitWasm = false, children }: AppProviderProps) {
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

        vcdService
            .init()
            .then(() => dispatch({ type: 'WASM_READY' }))
            .catch((err: unknown) =>
                dispatch({
                    type: 'WASM_ERROR',
                    error: err instanceof Error ? err.message : String(err),
                })
            );
    }, [vcdService, autoInitWasm]);

    // ── Query Optimization State ───────────────────────────────────────────
    const currentDataRangeRef = useRef<{ start: number, end: number, signals: string } | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const lastQueryTimeRef = useRef<number>(0);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Cleanup resources on unmount
    useEffect(() => {
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            if (abortControllerRef.current) abortControllerRef.current.abort();
        };
    }, []);

    // Query waveform data whenever view or visible signals change
    useEffect(() => {
        if (!state.fileLoaded || !vcdService.isFileLoaded || state.visibleRowIndices.length === 0) return;

        const w = state.viewEnd - state.viewStart;
        if (w <= 0) return;

        const sigDesc = state.visibleRowIndices.join(',');

        // 1. Spatial Optimization: Prefetching & Padding
        const cache = currentDataRangeRef.current;
        if (
            cache &&
            cache.signals === sigDesc &&
            state.viewStart >= cache.start &&
            state.viewEnd <= cache.end
        ) {
            // New view falls completely within our padded buffer, no Wasm query needed!
            return;
        }

        // We need new data. Calculate padded range (1x width on each side).
        const reqStart = Math.max(0, state.viewStart - w);
        const reqEnd = state.viewEnd + w;

        // 2 & 4. Temporal Optimization & Query Cancellation
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        const ac = new AbortController();
        abortControllerRef.current = ac;

        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }

        const executeQuery = async () => {
            lastQueryTimeRef.current = Date.now();

            // Heuristic for LOD: assume the canvas is roughly window.innerWidth in width.
            // A more exact way would be reading real canvas bounds, but this is a solid approximation.
            const canvasWidth = typeof window !== 'undefined' ? window.innerWidth : 1000;
            const pixelTimeStep = w / canvasWidth;

            try {
                const result = await vcdService.query(
                    reqStart,
                    reqEnd,
                    state.visibleRowIndices,
                    ac.signal,
                    pixelTimeStep,
                    (partialResult) => {
                        // PROGRESSIVE RENDERING: Streaming partial updates directly to canvas
                        dispatch({ type: 'SET_QUERY_RESULT', result: partialResult });
                    }
                );

                if (ac.signal.aborted) return;

                currentDataRangeRef.current = { start: reqStart, end: reqEnd, signals: sigDesc };
                dispatch({ type: 'SET_QUERY_RESULT', result });
            } catch (err: unknown) {
                if (err instanceof Error && err.name === 'AbortError') return;
                console.error('Query failed:', err);
            }
        };

        const now = Date.now();
        const elapsed = now - lastQueryTimeRef.current;
        const THROTTLE_MS = 60; // Throttling threshold

        if (elapsed >= THROTTLE_MS) {
            executeQuery();
        } else {
            // Debounce for trailing edge
            timerRef.current = setTimeout(() => {
                executeQuery();
            }, THROTTLE_MS - Math.max(0, elapsed));
        }
    }, [vcdService, state.fileLoaded, state.viewStart, state.viewEnd, state.visibleRowIndices, dispatch]);

    return (
        <AppContext.Provider value={{ state, dispatch, vcdService, adapter }}>
            {children}
        </AppContext.Provider>
    );
}
