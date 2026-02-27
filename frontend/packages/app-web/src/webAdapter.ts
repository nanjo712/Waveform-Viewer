/**
 * WebPlatformAdapter — browser-specific PlatformAdapter implementation.
 *
 * WASM loading: injects a <script> tag for the Emscripten JS glue,
 *   then calls globalThis.createVcdParser().
 * File I/O: wraps browser File API (slice + arrayBuffer).
 * File picking: creates a hidden <input type="file">.
 * Plugin loading: picks a .js file and dynamically imports it via blob URL.
 */

import type { PlatformAdapter, PlatformFile, WaveformParserModule } from '@waveform-viewer/core';


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

        // Handle cancel (user closes the dialog without selecting)
        input.addEventListener('cancel', () => {
            input.remove();
            resolve(null);
        });

        document.body.appendChild(input);
        input.click();
    });
}

import WaveformWorker from '@waveform-viewer/core/worker?worker';


export class WebPlatformAdapter implements PlatformAdapter {
    readonly platformName = 'web' as const;

    createWorker(): Worker {
        return new WaveformWorker();
    }

    getWasmConfig(): { jsUri: string; binaryUri?: string } {
        // In dev and prod, /wasm/ is served from public dir.
        // Use relative path logic to support GitHub Pages subdirectories.
        const baseUrl = new URL('.', window.location.href).href;
        return {
            jsUri: new URL('wasm/vcd_parser.js', baseUrl).href,
            binaryUri: new URL('wasm/vcd_parser.wasm', baseUrl).href
        };
    }


    async pickFile(options?: { extensions?: string[] }): Promise<PlatformFile | null> {
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
        const file = await showFilePicker('.js');
        if (!file) return; // User cancelled

        const url = URL.createObjectURL(file);
        try {
            await import(/* @vite-ignore */ url);
        } finally {
            URL.revokeObjectURL(url);
        }
    }
}
