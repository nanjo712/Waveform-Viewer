/**
 * VcdEngine — core WASM logic decoupled from platform adapters.
 * Designed to run in a Web Worker, receiving a VcdParserModule on init,
 * and using a proxy PlatformFile that delegates readSlice over postMessage.
 */
import type { WaveformParserModule, WaveformMetadata, SignalDef, ScopeNode, QueryResult } from '../types/waveform.ts';
export declare class WaveformEngine {
    private parser;
    module: WaveformParserModule;
    private fileExtension;
    constructor(module: WaveformParserModule);
    get isReady(): boolean;
    get isFileLoaded(): boolean;
    indexFile(filePath: string, fileSize: number, onProgress?: (bytesRead: number, totalBytes: number) => void): Promise<boolean>;
    query(tBegin: number, tEnd: number, signalIndices: number[], abortSignal?: AbortSignal, pixelTimeStep?: number, onProgress?: (partialResult: QueryResult) => void): Promise<QueryResult>;
    getMetadata(): WaveformMetadata;
    getSignals(): SignalDef[];
    getHierarchy(): ScopeNode;
    findSignal(fullPath: string): number;
    close(): void;
    private decodeBinaryResult;
    private assertOpen;
}
