/**
 * VcdServiceClient — Proxy for VcdEngine running in a Web Worker.
 * Exposes the same public API as the original VcdService, so UI components
 * do not need to change.
 */
import type { VcdMetadata, SignalDef, ScopeNode, QueryResult } from '../types/vcd.ts';
import type { PlatformAdapter, PlatformFile } from '../types/platform.ts';
export declare class VcdServiceClient {
    private worker;
    private adapter;
    private file;
    private _isReady;
    private _isFileLoaded;
    private queryCache;
    private readonly MAX_CACHE_SIZE;
    private initPromise;
    private initResolve;
    private initReject;
    private indexResolve;
    private indexReject;
    private indexProgressCb;
    private queryResolve;
    private queryReject;
    private queryProgressCb;
    private nextRequestId;
    private pendingRequests;
    constructor(adapter: PlatformAdapter);
    init(): Promise<void>;
    get isReady(): boolean;
    get isFileLoaded(): boolean;
    indexFile(file: PlatformFile, onProgress?: (bytesRead: number, totalBytes: number) => void): Promise<boolean>;
    query(tBegin: number, tEnd: number, signalIndices: number[], abortSignal?: AbortSignal, pixelTimeStep?: number, onProgress?: (partialResult: QueryResult) => void): Promise<QueryResult>;
    getMetadata(): Promise<VcdMetadata>;
    getSignals(): Promise<SignalDef[]>;
    getHierarchy(): Promise<ScopeNode>;
    findSignal(fullPath: string): Promise<number>;
    private _cachedMetadata;
    private _cachedSignals;
    private _cachedHierarchy;
    getMetadataSync(): VcdMetadata;
    getSignalsSync(): SignalDef[];
    getHierarchySync(): ScopeNode;
    findSignalSync(fullPath: string): number;
    close(): void;
    private sendRpcRequest;
    private handleWorkerMessage;
    private cleanupQueryCallbacks;
}
