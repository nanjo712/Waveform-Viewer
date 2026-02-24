/**
 * VSCode Webview PlatformAdapter.
 *
 * WASM loading: fetches the Emscripten JS glue from a webview URI provided
 *   by the extension host via postMessage, then calls globalThis.createVcdParser()
 *   with the binary URI override.
 *
 * File I/O: sends file slice requests to the extension host via postMessage,
 *   receives ArrayBuffer responses.
 *
 * File picking: not supported (VSCode handles file opening natively).
 * Plugin loading: not supported in webview context.
 */

import type {
    PlatformAdapter,
    PlatformFile,
    VcdParserModule,
} from '@waveform-viewer/core';
import type {
    HostToWebviewMessage,
    WebviewToHostMessage,
} from '../protocol.ts';

// Acquire the VSCode webview API (available globally in webview context)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vscode = (globalThis as any).acquireVsCodeApi?.() as {
    postMessage(msg: WebviewToHostMessage): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getState(): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setState(state: any): void;
} | undefined;

type CreateVcdParser = (opts?: { locateFile?: (path: string) => string }) => Promise<VcdParserModule>;

declare global {
    // The Emscripten-generated script sets this on the global scope.
    // eslint-disable-next-line no-var
    var createVcdParser: CreateVcdParser | undefined;
}

// ── Pending file slice requests ────────────────────────────────────

let nextRequestId = 1;
const pendingSliceRequests = new Map<number, {
    resolve: (data: ArrayBuffer) => void;
    reject: (err: Error) => void;
}>();

// ── VSCode PlatformFile implementation (message-passing I/O) ───────

class VscodePlatformFile implements PlatformFile {
    readonly name: string;
    readonly size: number;

    constructor(name: string, size: number) {
        this.name = name;
        this.size = size;
    }

    readSlice(offset: number, length: number): Promise<ArrayBuffer> {
        return new Promise((resolve, reject) => {
            if (!vscode) {
                reject(new Error('VSCode API not available'));
                return;
            }
            const requestId = nextRequestId++;
            pendingSliceRequests.set(requestId, { resolve, reject });
            vscode.postMessage({
                type: 'fileSliceRequest',
                requestId,
                offset,
                length,
            });
        });
    }
}

// ── Message listener for incoming host messages ────────────────────

type MessageHandler = (msg: HostToWebviewMessage) => void;
const messageHandlers: MessageHandler[] = [];

export function onHostMessage(handler: MessageHandler): () => void {
    messageHandlers.push(handler);
    // Return an unregister function for cleanup
    return () => {
        const idx = messageHandlers.indexOf(handler);
        if (idx >= 0) {
            messageHandlers.splice(idx, 1);
        }
    };
}

// Set up the global message listener
window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
    const msg = event.data;

    // Handle file slice responses internally
    if (msg.type === 'fileSliceResponse') {
        const pending = pendingSliceRequests.get(msg.requestId);
        if (pending) {
            pendingSliceRequests.delete(msg.requestId);
            pending.resolve(msg.data);
        }
        return;
    }

    // Forward all other messages to registered handlers
    for (const handler of messageHandlers) {
        handler(msg);
    }
});

// ── Adapter ────────────────────────────────────────────────────────

let modulePromise: Promise<VcdParserModule> | null = null;
let wasmConfig: { jsUri: string; binaryUri: string } | null = null;

/** Called when the extension host sends the init message with WASM URIs */
export function setWasmConfig(jsUri: string, binaryUri: string): void {
    wasmConfig = { jsUri, binaryUri };
}

/** Create a PlatformFile from file info sent by the extension host */
export function createPlatformFile(name: string, size: number): PlatformFile {
    return new VscodePlatformFile(name, size);
}

/** Send a postMessage to the extension host */
export function postToHost(msg: WebviewToHostMessage): void {
    vscode?.postMessage(msg);
}

export class VscodePlatformAdapter implements PlatformAdapter {
    readonly platformName = 'vscode' as const;

    async loadWasmModule(): Promise<VcdParserModule> {
        if (!modulePromise) {
            modulePromise = (async () => {
                if (!wasmConfig) {
                    throw new Error('WASM config not received from extension host');
                }

                // Load the Emscripten JS glue via dynamic import
                // In a webview, we load it as a script tag injection
                await loadScript(wasmConfig.jsUri);

                const createFn = globalThis.createVcdParser;
                if (!createFn) {
                    throw new Error('createVcdParser not found on globalThis after loading script');
                }

                // Pass locateFile so Emscripten finds the .wasm binary
                const binaryUri = wasmConfig.binaryUri;
                return await createFn({
                    locateFile: (path: string) => {
                        if (path.endsWith('.wasm')) {
                            return binaryUri;
                        }
                        return path;
                    },
                });
            })();

            // If loading fails, clear the cached promise so a retry
            // (after setWasmConfig) can succeed instead of returning
            // the permanently-rejected promise.
            modulePromise.catch(() => {
                modulePromise = null;
            });
        }
        return modulePromise;
    }

    async pickFile(): Promise<PlatformFile | null> {
        // Not applicable — VSCode handles file opening via custom editor
        return null;
    }

    wrapNativeFile(): PlatformFile | null {
        // Not applicable in VSCode webview
        return null;
    }
}

// ── Helper: load a script by injecting a <script> tag ──────────────

function loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
        document.head.appendChild(script);
    });
}
