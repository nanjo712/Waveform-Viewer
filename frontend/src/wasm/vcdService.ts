import type {
    VcdParser,
    VcdParserModule,
    VcdMetadata,
    SignalDef,
    ScopeNode,
    QueryResult,
    SignalQueryResult,
} from '../types/vcd';

type CreateVcdParser = () => Promise<VcdParserModule>;

declare global {
    // The Emscripten-generated UMD script sets this on the global scope.
    // eslint-disable-next-line no-var
    var createVcdParser: CreateVcdParser | undefined;
}

let modulePromise: Promise<VcdParserModule> | null = null;

/** Default chunk size for reading files: 4 MB */
const INDEX_CHUNK_SIZE = 4 * 1024 * 1024;
/** Query chunk size: 4 MB */
const QUERY_CHUNK_SIZE = 4 * 1024 * 1024;

/**
 * Load the Emscripten JS glue via a <script> tag (it's UMD, not ESM).
 * The script defines `window.createVcdParser` which we then call.
 */
function loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
        document.head.appendChild(script);
    });
}

/**
 * Lazily loads the WASM module. Subsequent calls return the same promise.
 */
export async function loadWasmModule(): Promise<VcdParserModule> {
    if (!modulePromise) {
        modulePromise = (async () => {
            // Load the Emscripten-generated JS glue via <script> tag.
            await loadScript('./wasm/vcd_parser.js');
            const createFn = globalThis.createVcdParser;
            if (!createFn) {
                throw new Error('createVcdParser not found on globalThis after loading script');
            }
            return await createFn();
        })();
    }
    return modulePromise;
}

// ── Binary struct sizes (must match C++ alignas(8) structs) ─────────

/** sizeof(Transition1Bit): u64 timestamp + u32 signal_index + u8 value + 3 pad = 16 */
const SIZEOF_TRANSITION_1BIT = 16;
/** sizeof(TransitionMultiBit): u64 timestamp + u32 signal_index + u32 string_offset + u32 string_length + u32 pad = 24 */
const SIZEOF_TRANSITION_MULTIBIT = 24;

const VALUE_MAP = ['0', '1', 'x', 'z'] as const;

/**
 * High-level wrapper around the WASM VcdParser.
 *
 * Two-phase architecture:
 *   1. Indexing: read entire file in chunks, build signal hierarchy + sparse snapshots.
 *   2. Query: given time range + signals, seek to nearest snapshot, stream chunks until done.
 */
export class VcdService {
    private parser: VcdParser | null = null;
    private module: VcdParserModule | null = null;
    /** The File object is retained so we can seek-and-read for queries. */
    private file: File | null = null;
    /** WASM-side chunk buffer pointer (pre-allocated). */
    private chunkBufPtr = 0;
    /** Current size of the WASM-side chunk buffer. */
    private chunkBufSize = 0;

    async init(): Promise<void> {
        this.module = await loadWasmModule();
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
     * Index a VCD file: reads the File in chunks via the File API,
     * feeds each chunk to the WASM parser for indexing.
     *
     * @param file  The File object (retained for later query seeks).
     * @param onProgress  Optional callback with bytes read so far.
     * @returns true if the file was parsed and opened successfully.
     */
    async indexFile(
        file: File,
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
            const blob = file.slice(offset, end);
            const arrayBuf = await blob.arrayBuffer();
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
     *
     * Internally:
     *   1. get_query_plan(tBegin) -> { file_offset, snapshot_index }
     *   2. Seek file to file_offset
     *   3. begin_query(tBegin, tEnd, indices, snapshot_index)
     *   4. Read file in chunks from file_offset, push_chunk_for_query()
     *      until it returns false (early-stop: current_time > tEnd)
     *   5. finish_query_binary() -> decode binary structs into QueryResult
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
        // get_query_plan expects uint64_t → pass BigInt
        // Floor/ceil to ensure we always cover the requested range even when
        // zoom/pan arithmetic produces fractional timestamps.
        const safeTBegin = Math.floor(tBegin);
        const safeTEnd = Math.ceil(tEnd);
        const plan = parser.get_query_plan(BigInt(safeTBegin) as unknown as number);

        // Convert BigInt fields back to number for JS consumption
        const fileOffset = Number(plan.file_offset);

        // Step 2: Begin query with snapshot restoration
        // begin_query expects uint64_t start_time, end_time → pass BigInt
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
            const blob = this.file.slice(offset, end);
            const arrayBuf = await blob.arrayBuffer();
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
     * Calls allocate_chunk_buffer() which allocates in the WASM heap.
     */
    private ensureChunkBuffer(size: number): void {
        if (this.chunkBufSize >= size) return;
        this.chunkBufPtr = this.parser!.allocate_chunk_buffer(size);
        this.chunkBufSize = size;
    }

    /**
     * Decode the binary result from finish_query_binary() into a
     * high-level QueryResult that the rendering layer understands.
     *
     * Binary layout (from C++):
     *   Transition1Bit (16 bytes each, alignas 8):
     *     u64 timestamp, u32 signal_index, u8 value, u8[3] padding
     *   TransitionMultiBit (24 bytes each, alignas 8):
     *     u64 timestamp, u32 signal_index, u32 string_offset, u32 string_length, u32 padding
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
            // Read u64 timestamp as two u32s (little-endian WASM)
            const tsLow = dataView.getUint32(base, true);
            const tsHigh = dataView.getUint32(base + 4, true);
            const timestamp = tsLow + tsHigh * 0x100000000;
            const signalIndex = dataView.getUint32(base + 8, true);
            const value = heap[base + 12];

            const entry = signalMap.get(signalIndex);
            if (!entry) continue;

            if (timestamp <= tBegin) {
                // Pre-window or at-boundary: update initial value
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

            // Read value string from the string pool
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
