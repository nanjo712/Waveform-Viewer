/**
 * VcdEditorProvider — CustomReadonlyEditorProvider for .vcd files.
 *
 * Responsibilities:
 * - Create webview panel when a .vcd file is opened
 * - Read file chunks from disk and send to webview via postMessage
 * - Relay signal tree interactions from host to webview
 * - Receive state updates from webview for TreeView / StatusBar
 */

import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import type {
    HostToWebviewMessage,
    WebviewToHostMessage,
    WebviewStateSnapshot,
} from './protocol.ts';

export class VcdEditorProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'waveformViewer.vcdEditor';

    /** Currently active state snapshot from the webview */
    private _stateSnapshot: WebviewStateSnapshot | null = null;
    /** Currently active webview panel */
    private _activeWebview: vscode.WebviewPanel | null = null;
    /** File URI for the currently open file */
    private _fileUri: vscode.Uri | null = null;
    /** Pending file open info, deferred until WASM is ready */
    private _pendingFileUri: vscode.Uri | null = null;
    private _pendingWebview: vscode.Webview | null = null;
    /** The Node.js WebAssembly host worker */
    private _nodeWorker: Worker | null = null;

    private readonly _onDidChangeState = new vscode.EventEmitter<WebviewStateSnapshot>();
    public readonly onDidChangeState = this._onDidChangeState.event;

    private readonly extensionUri: vscode.Uri;

    constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;
    }

    get stateSnapshot(): WebviewStateSnapshot | null {
        return this._stateSnapshot;
    }

    // ── CustomReadonlyEditorProvider implementation ─────────────────

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<vscode.CustomDocument> {
        return { uri, dispose: () => { } };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        this._activeWebview = webviewPanel;
        this._fileUri = document.uri;

        const webview = webviewPanel.webview;
        webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };

        // Set HTML content
        webview.html = this._getHtmlForWebview(webview);

        // Handle messages from webview
        webview.onDidReceiveMessage(
            (msg: WebviewToHostMessage) => this._handleWebviewMessage(msg, webview, document.uri),
            undefined,
            []
        );

        // Start Node worker
        const nodeWorkerUri = vscode.Uri.joinPath(this.extensionUri, 'dist', 'nodeWorker.js');
        this._nodeWorker = new Worker(nodeWorkerUri.fsPath);

        this._nodeWorker.on('message', (msg: any) => {
            this.postMessage({ type: 'workerMessage', data: msg });
        });

        this._nodeWorker.on('error', (err: any) => {
            console.error('Node worker error:', err);
        });

        // Clean up on close
        webviewPanel.onDidDispose(() => {
            if (this._activeWebview === webviewPanel) {
                this._activeWebview = null;
                this._fileUri = null;
                this._stateSnapshot = null;
                this._nodeWorker?.terminate();
                this._nodeWorker = null;
            }
        });
    }

    // ── Public methods for external command handlers ────────────────

    /** Post a message to the active webview */
    postMessage(msg: HostToWebviewMessage): void {
        this._activeWebview?.webview.postMessage(msg);
    }

    // ── Private: message handling ──────────────────────────────────

    private async _handleWebviewMessage(
        msg: WebviewToHostMessage,
        webview: vscode.Webview,
        fileUri: vscode.Uri
    ): Promise<void> {
        switch (msg.type) {
            case 'ready': {
                // Webview is loaded and message handler is registered —
                // send WASM URIs so the webview can initialize.
                const wasmJsUri = webview.asWebviewUri(
                    vscode.Uri.joinPath(this.extensionUri, 'media', 'wasm', 'vcd_parser.js')
                );
                const wasmBinaryUri = webview.asWebviewUri(
                    vscode.Uri.joinPath(this.extensionUri, 'media', 'wasm', 'vcd_parser.wasm')
                );
                const workerUri = webview.asWebviewUri(
                    vscode.Uri.joinPath(this.extensionUri, 'dist', 'worker.js')
                );

                const initMsg: HostToWebviewMessage = {
                    type: 'init',
                    wasmJsUri: wasmJsUri.toString(),
                    wasmBinaryUri: wasmBinaryUri.toString(),
                    workerUri: workerUri.toString(),
                };
                webview.postMessage(initMsg);

                // Stash file info — will be sent after WASM is ready
                this._pendingFileUri = fileUri;
                this._pendingWebview = webview;
                break;
            }

            case 'wasmReady': {
                // WASM has loaded successfully in the webview —
                // now safe to send the file to parse.
                const pendingUri = this._pendingFileUri;
                const pendingWebview = this._pendingWebview;
                this._pendingFileUri = null;
                this._pendingWebview = null;

                if (pendingUri && pendingWebview) {
                    const stat = await vscode.workspace.fs.stat(pendingUri);
                    const fileOpenedMsg: HostToWebviewMessage = {
                        type: 'fileOpened',
                        fileName: pendingUri.path.split('/').pop() ?? 'unknown.vcd',
                        fileSize: stat.size,
                    };
                    pendingWebview.postMessage(fileOpenedMsg);
                }
                break;
            }

            case 'workerMessage': {
                if (msg.data.type === 'INIT') {
                    // Update INIT URIs to use Node.js absolute local paths rather than webview virtual URIs
                    msg.data.wasmJsUri = vscode.Uri.joinPath(this.extensionUri, 'media', 'wasm', 'vcd_parser.js').fsPath;
                    msg.data.wasmBinaryUri = vscode.Uri.joinPath(this.extensionUri, 'media', 'wasm', 'vcd_parser.wasm').fsPath;
                } else if (msg.data.type === 'INDEX_FILE') {
                    // Inject real path for NODEFS mount functionality
                    msg.data.localPath = fileUri.fsPath;
                }

                this._nodeWorker?.postMessage(msg.data);
                break;
            }

            case 'stateUpdate': {
                this._stateSnapshot = msg.state;
                this._onDidChangeState.fire(msg.state);
                break;
            }

            case 'error': {
                vscode.window.showErrorMessage(`Waveform Viewer: ${msg.message}`);
                break;
            }
        }
    }

    // ── Private: HTML generation ───────────────────────────────────

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css')
        );
        const nonce = getNonce();

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webview.cspSource} 'unsafe-inline';
                   script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval';
                   img-src ${webview.cspSource};
                   font-src ${webview.cspSource};
                   connect-src ${webview.cspSource};">
    <link href="${styleUri}" rel="stylesheet">
    <title>Waveform Viewer</title>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}
