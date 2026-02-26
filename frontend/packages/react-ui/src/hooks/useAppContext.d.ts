/**
 * React Context + Provider for the Waveform Viewer application state.
 *
 * Imports the pure reducer and types from @waveform-viewer/core.
 * The PlatformAdapter and VcdService are created by the app package
 * and passed in as props to <AppProvider>.
 */
import { type ReactNode, type Dispatch } from 'react';
import { WaveformService } from '@waveform-viewer/core';
import type { AppState, Action, PlatformAdapter } from '@waveform-viewer/core';
export interface AppContextValue {
    state: AppState;
    dispatch: Dispatch<Action>;
    waveformService: WaveformService;
    adapter: PlatformAdapter;
}
export declare function useAppContext(): AppContextValue;
export interface AppProviderProps {
    adapter: PlatformAdapter;
    waveformService: WaveformService;
    autoInitWasm?: boolean;
    children: ReactNode;
}
export declare function AppProvider({ adapter, waveformService, autoInitWasm, children }: AppProviderProps): import("react/jsx-runtime").JSX.Element;
