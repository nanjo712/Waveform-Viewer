/**
 * TypeScript declarations for VCD Parser WebAssembly module.
 *
 * Usage:
 *   import createVcdParser from './vcd_parser.js';
 *   const Module = await createVcdParser();
 *   const parser = new Module.VcdParser();
 */

/** Signal definition */
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

/** VcdParser WASM class (Embind) */
export interface VcdParser {
  /** Parse VCD data. Pass file contents as a string. */
  parse(data: string, chunkSize: number): boolean;

  /** Close and release all resources. */
  close(): void;

  /** Whether a file is currently parsed. */
  isOpen(): boolean;

  // --- Metadata ---

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

  // --- Signal list & hierarchy ---

  /** Returns JSON string; parse with JSON.parse() to get SignalDef[] */
  getSignalsJSON(): string;

  /** Returns JSON string; parse with JSON.parse() to get ScopeNode */
  getHierarchyJSON(): string;

  // --- Queries ---

  /**
   * Query signal values within a time range by signal indices.
   * @param tBegin  Start time (inclusive)
   * @param tEnd    End time (inclusive)
   * @param indicesJSON  JSON array of signal indices, e.g. "[0,2,5]"
   * @returns JSON string; parse with JSON.parse() to get QueryResult
   */
  query(tBegin: number, tEnd: number, indicesJSON: string): string;

  /**
   * Query signal values within a time range by signal paths.
   * @param tBegin  Start time (inclusive)
   * @param tEnd    End time (inclusive)
   * @param pathsJSON  JSON array of signal paths, e.g. '["top.clk","top.cpu.data"]'
   * @returns JSON string; parse with JSON.parse() to get QueryResult
   */
  queryByPaths(tBegin: number, tEnd: number, pathsJSON: string): string;

  /**
   * Find signal index by full hierarchical path.
   * @returns Signal index, or -1 if not found.
   */
  findSignal(fullPath: string): number;

  /** Release Embind handle (call when done with this object). */
  delete(): void;
}

/** VcdParser constructor on the Module */
export interface VcdParserConstructor {
  new (): VcdParser;
}

/** The Emscripten Module returned by createVcdParser() */
export interface VcdParserModule {
  VcdParser: VcdParserConstructor;
}

/**
 * Factory function that loads the WASM module.
 * @returns Promise that resolves to the Module with VcdParser class.
 */
declare function createVcdParser(): Promise<VcdParserModule>;
export default createVcdParser;
