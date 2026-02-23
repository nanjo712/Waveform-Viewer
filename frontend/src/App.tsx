import './App.css';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { WaveformCanvas } from './components/WaveformCanvas';
import { StatusBar } from './components/StatusBar';
import { useAppContext } from './hooks/useAppContext';

function App() {
  const { state } = useAppContext();

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
    <div className="app-layout">
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
