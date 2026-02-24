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
    children: ReactNode;
}

export function AppProvider({ adapter, vcdService, children }: AppProviderProps) {
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
        vcdService
            .init()
            .then(() => dispatch({ type: 'WASM_READY' }))
            .catch((err: unknown) =>
                dispatch({
                    type: 'WASM_ERROR',
                    error: err instanceof Error ? err.message : String(err),
                })
            );
    }, [vcdService]);

    // Query waveform data whenever view or visible signals change
    const doQuery = useCallback(async () => {
        if (
            !vcdService.isFileLoaded ||
            state.visibleRowIndices.length === 0
        )
            return;

        try {
            const result = await vcdService.query(
                state.viewStart,
                state.viewEnd,
                state.visibleRowIndices
            );
            dispatch({ type: 'SET_QUERY_RESULT', result });
        } catch (err) {
            console.error('Query failed:', err);
        }
    }, [vcdService, state.viewStart, state.viewEnd, state.visibleRowIndices]);

    useEffect(() => {
        doQuery();
    }, [doQuery]);

    return (
        <AppContext.Provider value={{ state, dispatch, vcdService, adapter }}>
            {children}
        </AppContext.Provider>
    );
}
