import { useCallback, useState } from 'react';
import { useAppContext } from '../hooks/useAppContext.tsx';

export function TitleBar() {
    const { state, dispatch, vcdService, adapter } = useAppContext();
    const [loading, setLoading] = useState(false);

    const handleFileSelect = useCallback(
        async (file: import('@waveform-viewer/core').PlatformFile) => {
            setLoading(true);
            try {
                const ok = await vcdService.indexFile(file);
                if (ok) {
                    const metadata = vcdService.getMetadata();
                    const signals = vcdService.getSignals();
                    const hierarchy = vcdService.getHierarchy();
                    dispatch({
                        type: 'FILE_LOADED',
                        metadata,
                        signals,
                        hierarchy,
                        fileName: file.name,
                    });
                } else {
                    alert('Failed to parse VCD file');
                }
            } catch (err) {
                alert(`Error: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
                setLoading(false);
            }
        },
        [dispatch, vcdService]
    );

    const handleOpen = useCallback(async () => {
        const file = await adapter.pickFile({ extensions: ['.vcd'] });
        if (file) handleFileSelect(file);
    }, [adapter, handleFileSelect]);

    const handleClose = useCallback(() => {
        vcdService.close();
        dispatch({ type: 'FILE_CLOSED' });
    }, [dispatch, vcdService]);

    const handleOpenPlugin = useCallback(async () => {
        if (!adapter.loadPlugin) {
            alert('Plugin loading is not supported on this platform');
            return;
        }
        try {
            await adapter.loadPlugin();
        } catch (err) {
            alert(`Failed to load plugin: ${err instanceof Error ? err.message : String(err)}`);
        }
    }, [adapter]);

    return (
        <div className="titlebar">
            <div className="titlebar-left">
                <button
                    className="btn btn-icon"
                    onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
                    title="Toggle Sidebar"
                >
                    &#9776;
                </button>
                <span className="titlebar-title">
                    <img src="./favicon.png" alt="Logo" className="app-logo" />
                    <strong>Waveform Viewer</strong>
                    {state.fileName && ` - ${state.fileName}`}
                </span>
            </div>
            <div className="titlebar-right">
                {loading && <span style={{ color: 'var(--text-warning)' }}>Indexing...</span>}
                <button
                    className="btn"
                    onClick={handleOpenPlugin}
                    disabled={state.wasmStatus !== 'ready'}
                >
                    Load Plugin
                </button>
                <button
                    className="btn btn-primary"
                    onClick={handleOpen}
                    disabled={state.wasmStatus !== 'ready' || loading}
                >
                    Open VCD
                </button>
                {state.fileLoaded && (
                    <button className="btn" onClick={handleClose}>
                        Close
                    </button>
                )}
            </div>
        </div>
    );
}
