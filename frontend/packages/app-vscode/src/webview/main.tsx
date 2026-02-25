/**
 * Webview entry point for the VSCode waveform viewer extension.
 *
 * Bootstraps React, sets up the PlatformAdapter, VcdService, and AppProvider,
 * then listens for messages from the extension host to drive file loading
 * and signal interactions.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { VcdService } from '@waveform-viewer/core';
import type { PlatformAdapter, Action, AppState } from '@waveform-viewer/core';
import { AppProvider } from '@waveform-viewer/react-ui';
import { WaveformView } from './WaveformView.tsx';
import {
    VscodePlatformAdapter,
    setWasmConfig,
    createPlatformFile,
    onHostMessage,
    postToHost,
} from './vscodeAdapter.ts';
import '@waveform-viewer/react-ui/styles/App.css';
import './vscodeStyles.css';
import type { HostToWebviewMessage, WebviewStateSnapshot } from '../protocol.ts';

// ── Setup ──────────────────────────────────────────────────────────

const adapter: PlatformAdapter = new VscodePlatformAdapter();
const vcdService = new VcdService(adapter);

// ── React rendering ────────────────────────────────────────────────

const root = createRoot(document.getElementById('root')!);

/**
 * AppWrapper — wraps AppProvider and listens for host messages
 * to dispatch actions into the React state.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useAppContext } from '@waveform-viewer/react-ui';

function WaveformViewWithBridge() {
    const { state, dispatch, vcdService: svc } = useAppContext();
    const prevStateRef = useRef<string>('');

    // ── Handle messages from extension host ────────────────────────

    useEffect(() => {
        const unregister = onHostMessage(async (msg: HostToWebviewMessage) => {
            switch (msg.type) {
                case 'init': {
                    if (msg.wasmJsUri && msg.wasmBinaryUri && msg.workerUri) {
                        setWasmConfig(msg.wasmJsUri, msg.wasmBinaryUri, msg.workerUri);
                        try {
                            await svc.init();
                            dispatch({ type: 'WASM_READY' });
                            postToHost({ type: 'wasmReady' });
                        } catch (err) {
                            dispatch({
                                type: 'WASM_ERROR',
                                error: err instanceof Error ? err.message : String(err),
                            });
                            postToHost({
                                type: 'error',
                                message: `WASM init failed: ${err instanceof Error ? err.message : String(err)}`,
                            });
                        }
                    }
                    break;
                }

                case 'fileOpened': {
                    try {
                        const file = createPlatformFile(msg.fileName, msg.fileSize);
                        const success = await svc.indexFile(file);
                        if (success) {
                            const metadata = await svc.getMetadata();
                            const signals = await svc.getSignals();
                            const hierarchy = await svc.getHierarchy();
                            dispatch({
                                type: 'FILE_LOADED',
                                metadata,
                                signals,
                                hierarchy,
                                fileName: msg.fileName,
                            });
                        } else {
                            postToHost({
                                type: 'error',
                                message: `Failed to parse VCD file: ${msg.fileName}`,
                            });
                        }
                    } catch (err) {
                        postToHost({
                            type: 'error',
                            message: `Error loading file: ${err instanceof Error ? err.message : String(err)}`,
                        });
                    }
                    break;
                }

                case 'signalToggle': {
                    dispatch({ type: 'TOGGLE_SIGNAL', index: msg.index });
                    break;
                }

                case 'signalAdd': {
                    dispatch({ type: 'ADD_SIGNALS', indices: msg.indices });
                    break;
                }

                case 'signalRemove': {
                    dispatch({ type: 'REMOVE_SIGNALS', indices: msg.indices });
                    break;
                }

                case 'setSearch': {
                    dispatch({ type: 'SET_SEARCH', query: msg.query });
                    break;
                }

                case 'toggleChisel': {
                    dispatch({ type: 'TOGGLE_UNFLATTEN_CHISEL' });
                    break;
                }
            }
        });

        // Signal ready AFTER the message handler is registered,
        // so we don't miss the host's 'init' response.
        postToHost({ type: 'ready' });

        // Cleanup: unregister handler on unmount (important for StrictMode)
        return unregister;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Send state updates to extension host ───────────────────────

    const sendStateUpdate = useCallback((s: AppState) => {
        const snapshot: WebviewStateSnapshot = {
            fileLoaded: s.fileLoaded,
            fileName: s.fileName,
            metadata: s.metadata,
            signals: s.signals,
            hierarchy: s.hierarchy,
            selectedSignals: s.selectedSignals,
            unflattenChisel: s.unflattenChisel,
            searchQuery: s.searchQuery,
            viewStart: s.viewStart,
            viewEnd: s.viewEnd,
            timeBegin: s.timeBegin,
            timeEnd: s.timeEnd,
        };
        postToHost({ type: 'stateUpdate', state: snapshot });
    }, []);

    useEffect(() => {
        // Only send when relevant state has changed
        const key = JSON.stringify({
            fileLoaded: state.fileLoaded,
            fileName: state.fileName,
            selectedSignals: state.selectedSignals,
            unflattenChisel: state.unflattenChisel,
            searchQuery: state.searchQuery,
            signalCount: state.signals.length,
        });
        if (key !== prevStateRef.current) {
            prevStateRef.current = key;
            sendStateUpdate(state);
        }
    }, [state, sendStateUpdate]);

    return <WaveformView />;
}

// ── Render ──────────────────────────────────────────────────────────

root.render(
    <StrictMode>
        <AppProvider adapter={adapter} vcdService={vcdService}>
            <WaveformViewWithBridge />
        </AppProvider>
    </StrictMode>,
);
