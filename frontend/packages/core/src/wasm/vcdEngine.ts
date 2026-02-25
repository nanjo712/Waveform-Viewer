/**
 * VcdEngine — core WASM logic decoupled from platform adapters.
 * Designed to run in a Web Worker, receiving a VcdParserModule on init,
 * and using a proxy PlatformFile that delegates readSlice over postMessage.
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
import type { PlatformFile } from '../types/platform.ts';

const INDEX_CHUNK_SIZE = 32 * 1024 * 1024;
const QUERY_CHUNK_SIZE = 32 * 1024 * 1024;

const SIZEOF_TRANSITION_1BIT = 16;
const SIZEOF_TRANSITION_MULTIBIT = 24;

const VALUE_MAP = ['0', '1', 'x', 'z'] as const;

export class VcdEngine {
    private parser: VcdParser | null = null;
    private module: VcdParserModule;
    private file: PlatformFile | null = null;
    private chunkBufPtr = 0;
    private chunkBufSize = 0;

    constructor(module: VcdParserModule) {
        this.module = module;
    }

    get isReady(): boolean {
        return !!this.module;
    }

    get isFileLoaded(): boolean {
        return this.parser !== null && this.parser.isOpen();
    }

    async indexFile(
        file: PlatformFile,
        onProgress?: (bytesRead: number, totalBytes: number) => void
    ): Promise<boolean> {
        this.close();
        this.file = file;
        this.parser = new this.module.VcdParser();
        this.ensureChunkBuffer(INDEX_CHUNK_SIZE);
        this.parser.begin_indexing();

        const totalSize = file.size;
        let offset = 0;

        while (offset < totalSize) {
            const end = Math.min(offset + INDEX_CHUNK_SIZE, totalSize);
            const arrayBuf = await file.readSlice(offset, end - offset);
            const chunk = new Uint8Array(arrayBuf);

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

    async query(
        tBegin: number,
        tEnd: number,
        signalIndices: number[],
        abortSignal?: AbortSignal,
        pixelTimeStep = -1.0,
        onProgress?: (partialResult: QueryResult) => void
    ): Promise<QueryResult> {
        this.assertOpen();
        if (!this.file) throw new Error('No file loaded');

        const parser = this.parser!;
        const mod = this.module;

        const safeTBegin = Math.floor(tBegin);
        const safeTEnd = Math.ceil(tEnd);
        const plan = parser.get_query_plan(BigInt(safeTBegin) as unknown as number);
        const fileOffset = Number(plan.file_offset);

        parser.begin_query(
            BigInt(safeTBegin) as unknown as number,
            BigInt(safeTEnd) as unknown as number,
            JSON.stringify(signalIndices),
            plan.snapshot_index,
            pixelTimeStep
        );

        this.ensureChunkBuffer(QUERY_CHUNK_SIZE);
        const totalSize = this.file.size;
        let offset = fileOffset;

        const onAbort = () => parser.cancel_query();
        abortSignal?.addEventListener('abort', onAbort);

        const rollingResult: QueryResult = {
            tBegin,
            tEnd,
            signals: signalIndices.map(idx => ({
                index: idx,
                name: '',
                initialValue: 'x',
                transitions: []
            }))
        };
        let isFirstSlice = true;

        const flushToRolling = () => {
            const rawResult = parser.flush_query_binary();
            const slice = this.decodeBinaryResult(rawResult, mod, tBegin, tEnd, signalIndices);

            let hasNewData = false;
            for (let i = 0; i < slice.signals.length; i++) {
                const s = slice.signals[i];
                const r = rollingResult.signals[i];

                if (isFirstSlice) {
                    r.name = s.name;
                    r.initialValue = s.initialValue;
                }
                if (s.transitions.length > 0) {
                    r.transitions.push(...s.transitions);
                    hasNewData = true;
                }
            }
            isFirstSlice = false;

            if (hasNewData && onProgress) {
                onProgress({ ...rollingResult });
            }
        };

        try {
            while (offset < totalSize) {
                if (abortSignal?.aborted) throw new Error('Query aborted');

                const end = Math.min(offset + QUERY_CHUNK_SIZE, totalSize);
                const arrayBuf = await this.file.readSlice(offset, end - offset);
                const chunk = new Uint8Array(arrayBuf);

                if (abortSignal?.aborted) throw new Error('Query aborted');

                mod.HEAPU8.set(chunk, this.chunkBufPtr);
                const keepGoing = parser.push_chunk_for_query(chunk.byteLength);

                flushToRolling();

                if (!keepGoing) break;
                offset = end;
            }
        } finally {
            abortSignal?.removeEventListener('abort', onAbort);
        }

        flushToRolling();
        return rollingResult;
    }

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
        this.chunkBufPtr = 0;
        this.chunkBufSize = 0;
    }

    private ensureChunkBuffer(size: number): void {
        if (this.chunkBufSize >= size) return;
        this.chunkBufPtr = this.parser!.allocate_chunk_buffer(size);
        this.chunkBufSize = size;
    }

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

        const resultSignals: SignalQueryResult[] = [];
        for (const idx of signalIndices) {
            const entry = signalMap.get(idx);
            if (entry) resultSignals.push(entry);
        }

        return { tBegin, tEnd, signals: resultSignals };
    }

    private assertOpen(): void {
        if (!this.parser || !this.parser.isOpen()) {
            throw new Error('No VCD file is currently loaded');
        }
    }
}
