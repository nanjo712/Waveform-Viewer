/** Signal definition from VCD parser */
export interface SignalDef {
    name: string;
    fullPath: string;
    idCode: string;
    width: number;
    index: number;
    type: string;
    msb?: number;
    lsb?: number;
}

/** Scope hierarchy node */
export interface ScopeNode {
    name: string;
    fullPath: string;
    signals?: number[];
    children?: ScopeNode[];
    uiSignals?: { index: number; name: string }[];
}

/** A single transition: [timestamp, value] */
export type TransitionEntry = [number, string];

/** Query result for a single signal */
export interface SignalQueryResult {
    index: number;
    name: string;
    initialValue: string;
    transitions: TransitionEntry[];
}

/** Full query result */
export interface QueryResult {
    tBegin: number;
    tEnd: number;
    signals: SignalQueryResult[];
}

/** Query plan returned by get_query_plan() */
export interface QueryPlan {
    file_offset: number;
    snapshot_time: number;
    snapshot_index: number;
}

/** Binary query result raw pointers from WASM */
export interface QueryResultBinaryRaw {
    ptr1Bit: number;
    count1Bit: number;
    ptrMulti: number;
    countMulti: number;
    ptrStringPool: number;
    countStringPool: number;
}

/**
 * VcdParser WASM class instance — two-phase API.
 *
 * Phase 1 — Indexing:
 *   allocate_chunk_buffer() -> begin_indexing() ->
 *   push_chunk_for_index() loop -> finish_indexing()
 *
 * Phase 2 — Query:
 *   get_query_plan() -> begin_query() ->
 *   push_chunk_for_query() loop -> finish_query_binary()
 */
export interface VcdParser {
    /* Lifecycle */
    close(): void;
    isOpen(): boolean;
    delete(): void;

    /* File I/O */
    open_file(filepath: string): boolean;
    close_file(): void;

    /* Indexing phase */
    begin_indexing(): void;
    index_step(chunk_size: number): number;
    finish_indexing(): void;

    /* Query phase */
    get_query_plan(start_time: number): QueryPlan;
    begin_query(
        start_time: number,
        end_time: number,
        indicesJSON: string,
        snapshot_index: number,
        pixel_time_step: number
    ): void;
    query_step(chunk_size: number): boolean;
    cancel_query(): void;
    flush_query_binary(): QueryResultBinaryRaw;

    /* Metadata accessors */
    getDate(): string;
    getVersion(): string;
    getTimescaleMagnitude(): number;
    getTimescaleUnit(): string;
    getTimeBegin(): number;
    getTimeEnd(): number;
    getSignalCount(): number;
    getSnapshotCount(): number;
    getIndexMemoryUsage(): number;

    /* Signal / hierarchy */
    getSignalsJSON(): string;
    getHierarchyJSON(): string;
    findSignal(fullPath: string): number;
}

export interface FstParser extends VcdParser { }

export interface WaveformParserModule {
    VcdParser: new () => VcdParser;
    FstParser: new () => FstParser;
    /** WASM linear memory (for reading binary query results) */
    HEAPU8: Uint8Array;
    /** Emscripten File System API */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    FS: any;
}

export interface WaveformMetadata {
    date: string;
    version: string;
    timescaleMagnitude: number;
    timescaleUnit: string;
    timeBegin: number;
    timeEnd: number;
    signalCount: number;
    snapshotCount: number;
    indexMemoryUsage: number;
}
