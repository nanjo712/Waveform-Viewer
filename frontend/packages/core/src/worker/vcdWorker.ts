/// <reference lib="webworker" />

import type { VcdParserModule } from '../types/vcd.ts';
import type { PlatformFile } from '../types/platform.ts';
import { VcdEngine } from '../wasm/vcdEngine.ts';
import type { MainToWorkerMessage, WorkerToMainMessage } from './protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

let engine: VcdEngine | null = null;
let abortController: AbortController | null = null;

// Map for pending read slice requests
let nextRequestId = 1;
const pendingRequests = new Map<number, (buffer: ArrayBuffer) => void>();

class WorkerPlatformFile implements PlatformFile {
    public readonly name: string;
    public readonly size: number;

    constructor(name: string, size: number) {
        this.name = name;
        this.size = size;
    }

    readSlice(offset: number, length: number): Promise<ArrayBuffer> {
        return new Promise((resolve) => {
            const requestId = nextRequestId++;
            pendingRequests.set(requestId, resolve);
            self.postMessage({
                type: 'READ_SLICE_REQUEST',
                requestId,
                offset,
                length
            } as WorkerToMainMessage);
        });
    }
}

let workerFile: WorkerPlatformFile | null = null;

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

                    const mod = await createFn(opts);
                    engine = new VcdEngine(mod);

                    self.postMessage({ type: 'INIT_DONE', success: true } as WorkerToMainMessage);
                } catch (err: any) {
                    self.postMessage({ type: 'INIT_DONE', success: false, error: err.message } as WorkerToMainMessage);
                }
                break;
            }

            case 'INDEX_FILE': {
                if (!engine) throw new Error('Worker not initialized');
                workerFile = new WorkerPlatformFile('worker_file', msg.fileSize);

                const success = await engine.indexFile(workerFile, (bytesRead, totalBytes) => {
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

            case 'READ_SLICE_RESPONSE': {
                const resolve = pendingRequests.get(msg.requestId);
                if (resolve) {
                    pendingRequests.delete(msg.requestId);
                    resolve(msg.buffer);
                }
                break;
            }

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
                workerFile = null;
                break;
            }
        }
    } catch (err: any) {
        console.error('Worker error:', err);
    }
};
