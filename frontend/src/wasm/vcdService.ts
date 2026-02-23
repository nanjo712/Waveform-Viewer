import type {
  VcdParser,
  VcdParserModule,
  VcdMetadata,
  SignalDef,
  ScopeNode,
  QueryResult,
} from '../types/vcd';

type CreateVcdParser = () => Promise<VcdParserModule>;

declare global {
  // The Emscripten-generated UMD script sets this on the global scope.
  // eslint-disable-next-line no-var
  var createVcdParser: CreateVcdParser | undefined;
}

let modulePromise: Promise<VcdParserModule> | null = null;

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
      // The .js and .wasm files are served from /wasm/ via Vite's public dir.
      await loadScript('/wasm/vcd_parser.js');
      const createFn = globalThis.createVcdParser;
      if (!createFn) {
        throw new Error('createVcdParser not found on globalThis after loading script');
      }
      return await createFn();
    })();
  }
  return modulePromise;
}

/**
 * High-level wrapper around the WASM VcdParser that provides
 * typed return values (JSON is parsed automatically).
 */
export class VcdService {
  private parser: VcdParser | null = null;
  private module: VcdParserModule | null = null;

  async init(): Promise<void> {
    this.module = await loadWasmModule();
  }

  get isReady(): boolean {
    return this.module !== null;
  }

  get isFileLoaded(): boolean {
    return this.parser !== null && this.parser.isOpen();
  }

  /**
   * Parse a VCD file from an ArrayBuffer.
   */
  parseFile(buffer: ArrayBuffer, chunkSize = 10000): boolean {
    if (!this.module) throw new Error('WASM module not loaded');

    // Clean up any previously loaded file
    this.close();

    this.parser = new this.module.VcdParser();
    const decoder = new TextDecoder();
    const text = decoder.decode(buffer);
    return this.parser.parse(text, chunkSize);
  }

  close(): void {
    if (this.parser) {
      this.parser.close();
      this.parser.delete();
      this.parser = null;
    }
  }

  getMetadata(): VcdMetadata {
    this.assertOpen();
    const p = this.parser!;
    return {
      date: p.getDate(),
      version: p.getVersion(),
      timescaleMagnitude: p.getTimescaleMagnitude(),
      timescaleUnit: p.getTimescaleUnit(),
      timeBegin: p.getTimeBegin(),
      timeEnd: p.getTimeEnd(),
      signalCount: p.getSignalCount(),
      chunkCount: p.getChunkCount(),
      totalTransitions: p.getTotalTransitions(),
      fileSize: p.getFileSize(),
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

  query(
    tBegin: number,
    tEnd: number,
    signalIndices: number[]
  ): QueryResult {
    this.assertOpen();
    const json = this.parser!.query(
      tBegin,
      tEnd,
      JSON.stringify(signalIndices)
    );
    return JSON.parse(json) as QueryResult;
  }

  findSignal(fullPath: string): number {
    this.assertOpen();
    return this.parser!.findSignal(fullPath);
  }

  private assertOpen(): void {
    if (!this.parser || !this.parser.isOpen()) {
      throw new Error('No VCD file is currently loaded');
    }
  }
}
