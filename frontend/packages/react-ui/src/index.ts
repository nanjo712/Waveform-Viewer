// ── Components ─────────────────────────────────────────────────────────
export { default as App } from './components/App.tsx';
export { TitleBar } from './components/TitleBar.tsx';
export { Sidebar } from './components/Sidebar.tsx';
export { WaveformCanvas } from './components/WaveformCanvas.tsx';
export { StatusBar } from './components/StatusBar.tsx';

// ── Hooks & Context ────────────────────────────────────────────────────
export { useAppContext, AppProvider } from './hooks/useAppContext.tsx';
export type { AppContextValue, AppProviderProps } from './hooks/useAppContext.tsx';

// ── Styles (import side-effect) ────────────────────────────────────────
// App packages should import '@waveform-viewer/react-ui/styles/App.css'
// or import the CSS from this package's styles/ directory.
