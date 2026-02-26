import { parentPort } from 'worker_threads';
import { WaveformEngine } from '../../core/src/wasm/waveformEngine.ts';
import type { MainToWorkerMessage, WorkerToMainMessage } from '../../core/src/worker/protocol.ts';
import type { QueryResult } from '../../core/src/types/waveform.ts';
import * as path from 'path';

if (!parentPort) throw new Error('Must run as a worker thread');

let engine: WaveformEngine | null = null;
let abortController: AbortController | null = null;

parentPort.on('message', async (msg: MainToWorkerMessage) => {
    try {
        switch (msg.type) {
            case 'INIT': {
                try {
                    // wasmJsUri should be an absolute local file path passed from VcdEditorProvider
                    const createFn = require(msg.wasmJsUri);
                    const mod = await createFn({
                        locateFile: (file: string) => {
                            if (file.endsWith('.wasm') && msg.wasmBinaryUri) {
                                return msg.wasmBinaryUri;
                            }
                            return file;
                        }
                    });

                    engine = new WaveformEngine(mod);
                    parentPort!.postMessage({ type: 'INIT_DONE', success: true } as WorkerToMainMessage);
                } catch (err: any) {
                    parentPort!.postMessage({ type: 'INIT_DONE', success: false, error: err.message } as WorkerToMainMessage);
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
                if (msg.localPath) {
                    const dir = path.dirname(msg.localPath);
                    const base = path.basename(msg.localPath);

                    try { FS.unmount('/work'); } catch (e) { }

                    // Mount the directory containing the file via NODEFS
                    FS.mount(FS.filesystems.NODEFS, { root: dir }, '/work');
                    filePath = '/work/' + base;
                } else {
                    throw new Error('NODEFS requires a local path');
                }

                const success = await engine.indexFile(filePath, msg.fileSize, (bytesRead: number, totalBytes: number) => {
                    parentPort!.postMessage({
                        type: 'INDEX_PROGRESS',
                        bytesRead,
                        totalBytes
                    } as WorkerToMainMessage);
                });

                parentPort!.postMessage({
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
                        (partialResult: QueryResult) => {
                            parentPort!.postMessage({
                                type: 'QUERY_PROGRESS',
                                result: partialResult
                            } as WorkerToMainMessage);
                        }
                    );

                    parentPort!.postMessage({
                        type: 'QUERY_DONE',
                        result
                    } as WorkerToMainMessage);
                } catch (err: any) {
                    if (err.name === 'AbortError') {
                        // Already aborted
                    } else {
                        parentPort!.postMessage({
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

            case 'GET_METADATA': {
                if (!engine) return;
                parentPort!.postMessage({
                    type: 'METADATA_RESULT',
                    requestId: msg.requestId,
                    data: engine.getMetadata()
                } as WorkerToMainMessage);
                break;
            }

            case 'GET_SIGNALS': {
                if (!engine) return;
                parentPort!.postMessage({
                    type: 'SIGNALS_RESULT',
                    requestId: msg.requestId,
                    data: engine.getSignals()
                } as WorkerToMainMessage);
                break;
            }

            case 'GET_HIERARCHY': {
                if (!engine) return;
                parentPort!.postMessage({
                    type: 'HIERARCHY_RESULT',
                    requestId: msg.requestId,
                    data: engine.getHierarchy()
                } as WorkerToMainMessage);
                break;
            }

            case 'FIND_SIGNAL': {
                if (!engine) return;
                parentPort!.postMessage({
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
});
