/**
 * WaveformServiceClient — Proxy for WaveformEngine running in a Web Worker.
 * Exposes the same public API as the original VcdService, so UI components
 * do not need to change.
 */

import type {
    WaveformMetadata,
    SignalDef,
    ScopeNode,
    QueryResult,
} from '../types/waveform.ts';
import type { PlatformAdapter, PlatformFile } from '../types/platform.ts';
import type { MainToWorkerMessage, WorkerToMainMessage } from '../worker/protocol.ts';

export class WaveformServiceClient {
    private worker: Worker | null = null;
    private adapter: PlatformAdapter;
    private file: PlatformFile | null = null;

    private _isReady = false;
    private _isFileLoaded = false;

    // Cache to match original behavior
    private queryCache = new Map<string, QueryResult>();
    private readonly MAX_CACHE_SIZE = 10;

    private initPromise: Promise<void> | null = null;

    // Callbacks for one-off requests
    private initResolve: ((value: void) => void) | null = null;
    private initReject: ((error: Error) => void) | null = null;

    private indexResolve: ((value: boolean) => void) | null = null;
    private indexReject: ((error: Error) => void) | null = null;
    private indexProgressCb: ((bytesRead: number, totalBytes: number) => void) | null = null;

    private queryResolve: ((value: QueryResult) => void) | null = null;
    private queryReject: ((error: Error) => void) | null = null;
    private queryProgressCb: ((partialResult: QueryResult) => void) | null = null;

    // Generic request callbacks (getMetadata, findSignal, etc.)
    private nextRequestId = 1;
    private pendingRequests = new Map<number, { resolve: (data: any) => void; reject: (err: Error) => void }>();

    constructor(adapter: PlatformAdapter) {
        this.adapter = adapter;
    }

    async init(): Promise<void> {
        if (this.initPromise) return this.initPromise;

        this.initPromise = new Promise((resolve, reject) => {
            this.worker = this.adapter.createWorker();
            this.worker.onmessage = this.handleWorkerMessage.bind(this);
            this.worker.onerror = (e) => console.error('Worker error:', e);

            this.initResolve = resolve;
            this.initReject = reject;

            const config = this.adapter.getWasmConfig();
            this.worker!.postMessage({
                type: 'INIT',
                wasmJsUri: config.jsUri,
                wasmBinaryUri: config.binaryUri
            } as MainToWorkerMessage);
        });

        return this.initPromise;
    }

    get isReady(): boolean {
        return this._isReady;
    }

    get isFileLoaded(): boolean {
        return this._isFileLoaded;
    }

    async indexFile(
        file: PlatformFile,
        onProgress?: (bytesRead: number, totalBytes: number) => void
    ): Promise<boolean> {
        if (!this.worker) throw new Error('Worker not initialized');
        this.close();

        this.file = file;
        this.indexProgressCb = onProgress || null;

        return new Promise((resolve, reject) => {
            this.indexResolve = resolve;
            this.indexReject = reject;

            this.worker!.postMessage({
                type: 'INDEX_FILE',
                file: file.nativeFile,
                localPath: file.localPath,
                fileSize: file.size
            } as MainToWorkerMessage);
        });
    }

    async query(
        tBegin: number,
        tEnd: number,
        signalIndices: number[],
        abortSignal?: AbortSignal,
        pixelTimeStep = -1.0,
        onProgress?: (partialResult: QueryResult) => void
    ): Promise<QueryResult> {
        if (!this.worker) throw new Error('Worker not initialized');
        if (!this._isFileLoaded) throw new Error('No file loaded');

        // Check cache
        const sigDesc = signalIndices.join(',');
        for (const [key, cached] of this.queryCache.entries()) {
            const [cSigDesc, cLOD] = key.split('|');
            if (cSigDesc === sigDesc && cLOD === pixelTimeStep.toString() && cached.tBegin <= tBegin && cached.tEnd >= tEnd) {
                this.queryCache.delete(key);
                this.queryCache.set(key, cached);
                if (onProgress) onProgress(cached);
                return cached;
            }
        }

        // Cancel previous query if any is active (simple strategy)
        if (this.queryReject) {
            this.worker.postMessage({ type: 'ABORT_QUERY' } as MainToWorkerMessage);
            this.queryReject(new Error('Query aborted by new query'));
            this.cleanupQueryCallbacks();
        }

        this.queryProgressCb = onProgress || null;

        const onAbort = () => {
            if (this.worker) this.worker.postMessage({ type: 'ABORT_QUERY' } as MainToWorkerMessage);
            if (this.queryReject) {
                const err = new Error('Query aborted');
                err.name = 'AbortError';
                this.queryReject(err);
            }
            this.cleanupQueryCallbacks();
        };

        abortSignal?.addEventListener('abort', onAbort);

        return new Promise<QueryResult>((resolve, reject) => {
            this.queryResolve = resolve;
            this.queryReject = reject;

            this.worker!.postMessage({
                type: 'QUERY',
                tBegin,
                tEnd,
                signalIndices,
                pixelTimeStep
            } as MainToWorkerMessage);
        }).then(result => {
            abortSignal?.removeEventListener('abort', onAbort);

            const newCacheKey = `${sigDesc}|${pixelTimeStep}|${tBegin}|${tEnd}`;
            this.queryCache.set(newCacheKey, result);
            if (this.queryCache.size > this.MAX_CACHE_SIZE) {
                const firstKey = this.queryCache.keys().next().value;
                if (firstKey) this.queryCache.delete(firstKey);
            }

            return result;
        }).catch(err => {
            abortSignal?.removeEventListener('abort', onAbort);
            throw err;
        });
    }

