/**
 * SignalTreeProvider — TreeDataProvider for the signal explorer sidebar.
 *
 * Re-implements the Sidebar.tsx logic (scope hierarchy, Chisel unflattening,
 * search filtering, bulk toggle) as a native VSCode TreeView.
 */

import * as vscode from 'vscode';
import {
    unflattenChisel,
    getAllSignalsInScope,
} from '@waveform-viewer/core';
import type {
    ScopeNode,
    SignalDef,
} from '@waveform-viewer/core';
import type { WebviewStateSnapshot } from './protocol.ts';

// ── Tree item with extra data ──────────────────────────────────────

export class SignalTreeItem extends vscode.TreeItem {
    /** Set for leaf signal items */
    signalIndex?: number;
    /** Set for scope items — all signal indices under this scope */
    scopeIndices?: number[];

    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        options?: {
            signalIndex?: number;
            scopeIndices?: number[];
            description?: string;
            isSelected?: boolean;
            isScopeAllSelected?: boolean;
            isScopePartiallySelected?: boolean;
        }
    ) {
        super(label, collapsibleState);
        this.signalIndex = options?.signalIndex;
        this.scopeIndices = options?.scopeIndices;

        if (options?.description) {
            this.description = options.description;
        }

        // Checkbox state
        if (options?.signalIndex !== undefined) {
            this.checkboxState = options.isSelected
                ? vscode.TreeItemCheckboxState.Checked
                : vscode.TreeItemCheckboxState.Unchecked;
            this.iconPath = new vscode.ThemeIcon('symbol-variable');
        } else if (options?.scopeIndices) {
            if (options.isScopeAllSelected) {
                this.checkboxState = vscode.TreeItemCheckboxState.Checked;
            } else {
                this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
            }
            this.iconPath = new vscode.ThemeIcon('folder');
        }
    }
}

// ── Provider ───────────────────────────────────────────────────────

export class SignalTreeProvider implements vscode.TreeDataProvider<SignalTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SignalTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _state: WebviewStateSnapshot | null = null;
    private _hierarchy: ScopeNode | null = null;

    updateState(state: WebviewStateSnapshot): void {
        this._state = state;

        // Rebuild hierarchy based on Chisel mode
        if (state.hierarchy) {
            this._hierarchy = state.unflattenChisel
                ? unflattenChisel(state.hierarchy, state.signals)
                : state.hierarchy;
        } else {
            this._hierarchy = null;
        }

        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SignalTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SignalTreeItem): SignalTreeItem[] {
        if (!this._state || !this._hierarchy) {
            return [];
        }

        if (!element) {
            // Root level: return children of the hierarchy root
            return this._buildChildren(this._hierarchy, 0);
        }

        // Find the scope node that matches this element
        const node = this._findNode(this._hierarchy, element.label as string, element.scopeIndices);
        if (!node) return [];

        return this._buildChildren(node, 1);
    }

    // ── Private helpers ────────────────────────────────────────────

    private _buildChildren(node: ScopeNode, depth: number): SignalTreeItem[] {
        const items: SignalTreeItem[] = [];
        const state = this._state!;
        const query = state.searchQuery?.toLowerCase() ?? '';

        // If this is the virtual root, skip rendering it as a node
        const isVirtualRoot = node.name === '<root>' && depth === 0;

        // Add child scopes
        if (node.children) {
            for (const child of node.children) {
                // Filter by search if active
                if (query && !this._scopeHasMatch(child, state.signals, query)) {
                    continue;
                }

                const allIndices = getAllSignalsInScope(child);
                const selectedCount = allIndices.filter(i => state.selectedSignals.includes(i)).length;

                const item = new SignalTreeItem(
                    child.name,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    {
                        scopeIndices: allIndices,
                        description: child.signals?.length
                            ? `(${child.signals.length})`
                            : undefined,
                        isScopeAllSelected: allIndices.length > 0 && selectedCount === allIndices.length,
                        isScopePartiallySelected: selectedCount > 0 && selectedCount < allIndices.length,
                    }
                );
                item.id = child.fullPath || child.name;
                items.push(item);
            }
        }

        // Add signals (either uiSignals or raw signals)
        const signalEntries = this._getSignalEntries(node);
        for (const entry of signalEntries) {
            const sig = state.signals[entry.index];
            if (!sig) continue;

            // Filter by search
            if (query) {
                const nameMatch = entry.name.toLowerCase().includes(query);
                const pathMatch = sig.fullPath.toLowerCase().includes(query);
                if (!nameMatch && !pathMatch) continue;
            }

            const isSelected = state.selectedSignals.includes(entry.index);
            const widthDesc = sig.width > 1
                ? `${sig.type} [${sig.msb ?? sig.width - 1}:${sig.lsb ?? 0}]`
                : sig.type;

            const item = new SignalTreeItem(
                entry.name,
                vscode.TreeItemCollapsibleState.None,
                {
                    signalIndex: entry.index,
                    description: widthDesc,
                    isSelected,
                }
            );
            item.id = `signal-${entry.index}`;
            items.push(item);
        }

        // If virtual root, just return the items directly
        if (isVirtualRoot) {
            return items;
        }

        return items;
    }

    private _getSignalEntries(node: ScopeNode): Array<{ index: number; name: string }> {
        if (node.uiSignals) {
            return node.uiSignals;
        }
        if (node.signals) {
            return node.signals.map(idx => ({
                index: idx,
                name: this._state?.signals[idx]?.name ?? `signal_${idx}`,
            }));
        }
        return [];
    }

    private _findNode(
        root: ScopeNode,
        label: string,
        scopeIndices?: number[]
    ): ScopeNode | null {
        // BFS to find a matching scope node
        const queue: ScopeNode[] = [root];
        while (queue.length > 0) {
            const node = queue.shift()!;
            if (node.name === label) {
                // Verify by comparing scope indices if available
                if (scopeIndices) {
                    const nodeIndices = getAllSignalsInScope(node);
                    if (nodeIndices.length === scopeIndices.length) {
                        return node;
                    }
                } else {
                    return node;
                }
            }
            if (node.children) {
                queue.push(...node.children);
            }
        }
        return null;
    }

    private _scopeHasMatch(node: ScopeNode, signals: SignalDef[], query: string): boolean {
        // Check own signals
        if (node.uiSignals) {
            for (const uSig of node.uiSignals) {
                const sig = signals[uSig.index];
                if (sig && (uSig.name.toLowerCase().includes(query) || sig.fullPath.toLowerCase().includes(query))) {
                    return true;
                }
            }
        } else if (node.signals) {
            for (const idx of node.signals) {
                const sig = signals[idx];
                if (sig && (sig.name.toLowerCase().includes(query) || sig.fullPath.toLowerCase().includes(query))) {
                    return true;
                }
            }
        }
        if (node.children) {
            for (const child of node.children) {
                if (this._scopeHasMatch(child, signals, query)) return true;
            }
        }
        return false;
    }
}
