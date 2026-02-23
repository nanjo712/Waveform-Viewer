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

/** VcdParser WASM class instance */
export interface VcdParser {
    parse(data: string, chunkSize: number): boolean;
    close(): void;
    isOpen(): boolean;
    getDate(): string;
    getVersion(): string;
    getTimescaleMagnitude(): number;
    getTimescaleUnit(): string;
    getTimeBegin(): number;
    getTimeEnd(): number;
    getSignalCount(): number;
    getChunkCount(): number;
    getTotalTransitions(): number;
    getFileSize(): number;
    getSignalsJSON(): string;
    getHierarchyJSON(): string;
    query(tBegin: number, tEnd: number, indicesJSON: string): string;
    queryByPaths(tBegin: number, tEnd: number, pathsJSON: string): string;
    findSignal(fullPath: string): number;
    delete(): void;
}

export interface VcdParserModule {
    VcdParser: new () => VcdParser;
}

export interface VcdMetadata {
    date: string;
    version: string;
    timescaleMagnitude: number;
    timescaleUnit: string;
    timeBegin: number;
    timeEnd: number;
    signalCount: number;
    chunkCount: number;
    totalTransitions: number;
    fileSize: number;
}