    // --- Metadata Accessors (using RPC style) ---

    async getMetadata(): Promise<WaveformMetadata> {
        return this.sendRpcRequest<WaveformMetadata>('GET_METADATA');
    }

    async getSignals(): Promise<SignalDef[]> {
        return this.sendRpcRequest<SignalDef[]>('GET_SIGNALS');
    }

    async getHierarchy(): Promise<ScopeNode> {
        return this.sendRpcRequest<ScopeNode>('GET_HIERARCHY');
    }

    async findSignal(fullPath: string): Promise<number> {
        return this.sendRpcRequest<number>('FIND_SIGNAL', { fullPath });
    }

    // For backwards compatibility and synchronous needs in React.
    // In a worker setup, we might need to pre-fetch these when index finishes.
    // For now, these will throw if not pre-fetched, but we'll try to provide them.
    private _cachedMetadata: WaveformMetadata | null = null;
    private _cachedSignals: SignalDef[] | null = null;
    private _cachedHierarchy: ScopeNode | null = null;

    getMetadataSync(): WaveformMetadata {
        if (!this._cachedMetadata) throw new Error('Metadata not loaded yet');
        return this._cachedMetadata;
    }

    getSignalsSync(): SignalDef[] {
        if (!this._cachedSignals) throw new Error('Signals not loaded yet');
        return this._cachedSignals;
    }

    getHierarchySync(): ScopeNode {
        if (!this._cachedHierarchy) throw new Error('Hierarchy not loaded yet');
        return this._cachedHierarchy;
    }

    findSignalSync(fullPath: string): number {
        if (!this._cachedSignals) throw new Error('Signals not loaded yet');
        return this._cachedSignals.findIndex(s => s.fullPath === fullPath);
    }

    // Alias getters for existing code calling getMetadata() synchronously
    // We will update the react-ui later if needed, but for now we'll overwrite the methods
    // once file is indexed to be synchronous.

    close(): void {
        this._isFileLoaded = false;
        if (this.worker) this.worker.postMessage({ type: 'CLOSE' } as MainToWorkerMessage);
        this.file = null;
        this.queryCache.clear();
        this._cachedMetadata = null;
        this._cachedSignals = null;
        this._cachedHierarchy = null;
    }

    private async sendRpcRequest<T>(type: string, extraArgs: any = {}): Promise<T> {
        if (!this.worker) throw new Error('Worker not initialized');
        return new Promise((resolve, reject) => {
            const requestId = this.nextRequestId++;
            this.pendingRequests.set(requestId, { resolve, reject });
            this.worker!.postMessage({ type, requestId, ...extraArgs } as MainToWorkerMessage);
        });
    }

    private async handleWorkerMessage(e: MessageEvent<WorkerToMainMessage>) {
        const msg = e.data;

        switch (msg.type) {
            case 'INIT_DONE':
                if (msg.success) {
                    this._isReady = true;
                    if (this.initResolve) this.initResolve();
                } else {
                    if (this.initReject) this.initReject(new Error(msg.error || 'Failed to init worker'));
                }
                this.initResolve = null;
                this.initReject = null;
                break;

            case 'INDEX_PROGRESS':
                if (this.indexProgressCb) this.indexProgressCb(msg.bytesRead, msg.totalBytes);
                break;

            case 'INDEX_DONE':
                if (msg.success) {
                    this._isFileLoaded = true;

                    // Pre-fetch metadata synchronously so sync getters work
                    this._cachedMetadata = await this.getMetadata();
                    this._cachedSignals = await this.getSignals();
                    this._cachedHierarchy = await this.getHierarchy();

                    if (this.indexResolve) this.indexResolve(true);
                } else {
                    if (this.indexReject) this.indexReject(new Error(msg.error || 'Failed to index file'));
                }
                this.indexResolve = null;
                this.indexReject = null;
                this.indexProgressCb = null;
                break;

            case 'QUERY_PROGRESS':
                if (this.queryProgressCb) this.queryProgressCb(msg.result);
                break;

            case 'QUERY_DONE':
                if (msg.error) {
                    if (this.queryReject) this.queryReject(new Error(msg.error));
                } else {
                    if (this.queryResolve) this.queryResolve(msg.result);
                }
                this.cleanupQueryCallbacks();
                break;

            // READ_SLICE_REQUEST handler removed

            case 'METADATA_RESULT':
            case 'SIGNALS_RESULT':
            case 'HIERARCHY_RESULT':
            case 'FIND_SIGNAL_RESULT':
                const pending = this.pendingRequests.get(msg.requestId);
                if (pending) {
                    this.pendingRequests.delete(msg.requestId);
                    pending.resolve(msg.data);
                }
                break;
        }
    }

    private cleanupQueryCallbacks() {
        this.queryResolve = null;
        this.queryReject = null;
        this.queryProgressCb = null;
    }
}
