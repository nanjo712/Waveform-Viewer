/// <reference lib="webworker" />

import type { WaveformParserModule } from '../types/waveform.ts';
import type { PlatformFile } from '../types/platform.ts';
import { WaveformEngine } from '../wasm/waveformEngine.ts';
import type { MainToWorkerMessage, WorkerToMainMessage } from './protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

let engine: WaveformEngine | null = null;
let abortController: AbortController | null = null;

self.onmessage = async (e: MessageEvent<MainToWorkerMessage>) => {
    const msg = e.data;

    try {
        switch (msg.type) {
            case 'INIT': {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    let createFn = (globalThis as any).createVcdParser;

                    if (!createFn) {
                        try {
                            // In classic workers this will load the script and inject `createVcdParser` globally.
                            importScripts(msg.wasmJsUri);
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            createFn = (globalThis as any).createVcdParser;
                        } catch (e) {
                            // In Vite dev mode, workers are loaded as ES Modules which do not support importScripts.
                            console.warn('importScripts failed (likely an ES Module worker). Falling back to fetch+eval:', e);
                            const response = await fetch(msg.wasmJsUri);
                            if (!response.ok) {
                                throw new Error(`Failed to fetch WASM glue code: ${response.statusText}`);
                            }
                            const scriptContent = await response.text();
                            // Evaluate the script and return the factory using `new Function()`.
                            // This guarantees execution doesn't pollute or miss global scope in strict mode.
                            const inject = new Function(`${scriptContent}\nreturn createVcdParser;`);
                            createFn = inject();
                        }
                    }

                    if (!createFn) {
                        throw new Error('createVcdParser not found after loading script');
                    }

                    const opts = msg.wasmBinaryUri ? {
                        locateFile: (path: string) => {
                            if (path.endsWith('.wasm')) return msg.wasmBinaryUri!;
                            return path;
                        }
                    } : undefined;

                    const mod = await createFn(opts) as WaveformParserModule;
                    engine = new WaveformEngine(mod);

                    self.postMessage({ type: 'INIT_DONE', success: true } as WorkerToMainMessage);
                } catch (err: any) {
                    self.postMessage({ type: 'INIT_DONE', success: false, error: err.message } as WorkerToMainMessage);
                }
                break;
            }

            case 'INDEX_FILE': {
                if (!engine) throw new Error('Worker not initialized');

                const FS = engine.module.FS;
                try {
                    FS.mkdir('/work');
                } catch (e) {
                    /* ignore if it exists */
                }

                let filePath = '';
                if (msg.file) {
                    filePath = '/work/' + msg.file.name;
                    try { FS.unmount('/work'); } catch (e) { }
                    FS.mount(FS.filesystems.WORKERFS, { files: [msg.file] }, '/work');
                } else if (msg.localPath) {
                    filePath = msg.localPath;
                }

                const success = await engine.indexFile(filePath, msg.fileSize, (bytesRead, totalBytes) => {
                    self.postMessage({
                        type: 'INDEX_PROGRESS',
                        bytesRead,
                        totalBytes
                    } as WorkerToMainMessage);
                });

                self.postMessage({
                    type: 'INDEX_DONE',
                    success
                } as WorkerToMainMessage);
                break;
            }

            case 'QUERY': {
                if (!engine) throw new Error('Worker not initialized');
                abortController = new AbortController();

                try {
                    const result = await engine.query(
                        msg.tBegin,
                        msg.tEnd,
                        msg.signalIndices,
                        abortController.signal,
                        msg.pixelTimeStep,
                        (partialResult) => {
                            self.postMessage({
                                type: 'QUERY_PROGRESS',
                                result: partialResult
                            } as WorkerToMainMessage);
                        }
                    );

                    self.postMessage({
                        type: 'QUERY_DONE',
                        result
                    } as WorkerToMainMessage);
                } catch (err: any) {
                    if (err.name === 'AbortError') {
                        // Already aborted
                    } else {
                        self.postMessage({
                            type: 'QUERY_DONE',
                            result: { tBegin: msg.tBegin, tEnd: msg.tEnd, signals: [] },
                            error: err.message
                        } as WorkerToMainMessage);
                    }
                } finally {
                    abortController = null;
                }
                break;
            }

            case 'ABORT_QUERY': {
                if (abortController) {
                    abortController.abort();
                    abortController = null;
                }
                break;
            }

            // READ_SLICE_RESPONSE removed

            case 'GET_METADATA': {
                if (!engine) return;
                self.postMessage({
                    type: 'METADATA_RESULT',
                    requestId: msg.requestId,
                    data: engine.getMetadata()
                } as WorkerToMainMessage);
                break;
            }

            case 'GET_SIGNALS': {
                if (!engine) return;
                self.postMessage({
                    type: 'SIGNALS_RESULT',
                    requestId: msg.requestId,
                    data: engine.getSignals()
                } as WorkerToMainMessage);
                break;
            }

            case 'GET_HIERARCHY': {
                if (!engine) return;
                self.postMessage({
                    type: 'HIERARCHY_RESULT',
                    requestId: msg.requestId,
                    data: engine.getHierarchy()
                } as WorkerToMainMessage);
                break;
            }

            case 'FIND_SIGNAL': {
                if (!engine) return;
                self.postMessage({
                    type: 'FIND_SIGNAL_RESULT',
                    requestId: msg.requestId,
                    data: engine.findSignal(msg.fullPath)
                } as WorkerToMainMessage);
                break;
            }

            case 'CLOSE': {
                if (engine) engine.close();
                break;
            }
        }
    } catch (err: any) {
        console.error('Worker error:', err);
    }
};
