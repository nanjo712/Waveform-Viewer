/**
 * WaveformView — slim wrapper around WaveformCanvas for the VSCode webview.
 *
 * This renders only the waveform toolbar + canvas (no sidebar, no title bar,
 * no status bar — those are native VSCode UI elements).
 */

import { WaveformCanvas } from '@waveform-viewer/react-ui';

export function WaveformView() {
    return (
        <div className="vscode-waveform-root">
            <WaveformCanvas />
        </div>
    );
}
