import { useAppContext } from '../hooks/useAppContext.tsx';

export function StatusBar() {
    const { state } = useAppContext();

    const wasmLabel =
        state.wasmStatus === 'loading'
            ? 'WASM: Loading...'
            : state.wasmStatus === 'error'
                ? `WASM: Error`
                : 'WASM: Ready';

    return (
        <div className="statusbar">
            <span className="statusbar-item">{wasmLabel}</span>
            {state.fileLoaded && state.metadata && (
                <>
                    <span className="statusbar-item">
                        Timescale: {state.metadata.timescaleMagnitude}{' '}
                        {state.metadata.timescaleUnit}
                    </span>
                    <span className="statusbar-item">
                        Signals: {state.metadata.signalCount}
                    </span>
                    <span className="statusbar-item">
                        Time: {state.timeBegin} - {state.timeEnd}{' '}
                        {state.metadata.timescaleUnit}
                    </span>
                    <span className="statusbar-item">
                        Selected: {state.selectedSignals.length}
                    </span>
                </>
            )}
        </div>
    );
}
