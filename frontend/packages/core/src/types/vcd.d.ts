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
    uiSignals?: {
        index: number;
        name: string;
    }[];
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
    close(): void;
    isOpen(): boolean;
    delete(): void;
    allocate_chunk_buffer(size: number): number;
    begin_indexing(): void;
    push_chunk_for_index(size: number, global_file_offset: number): boolean;
    finish_indexing(): void;
    get_query_plan(start_time: number): QueryPlan;
    begin_query(start_time: number, end_time: number, indicesJSON: string, snapshot_index: number): void;
    push_chunk_for_query(size: number): boolean;
    finish_query_binary(): QueryResultBinaryRaw;
    getDate(): string;
    getVersion(): string;
    getTimescaleMagnitude(): number;
    getTimescaleUnit(): string;
    getTimeBegin(): number;
    getTimeEnd(): number;
    getSignalCount(): number;
    getSnapshotCount(): number;
    getIndexMemoryUsage(): number;
    getSignalsJSON(): string;
    getHierarchyJSON(): string;
    findSignal(fullPath: string): number;
}
export interface VcdParserModule {
    VcdParser: new () => VcdParser;
    /** WASM linear memory (for reading binary query results) */
    HEAPU8: Uint8Array;
}
export interface VcdMetadata {
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
