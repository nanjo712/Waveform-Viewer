import { useCallback, useState } from 'react';
import { useAppContext } from '../hooks/useAppContext.tsx';

export function TitleBar() {
    const { state, dispatch, waveformService, adapter } = useAppContext();
    const [loading, setLoading] = useState(false);

    const handleFileSelect = useCallback(
        async (file: import('@waveform-viewer/core').PlatformFile) => {
            setLoading(true);
            try {
                const ok = await waveformService.indexFile(file);
                if (ok) {
                    const metadata = await waveformService.getMetadata();
                    const signals = await waveformService.getSignals();
                    const hierarchy = await waveformService.getHierarchy();
                    dispatch({
                        type: 'FILE_LOADED',
                        metadata,
                        signals,
                        hierarchy,
                        fileName: file.name,
                    });
                } else {
                    alert('Failed to parse waveform file');
                }
            } catch (err) {
                alert(`Error: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
                setLoading(false);
            }
        },
        [dispatch, waveformService]
    );

    const handleOpen = useCallback(async () => {
        const file = await adapter.pickFile({ extensions: ['.vcd', '.fst'] });
        if (file) handleFileSelect(file);
    }, [adapter, handleFileSelect]);

    const handleClose = useCallback(() => {
        waveformService.close();
        dispatch({ type: 'FILE_CLOSED' });
    }, [dispatch, waveformService]);

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
                {state.fileLoaded && (
                    <div className="lod-control" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginRight: '16px' }}>
                        <span style={{ fontSize: '12px', opacity: 0.8 }}>LOD Detail:</span>
                        <input
                            type="range"
                            min="1"
                            max="5"
                            step="0.5"
                            value={state.lodPixelFactor}
                            onChange={(e) => dispatch({ type: 'SET_LOD_FACTOR', factor: parseFloat(e.target.value) })}
                            style={{ width: '80px' }}
                        />
                        <span style={{ fontSize: '12px', minWidth: '20px' }}>{state.lodPixelFactor.toFixed(1)}x</span>
                    </div>
                )}
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
                    Open Waveform File
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
