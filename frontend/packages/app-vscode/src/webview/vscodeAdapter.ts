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
    WaveformParserModule,
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


// ── VSCode PlatformFile implementation (stubbed) ───────────────────

class VscodePlatformFile implements PlatformFile {
    readonly name: string;
    readonly size: number;

    constructor(name: string, size: number) {
        this.name = name;
        this.size = size;
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

    // Handle responses meant for the proxy worker
    // (Handled by VscodeProxyWorker.onHostMessage)

    // Forward all other messages to registered handlers
    for (const handler of messageHandlers) {
        handler(msg);
    }
});

// ── Adapter ────────────────────────────────────────────────────────

let wasmConfig: { jsUri: string; binaryUri: string; workerUri: string } | null = null;

/** Called when the extension host sends the init message with WASM and Worker URIs */
export function setWasmConfig(jsUri: string, binaryUri: string, workerUri: string): void {
    wasmConfig = { jsUri, binaryUri, workerUri };
}

/** Create a PlatformFile from file info sent by the extension host */
export function createPlatformFile(name: string, size: number): PlatformFile {
    return new VscodePlatformFile(name, size);
}

/** Send a postMessage to the extension host */
export function postToHost(msg: WebviewToHostMessage): void {
    vscode?.postMessage(msg);
}

class VscodeProxyWorker implements Worker {
    onmessage: ((this: Worker, ev: MessageEvent) => any) | null = null;
    onmessageerror: ((this: Worker, ev: MessageEvent) => any) | null = null;
    onerror: ((this: AbstractWorker, ev: ErrorEvent) => any) | null = null;

    constructor() {
        onHostMessage((msg) => {
            if (msg.type === 'workerMessage') {
                if (this.onmessage) {
                    this.onmessage(new MessageEvent('message', { data: msg.data }));
                }
            }
        });
    }

    postMessage(message: any, options?: any): void {
        vscode?.postMessage({
            type: 'workerMessage',
            data: message
        });
    }

    terminate(): void { }
    addEventListener(): void { }
    removeEventListener(): void { }
    dispatchEvent(): boolean { return true; }
}

export class VscodePlatformAdapter implements PlatformAdapter {
    readonly platformName = 'vscode' as const;

    createWorker(): Worker {
        return new VscodeProxyWorker();
    }

    getWasmConfig(): { jsUri: string; binaryUri?: string } {
        if (!wasmConfig) {
            throw new Error('WASM config not received from extension host');
        }
        return {
            jsUri: wasmConfig.jsUri,
            binaryUri: wasmConfig.binaryUri
        };
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

