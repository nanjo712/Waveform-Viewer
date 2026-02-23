import { useCallback, useRef, useState } from 'react';
import { useAppContext } from '../hooks/useAppContext';

export function TitleBar() {
  const { state, dispatch, vcdService } = useAppContext();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);

  const handleFileSelect = useCallback(
    async (file: File) => {
      setLoading(true);
      try {
        const buffer = await file.arrayBuffer();
        const ok = vcdService.parseFile(buffer);
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

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFileSelect(file);
      e.target.value = '';
    },
    [handleFileSelect]
  );

  const handleOpen = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleClose = useCallback(() => {
    vcdService.close();
    dispatch({ type: 'FILE_CLOSED' });
  }, [dispatch, vcdService]);

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
          <strong>Waveform Viewer</strong>
          {state.fileName && ` - ${state.fileName}`}
        </span>
      </div>
      <div className="titlebar-right">
        {loading && <span style={{ color: 'var(--text-warning)' }}>Parsing...</span>}
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
        <input
          ref={fileInputRef}
          type="file"
          accept=".vcd"
          onChange={handleInputChange}
          style={{ display: 'none' }}
        />
      </div>
    </div>
  );
}
