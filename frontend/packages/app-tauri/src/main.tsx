import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WaveformService, type PlatformAdapter } from '@waveform-viewer/core';
import { AppProvider, App } from '@waveform-viewer/react-ui';
import '@waveform-viewer/react-ui/styles/App.css';
import { TauriPlatformAdapter } from './tauriAdapter.ts';

const adapter: PlatformAdapter = new TauriPlatformAdapter();
const waveformService = new WaveformService(adapter);

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <AppProvider adapter={adapter} waveformService={waveformService} autoInitWasm={true}>
            <App />
        </AppProvider>
    </StrictMode>,
);
