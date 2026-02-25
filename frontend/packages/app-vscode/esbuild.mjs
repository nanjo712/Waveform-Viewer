/**
 * esbuild build script for @waveform-viewer/app-vscode.
 *
 * Produces two separate bundles:
 *   1. dist/extension.js — extension host code (Node.js, CommonJS)
 *   2. dist/webview.js + dist/webview.css — webview code (browser, IIFE)
 */

import * as esbuild from 'esbuild';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
    entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
    bundle: true,
    outfile: path.join(__dirname, 'dist', 'extension.js'),
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    external: ['vscode'],
    sourcemap: true,
    minify: !isWatch,
    // Resolve .ts extensions from workspace packages
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
};

/** @type {esbuild.BuildOptions} */
const webviewConfig = {
    entryPoints: [path.join(__dirname, 'src', 'webview', 'main.tsx')],
    bundle: true,
    outfile: path.join(__dirname, 'dist', 'webview.js'),
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    minify: !isWatch,
    // Resolve .ts extensions from workspace packages
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    // CSS is extracted automatically by esbuild when importing .css files
    loader: {
        '.css': 'css',
    },
    define: {
        'process.env.NODE_ENV': isWatch ? '"development"' : '"production"',
    },
    // JSX transform for React 19
    jsx: 'automatic',
};

/** @type {esbuild.BuildOptions} */
const workerConfig = {
    entryPoints: [path.join(__dirname, '..', 'core', 'src', 'worker', 'vcdWorker.ts')],
    bundle: true,
    outfile: path.join(__dirname, 'dist', 'worker.js'),
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    minify: !isWatch,
    resolveExtensions: ['.ts', '.js', '.json'],
};

/** @type {esbuild.BuildOptions} */
const nodeWorkerConfig = {
    entryPoints: [path.join(__dirname, 'src', 'nodeWorker.ts')],
    bundle: true,
    outfile: path.join(__dirname, 'dist', 'nodeWorker.js'),
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    minify: !isWatch,
    resolveExtensions: ['.ts', '.js', '.json'],
};

async function build() {
    if (isWatch) {
        const [extCtx, webCtx, workerCtx, nodeWorkerCtx] = await Promise.all([
            esbuild.context(extensionConfig),
            esbuild.context(webviewConfig),
            esbuild.context(workerConfig),
            esbuild.context(nodeWorkerConfig),
        ]);
        await Promise.all([extCtx.watch(), webCtx.watch(), workerCtx.watch(), nodeWorkerCtx.watch()]);
        console.log('[watch] Watching for changes...');
    } else {
        await Promise.all([
            esbuild.build(extensionConfig),
            esbuild.build(webviewConfig),
            esbuild.build(workerConfig),
            esbuild.build(nodeWorkerConfig),
        ]);
        console.log('[build] Extension and webview bundles built successfully.');
    }
}

build().catch((err) => {
    console.error(err);
    process.exit(1);
});
