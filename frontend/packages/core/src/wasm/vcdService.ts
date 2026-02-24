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

import type {
    VcdParser,
    VcdParserModule,
    VcdMetadata,
    SignalDef,
    ScopeNode,
    QueryResult,
    SignalQueryResult,
} from '../types/vcd.ts';
import type { PlatformAdapter, PlatformFile } from '../types/platform.ts';

/** Default chunk size for reading files: 32 MB */
const INDEX_CHUNK_SIZE = 32 * 1024 * 1024;
/** Query chunk size: 32 MB */
const QUERY_CHUNK_SIZE = 32 * 1024 * 1024;

// ── Binary struct sizes (must match C++ alignas(8) structs) ─────────

/** sizeof(Transition1Bit): u64 timestamp + u32 signal_index + u8 value + 3 pad = 16 */
const SIZEOF_TRANSITION_1BIT = 16;
/** sizeof(TransitionMultiBit): u64 timestamp + u32 signal_index + u32 string_offset + u32 string_length + u32 pad = 24 */
const SIZEOF_TRANSITION_MULTIBIT = 24;

const VALUE_MAP = ['0', '1', 'x', 'z'] as const;

export class VcdService {
    private parser: VcdParser | null = null;
    private module: VcdParserModule | null = null;
    /** The PlatformFile handle is retained so we can seek-and-read for queries. */
    private file: PlatformFile | null = null;
    /** WASM-side chunk buffer pointer (pre-allocated). */
    private chunkBufPtr = 0;
    /** Current size of the WASM-side chunk buffer. */
    private chunkBufSize = 0;
    /** Platform adapter for WASM loading. */
    private adapter: PlatformAdapter;

    constructor(adapter: PlatformAdapter) {
        this.adapter = adapter;
    }

    async init(): Promise<void> {
        this.module = await this.adapter.loadWasmModule();
    }

    get isReady(): boolean {
        return this.module !== null;
    }

    get isFileLoaded(): boolean {
        return this.parser !== null && this.parser.isOpen();
    }

    // ================================================================
    // Phase 1: Indexing
    // ================================================================

    /**
     * Index a VCD file: reads the PlatformFile in chunks,
     * feeds each chunk to the WASM parser for indexing.
     *
     * @param file  The PlatformFile handle (retained for later query seeks).
     * @param onProgress  Optional callback with bytes read so far.
     * @returns true if the file was parsed and opened successfully.
     */
    async indexFile(
        file: PlatformFile,
        onProgress?: (bytesRead: number, totalBytes: number) => void
    ): Promise<boolean> {
        if (!this.module) throw new Error('WASM module not loaded');

        // Clean up any previous file
        this.close();

        this.file = file;
        this.parser = new this.module.VcdParser();

        // Ensure the WASM-side buffer is large enough
        this.ensureChunkBuffer(INDEX_CHUNK_SIZE);

        this.parser.begin_indexing();

        const totalSize = file.size;
        let offset = 0;

        while (offset < totalSize) {
            const end = Math.min(offset + INDEX_CHUNK_SIZE, totalSize);
            const arrayBuf = await file.readSlice(offset, end - offset);
            const chunk = new Uint8Array(arrayBuf);

            // Copy chunk data into WASM heap
            this.module.HEAPU8.set(chunk, this.chunkBufPtr);

            this.parser.push_chunk_for_index(chunk.byteLength, BigInt(offset) as unknown as number);

            offset = end;
            onProgress?.(offset, totalSize);
        }

        this.parser.finish_indexing();

        if (!this.parser.isOpen()) {
            this.close();
            return false;
        }

        return true;
    }

    // ================================================================
    // Phase 2: Query
    // ================================================================

    /**
     * Query waveform data for a time range and set of signal indices.
     */
    async query(
        tBegin: number,
        tEnd: number,
        signalIndices: number[]
    ): Promise<QueryResult> {
        this.assertOpen();
        if (!this.file || !this.module) {
            throw new Error('No file loaded');
        }

        const parser = this.parser!;
        const mod = this.module;

        // Step 1: Get query plan
        const safeTBegin = Math.floor(tBegin);
        const safeTEnd = Math.ceil(tEnd);
        const plan = parser.get_query_plan(BigInt(safeTBegin) as unknown as number);

        // Convert BigInt fields back to number for JS consumption
        const fileOffset = Number(plan.file_offset);

        // Step 2: Begin query with snapshot restoration
        parser.begin_query(
            BigInt(safeTBegin) as unknown as number,
            BigInt(safeTEnd) as unknown as number,
            JSON.stringify(signalIndices),
            plan.snapshot_index
        );

        // Step 3: Stream chunks from the file starting at plan.file_offset
        this.ensureChunkBuffer(QUERY_CHUNK_SIZE);

        const totalSize = this.file.size;
        let offset = fileOffset;

        while (offset < totalSize) {
            const end = Math.min(offset + QUERY_CHUNK_SIZE, totalSize);
            const arrayBuf = await this.file.readSlice(offset, end - offset);
            const chunk = new Uint8Array(arrayBuf);

            // Copy into WASM heap
            mod.HEAPU8.set(chunk, this.chunkBufPtr);

            const keepGoing = parser.push_chunk_for_query(chunk.byteLength);
            if (!keepGoing) {
                // Early stop: parser has seen a timestamp beyond tEnd
                break;
            }

            offset = end;
        }

        // Step 4: Finalize and decode binary results
        const rawResult = parser.finish_query_binary();
        return this.decodeBinaryResult(
            rawResult,
            mod,
            tBegin,
            tEnd,
            signalIndices
        );
    }

