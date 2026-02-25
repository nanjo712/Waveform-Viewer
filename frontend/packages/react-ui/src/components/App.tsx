import { useState, useCallback, type DragEvent } from 'react';
import { TitleBar } from './TitleBar.tsx';
import { Sidebar } from './Sidebar.tsx';
import { WaveformCanvas } from './WaveformCanvas.tsx';
import { StatusBar } from './StatusBar.tsx';
import { useAppContext } from '../hooks/useAppContext.tsx';

function App() {
    const { state, dispatch, vcdService, adapter } = useAppContext();
    const [isDragging, setIsDragging] = useState(false);
    const [isLoadingFile, setIsLoadingFile] = useState(false);

    const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!isDragging) setIsDragging(true);
    }, [isDragging]);

    const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        if (e.currentTarget.contains(e.relatedTarget as Node)) {
            return;
        }
        setIsDragging(false);
    }, []);

    const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(false);

        const nativeFile = e.dataTransfer.files?.[0];
        if (!nativeFile) return;

        if (!nativeFile.name.toLowerCase().endsWith('.vcd')) {
            alert('Please drop a .vcd file');
            return;
        }

        // Convert native File to PlatformFile via adapter
        const file = adapter.wrapNativeFile?.(nativeFile);
        if (!file) {
            alert('File drop is not supported on this platform');
            return;
        }

        setIsLoadingFile(true);
        try {
            const ok = await vcdService.indexFile(file);
            if (ok) {
                const metadata = await vcdService.getMetadata();
                const signals = await vcdService.getSignals();
                const hierarchy = await vcdService.getHierarchy();
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
            setIsLoadingFile(false);
        }
    }, [dispatch, vcdService, adapter]);

    if (state.wasmStatus === 'loading') {
        return (
            <div className="app-layout">
                <div className="loading-overlay">
                    <div className="spinner" />
                    <div>Loading WASM module...</div>
                </div>
            </div>
        );
    }

    if (state.wasmStatus === 'error') {
        return (
            <div className="app-layout">
                <div className="loading-overlay">
                    <div style={{ color: 'var(--text-error)', fontSize: '24px' }}>!</div>
                    <div>Failed to load WASM module</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                        {state.wasmError}
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                        Make sure the WASM files are built and available at /wasm/
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            className="app-layout"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {isDragging && (
                <div className="drag-overlay">
                    <div className="drag-overlay-content">
                        <div style={{ fontSize: '64px', marginBottom: '16px' }}>&#128193;</div>
                        <h2>Drop VCD File Here</h2>
                    </div>
                </div>
            )}
            {isLoadingFile && (
                <div className="loading-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(30, 30, 30, 0.85)', zIndex: 9999 }}>
                    <div className="spinner" />
                    <div>Indexing VCD file...</div>
                </div>
            )}
            <TitleBar />
            <div className="main-content">
                <Sidebar />
                <WaveformCanvas />
            </div>
            <StatusBar />
        </div>
    );
}

export default App;
