/**
 * VcdService — high-level wrapper around the WASM VcdParser.
 *
 * Refactored to use PlatformAdapter for WASM loading and PlatformFile for
 * file I/O, making it fully platform-agnostic (no DOM, no browser File API).
 *
 * Two-phase architecture:
 *   1. Indexing: read entire file in chunks, build signal hierarchy + sparse snapshots.
 *   2. Query: given time range + signals, seek to nearest snapshot, stream chunks until done.
 */
import type { VcdMetadata, SignalDef, ScopeNode, QueryResult } from '../types/vcd.ts';
import type { PlatformAdapter, PlatformFile } from '../types/platform.ts';
export declare class VcdService {
    private parser;
    private module;
    /** The PlatformFile handle is retained so we can seek-and-read for queries. */
    private file;
    /** WASM-side chunk buffer pointer (pre-allocated). */
    private chunkBufPtr;
    /** Current size of the WASM-side chunk buffer. */
    private chunkBufSize;
    /** Platform adapter for WASM loading. */
    private adapter;
    /** LRU Cache for query results */
    private queryCache;
    private readonly MAX_CACHE_SIZE;
    constructor(adapter: PlatformAdapter);
    init(): Promise<void>;
    get isReady(): boolean;
    get isFileLoaded(): boolean;
    /**
     * Index a VCD file: reads the PlatformFile in chunks,
     * feeds each chunk to the WASM parser for indexing.
     *
     * @param file  The PlatformFile handle (retained for later query seeks).
     * @param onProgress  Optional callback with bytes read so far.
     * @returns true if the file was parsed and opened successfully.
     */
    indexFile(file: PlatformFile, onProgress?: (bytesRead: number, totalBytes: number) => void): Promise<boolean>;
    /**
     * Query waveform data for a time range and set of signal indices.
     */
    query(tBegin: number, tEnd: number, signalIndices: number[], abortSignal?: AbortSignal): Promise<QueryResult>;
    getMetadata(): VcdMetadata;
    getSignals(): SignalDef[];
    getHierarchy(): ScopeNode;
    findSignal(fullPath: string): number;
    close(): void;
    /**
     * Ensure the WASM-side chunk buffer is at least `size` bytes.
     */
    private ensureChunkBuffer;
    /**
     * Decode the binary result from finish_query_binary() into a
     * high-level QueryResult that the rendering layer understands.
     */
    private decodeBinaryResult;
    private assertOpen;
}
