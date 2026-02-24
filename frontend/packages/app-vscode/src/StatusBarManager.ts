/**
 * StatusBarManager — manages VSCode status bar items showing
 * VCD file metadata (timescale, signal count, time range, selection count).
 */

import * as vscode from 'vscode';
import type { WebviewStateSnapshot } from './protocol.ts';

export class StatusBarManager implements vscode.Disposable {
    private readonly _items: vscode.StatusBarItem[] = [];
    private readonly _timescaleItem: vscode.StatusBarItem;
    private readonly _signalsItem: vscode.StatusBarItem;
    private readonly _timeRangeItem: vscode.StatusBarItem;
    private readonly _selectionItem: vscode.StatusBarItem;

    constructor() {
        this._timescaleItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left, 100
        );
        this._signalsItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left, 99
        );
        this._timeRangeItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left, 98
        );
        this._selectionItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left, 97
        );

        this._items.push(
            this._timescaleItem,
            this._signalsItem,
            this._timeRangeItem,
            this._selectionItem,
        );
    }

    updateState(state: WebviewStateSnapshot): void {
        if (!state.fileLoaded || !state.metadata) {
            this._hideAll();
            return;
        }

        const meta = state.metadata;

        this._timescaleItem.text = `$(clock) ${meta.timescaleMagnitude} ${meta.timescaleUnit}`;
        this._timescaleItem.tooltip = 'Timescale';
        this._timescaleItem.show();

        this._signalsItem.text = `$(symbol-variable) ${meta.signalCount}`;
        this._signalsItem.tooltip = 'Total Signals';
        this._signalsItem.show();

        this._timeRangeItem.text = `$(arrow-both) ${state.timeBegin}-${state.timeEnd} ${meta.timescaleUnit}`;
        this._timeRangeItem.tooltip = 'Time Range';
        this._timeRangeItem.show();

        this._selectionItem.text = `$(checklist) ${state.selectedSignals.length}`;
        this._selectionItem.tooltip = 'Selected Signals';
        this._selectionItem.show();
    }

    private _hideAll(): void {
        for (const item of this._items) {
            item.hide();
        }
    }

    dispose(): void {
        for (const item of this._items) {
            item.dispose();
        }
    }
}
