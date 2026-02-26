/**
 * TauriPlatformAdapter -- Tauri desktop adapter.
 *
 * Currently Tauri is a thin webview shell with zero custom Rust commands,
 * so this adapter delegates entirely to the web-standard browser APIs.
 * It exists as a separate class so that Tauri-specific capabilities
 * (native file dialogs, IPC commands, etc.) can be added later without
 * touching the web adapter.
 */

import type { PlatformAdapter, PlatformFile, VcdParserModule } from '@waveform-viewer/core';

type CreateVcdParser = () => Promise<VcdParserModule>;

declare global {
    // eslint-disable-next-line no-var
    var createVcdParser: CreateVcdParser | undefined;
}

/** Wrap a browser File object into a PlatformFile handle. */
function wrapBrowserFile(file: File): PlatformFile {
    return {
        name: file.name,
        size: file.size,
        nativeFile: file,
        readSlice(offset: number, length: number): Promise<ArrayBuffer> {
            const blob = file.slice(offset, offset + length);
            return blob.arrayBuffer();
        },
    };
}

/** Load a JS script by injecting a <script> tag into document.head. */
function loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
        document.head.appendChild(script);
    });
}

/** Show a native file picker and return the selected File, or null if cancelled. */
function showFilePicker(accept: string): Promise<File | null> {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.style.display = 'none';

        input.addEventListener('change', () => {
            const file = input.files?.[0] ?? null;
            input.remove();
            resolve(file);
        });

        input.addEventListener('cancel', () => {
            input.remove();
            resolve(null);
        });

        document.body.appendChild(input);
        input.click();
    });
}

import VcdWorker from '@waveform-viewer/core/worker?worker';

// Singleton promise for WASM module (loaded once)
let modulePromise: Promise<VcdParserModule> | null = null;

export class TauriPlatformAdapter implements PlatformAdapter {
    readonly platformName = 'tauri' as const;

    createWorker(): Worker {
        return new VcdWorker();
    }

    getWasmConfig(): { jsUri: string; binaryUri?: string } {
        // Use relative path logic to support subdirectories (if applicable to Tauri webviews)
        const baseUrl = new URL('.', window.location.href).href;
        return {
            jsUri: new URL('wasm/vcd_parser.js', baseUrl).href,
            binaryUri: new URL('wasm/vcd_parser.wasm', baseUrl).href
        };
    }

    async loadWasmModule(): Promise<VcdParserModule> {
        if (!modulePromise) {
            modulePromise = (async () => {
                const config = this.getWasmConfig();
                await loadScript(config.jsUri);
                const createFn = globalThis.createVcdParser;
                if (!createFn) {
                    throw new Error('createVcdParser not found on globalThis after loading script');
                }
                return await createFn();
            })();
        }
        return modulePromise;
    }

    async pickFile(options?: { extensions?: string[] }): Promise<PlatformFile | null> {
        // TODO: Replace with Tauri native file dialog when @tauri-apps/api is added
        const accept = options?.extensions?.join(',') ?? '.vcd';
        const file = await showFilePicker(accept);
        if (!file) return null;
        return wrapBrowserFile(file);
    }

    wrapNativeFile(nativeFile: unknown): PlatformFile | null {
        if (nativeFile instanceof File) {
            return wrapBrowserFile(nativeFile);
        }
        return null;
    }

    async loadPlugin(): Promise<void> {
        // TODO: Replace with Tauri native file dialog when @tauri-apps/api is added
        const file = await showFilePicker('.js');
        if (!file) return;

        const url = URL.createObjectURL(file);
        try {
            await import(/* @vite-ignore */ url);
        } finally {
            URL.revokeObjectURL(url);
        }
    }
}
