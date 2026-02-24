import { useState, useCallback, type DragEvent } from 'react';
import './App.css';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { WaveformCanvas } from './components/WaveformCanvas';
import { StatusBar } from './components/StatusBar';
import { useAppContext } from './hooks/useAppContext';
function App() {
    const { state, dispatch, vcdService } = useAppContext();
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

        const file = e.dataTransfer.files?.[0];
        if (!file) return;

        if (!file.name.toLowerCase().endsWith('.vcd')) {
            alert('Please drop a .vcd file');
            return;
        }

        setIsLoadingFile(true);
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
            setIsLoadingFile(false);
        }
    }, [dispatch, vcdService]);

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
                        <div style={{ fontSize: '64px', marginBottom: '16px' }}>📁</div>
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