    // ================================================================
    // Metadata & hierarchy accessors
    // ================================================================

    getMetadata(): VcdMetadata {
        this.assertOpen();
        const p = this.parser!;
        return {
            date: p.getDate(),
            version: p.getVersion(),
            timescaleMagnitude: p.getTimescaleMagnitude(),
            timescaleUnit: p.getTimescaleUnit(),
            timeBegin: Number(p.getTimeBegin()),
            timeEnd: Number(p.getTimeEnd()),
            signalCount: p.getSignalCount(),
            snapshotCount: p.getSnapshotCount(),
            indexMemoryUsage: p.getIndexMemoryUsage(),
        };
    }

    getSignals(): SignalDef[] {
        this.assertOpen();
        return JSON.parse(this.parser!.getSignalsJSON()) as SignalDef[];
    }

    getHierarchy(): ScopeNode {
        this.assertOpen();
        return JSON.parse(this.parser!.getHierarchyJSON()) as ScopeNode;
    }

    findSignal(fullPath: string): number {
        this.assertOpen();
        return this.parser!.findSignal(fullPath);
    }

    close(): void {
        if (this.parser) {
            this.parser.close();
            this.parser.delete();
            this.parser = null;
        }
        this.file = null;
        // Note: chunkBufPtr is owned by the WASM parser instance (freed on close)
        this.chunkBufPtr = 0;
        this.chunkBufSize = 0;
    }

    // ================================================================
    // Private helpers
    // ================================================================

    /**
     * Ensure the WASM-side chunk buffer is at least `size` bytes.
     */
    private ensureChunkBuffer(size: number): void {
        if (this.chunkBufSize >= size) return;
        this.chunkBufPtr = this.parser!.allocate_chunk_buffer(size);
        this.chunkBufSize = size;
    }

    /**
     * Decode the binary result from finish_query_binary() into a
     * high-level QueryResult that the rendering layer understands.
     */
    private decodeBinaryResult(
        raw: { ptr1Bit: number; count1Bit: number; ptrMulti: number; countMulti: number; ptrStringPool: number; countStringPool: number },
        mod: VcdParserModule,
        tBegin: number,
        tEnd: number,
        signalIndices: number[]
    ): QueryResult {
        const heap = mod.HEAPU8;
        const dataView = new DataView(heap.buffer);
        const allSignals: SignalDef[] = JSON.parse(this.parser!.getSignalsJSON());

        // Build per-signal result containers, keyed by signal index
        const signalMap = new Map<number, SignalQueryResult>();
        for (const idx of signalIndices) {
            const sig = allSignals[idx];
            signalMap.set(idx, {
                index: idx,
                name: sig?.fullPath ?? `signal_${idx}`,
                initialValue: sig?.width === 1 ? 'x' : 'bx',
                transitions: [],
            });
        }

        // Decode 1-bit transitions
        for (let i = 0; i < raw.count1Bit; i++) {
            const base = raw.ptr1Bit + i * SIZEOF_TRANSITION_1BIT;
            const tsLow = dataView.getUint32(base, true);
            const tsHigh = dataView.getUint32(base + 4, true);
            const timestamp = tsLow + tsHigh * 0x100000000;
            const signalIndex = dataView.getUint32(base + 8, true);
            const value = heap[base + 12];

            const entry = signalMap.get(signalIndex);
            if (!entry) continue;

            if (timestamp <= tBegin) {
                entry.initialValue = VALUE_MAP[value] ?? 'x';
                entry.transitions = [];
            } else {
                entry.transitions.push([timestamp, VALUE_MAP[value] ?? 'x']);
            }
        }

        // Decode multi-bit transitions
        const textDecoder = new TextDecoder();
        for (let i = 0; i < raw.countMulti; i++) {
            const base = raw.ptrMulti + i * SIZEOF_TRANSITION_MULTIBIT;
            const tsLow = dataView.getUint32(base, true);
            const tsHigh = dataView.getUint32(base + 4, true);
            const timestamp = tsLow + tsHigh * 0x100000000;
            const signalIndex = dataView.getUint32(base + 8, true);
            const strOffset = dataView.getUint32(base + 12, true);
            const strLength = dataView.getUint32(base + 16, true);

            const entry = signalMap.get(signalIndex);
            if (!entry) continue;

            const strBytes = heap.subarray(
                raw.ptrStringPool + strOffset,
                raw.ptrStringPool + strOffset + strLength
            );
            const valStr = textDecoder.decode(strBytes);

            if (timestamp <= tBegin) {
                entry.initialValue = valStr;
                entry.transitions = [];
            } else {
                entry.transitions.push([timestamp, valStr]);
            }
        }

        // Build the result in the same order as the input indices
        const resultSignals: SignalQueryResult[] = [];
        for (const idx of signalIndices) {
            const entry = signalMap.get(idx);
            if (entry) resultSignals.push(entry);
        }

        return {
            tBegin,
            tEnd,
            signals: resultSignals,
        };
    }

    private assertOpen(): void {
        if (!this.parser || !this.parser.isOpen()) {
            throw new Error('No VCD file is currently loaded');
        }
    }
}
