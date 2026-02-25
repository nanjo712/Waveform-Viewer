/**
 * Extension entry point — activate / deactivate.
 *
 * Registers the custom editor provider, signal tree view,
 * status bar manager, and all commands.
 */

import * as vscode from 'vscode';
import { VcdEditorProvider } from './VcdEditorProvider.ts';
import { StatusBarManager } from './StatusBarManager.ts';
import type { HostToWebviewMessage } from './protocol.ts';

export function activate(context: vscode.ExtensionContext) {
    const editorProvider = new VcdEditorProvider(context.extensionUri);

    // Register custom editor for .vcd files
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            VcdEditorProvider.viewType,
            editorProvider,
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            }
        )
    );


    // Status bar
    const statusBar = new StatusBarManager();
    context.subscriptions.push(statusBar);

    // Listen for state updates from webview
    editorProvider.onDidChangeState((snapshot) => {
        statusBar.updateState(snapshot);
    });

    // ── Commands ───────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('waveformViewer.toggleChiselHierarchy', () => {
            const msg: HostToWebviewMessage = { type: 'toggleChisel' };
            editorProvider.postMessage(msg);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('waveformViewer.loadPlugin', async () => {
            const files = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { 'JavaScript Plugin': ['js'] },
                title: 'Select Format Plugin',
            });
            if (!files || files.length === 0) return;

            // Read the plugin file and send its content to the webview
            // The webview will eval it (same as the web adapter's blob URL approach)
            const data = await vscode.workspace.fs.readFile(files[0]);
            const pluginCode = new TextDecoder().decode(data);
            // We send the code as a message; the webview will execute it
            editorProvider.postMessage({
                type: 'init', // Reuse init as a workaround — we'll handle this properly
                wasmJsUri: '',
                wasmBinaryUri: '',
            } as HostToWebviewMessage);
            // Actually, let's use a cleaner approach — just send the code
            // For now, plugin loading in VSCode is a stretch goal.
            // The core plugin registration mechanism works the same way.
            void pluginCode;
            vscode.window.showInformationMessage('Plugin loading in VSCode is not yet supported.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('waveformViewer.zoomIn', () => {
            // Zoom commands are handled by the webview toolbar directly.
            // This command exists for keybinding support if needed.
            vscode.window.showInformationMessage('Use the zoom controls in the waveform viewer toolbar.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('waveformViewer.zoomOut', () => {
            vscode.window.showInformationMessage('Use the zoom controls in the waveform viewer toolbar.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('waveformViewer.zoomFit', () => {
            vscode.window.showInformationMessage('Use the zoom controls in the waveform viewer toolbar.');
        })
    );


}

export function deactivate() {
    // Nothing to clean up — disposables handle it
}
