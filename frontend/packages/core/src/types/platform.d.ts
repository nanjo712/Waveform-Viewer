import type { VcdParserModule } from './vcd.ts';
/**
 * Abstract file handle for chunk-based reading.
 * Wraps platform-specific file access (browser File API, Node fs, VSCode workspace.fs, etc.)
 */
export interface PlatformFile {
    readonly name: string;
    readonly size: number;
    /** Read a slice of bytes from the file at the given offset. */
    readSlice(offset: number, length: number): Promise<ArrayBuffer>;
}
/**
 * Platform abstraction layer.
 *
 * Each deployment target (web, Tauri, VSCode extension) provides its own
 * implementation of this interface.  The core VcdService, React UI, and
 * state management code operate exclusively through this interface,
 * ensuring zero direct platform dependencies.
 */
export interface PlatformAdapter {
    /** Platform identifier for conditional UI behavior. */
    readonly platformName: 'web' | 'tauri' | 'vscode';
    /** Create a Web Worker instance for the VcdEngine. */
    createWorker(): Worker;
    /** Get the URIs needed by the worker to load WASM. */
    getWasmConfig(): {
        jsUri: string;
        binaryUri?: string;
    };
    /** Load the WASM module and return the Emscripten module instance (deprecated in favor of worker). */
    loadWasmModule(): Promise<VcdParserModule>;
    /**
     * Open a file picker dialog and return a PlatformFile handle.
     * Returns null if the user cancels the dialog.
     */
    pickFile(options?: {
        extensions?: string[];
    }): Promise<PlatformFile | null>;
    /**
     * Wrap a native file object (e.g. browser File from drag-and-drop)
     * into a PlatformFile handle.
     * Returns null if the native object is not supported on this platform.
     */
    wrapNativeFile?(nativeFile: unknown): PlatformFile | null;
    /**
     * Pick and load an external format plugin script.
     * The adapter handles file picking (if applicable) and script execution.
     * The plugin is expected to call `globalThis.WaveformViewer.registerPlugin()`.
     * Not all platforms may support this.
     */
    loadPlugin?(): Promise<void>;
}
