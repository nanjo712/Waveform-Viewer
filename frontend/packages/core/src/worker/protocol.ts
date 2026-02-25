import type { QueryResult } from '../types/vcd.ts';

export type MainToWorkerMessage =
    | { type: 'INIT'; wasmJsUri: string; wasmBinaryUri?: string }
    | { type: 'INDEX_FILE'; file?: File; localPath?: string; fileSize: number }
    | { type: 'QUERY'; tBegin: number; tEnd: number; signalIndices: number[]; pixelTimeStep: number }
    | { type: 'READ_SLICE_RESPONSE'; requestId: number; buffer: ArrayBuffer }
    | { type: 'ABORT_QUERY' }
    | { type: 'GET_METADATA'; requestId: number }
    | { type: 'GET_SIGNALS'; requestId: number }
    | { type: 'GET_HIERARCHY'; requestId: number }
    | { type: 'FIND_SIGNAL'; requestId: number; fullPath: string }
    | { type: 'CLOSE' };

export type WorkerToMainMessage =
    | { type: 'INIT_DONE'; success: boolean; error?: string }
    | { type: 'INDEX_PROGRESS'; bytesRead: number; totalBytes: number }
    | { type: 'INDEX_DONE'; success: boolean; error?: string }
    | { type: 'QUERY_PROGRESS'; result: QueryResult }
    | { type: 'QUERY_DONE'; result: QueryResult; error?: string }
    | { type: 'READ_SLICE_REQUEST'; requestId: number; offset: number; length: number }
    | { type: 'METADATA_RESULT'; requestId: number; data: any }
    | { type: 'SIGNALS_RESULT'; requestId: number; data: any }
    | { type: 'HIERARCHY_RESULT'; requestId: number; data: any }
    | { type: 'FIND_SIGNAL_RESULT'; requestId: number; data: number };
