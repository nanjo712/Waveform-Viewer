/**
 * VcdEngine — core WASM logic decoupled from platform adapters.
 * Designed to run in a Web Worker, receiving a VcdParserModule on init,
 * and using a proxy PlatformFile that delegates readSlice over postMessage.
 */
import type { VcdParserModule, VcdMetadata, SignalDef, ScopeNode, QueryResult } from '../types/vcd.ts';
export declare class VcdEngine {
    private parser;
    module: VcdParserModule;
    constructor(module: VcdParserModule);
    get isReady(): boolean;
    get isFileLoaded(): boolean;
    indexFile(filePath: string, fileSize: number, onProgress?: (bytesRead: number, totalBytes: number) => void): Promise<boolean>;
    query(tBegin: number, tEnd: number, signalIndices: number[], abortSignal?: AbortSignal, pixelTimeStep?: number, onProgress?: (partialResult: QueryResult) => void): Promise<QueryResult>;
    getMetadata(): VcdMetadata;
    getSignals(): SignalDef[];
    getHierarchy(): ScopeNode;
    findSignal(fullPath: string): number;
    close(): void;
    private decodeBinaryResult;
    private assertOpen;
}
