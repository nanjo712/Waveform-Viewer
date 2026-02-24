import { useState, useCallback, useMemo } from 'react';
import { useAppContext } from '../hooks/useAppContext.tsx';
import { unflattenChisel, getAllSignalsInScope } from '@waveform-viewer/core';
import type { ScopeNode, SignalDef } from '@waveform-viewer/core';

// ── Recursive search helper ────────────────────────────────────────

function scopeHasMatch(
    node: ScopeNode,
    signals: SignalDef[],
    query: string
): boolean {
    // Check own signals
    if (node.uiSignals) {
        for (const uSig of node.uiSignals) {
            const sig = signals[uSig.index];
            if (
                sig &&
                (uSig.name.toLowerCase().includes(query) ||
                    sig.fullPath.toLowerCase().includes(query))
            ) {
                return true;
            }
        }
    } else if (node.signals) {
        for (const idx of node.signals) {
            const sig = signals[idx];
            if (
                sig &&
                (sig.name.toLowerCase().includes(query) ||
                    sig.fullPath.toLowerCase().includes(query))
            ) {
                return true;
            }
        }
    }
    // Recursively check children
    if (node.children) {
        for (const child of node.children) {
            if (scopeHasMatch(child, signals, query)) return true;
        }
    }
    return false;
}

// ── Scope node (folder in the tree) ────────────────────────────────

function ScopeTreeNode({
    node,
    signals,
    depth,
    selectedSignals,
    onToggleSignal,
    onToggleScope,
    searchQuery,
}: {
    node: ScopeNode;
    signals: SignalDef[];
    depth: number;
    selectedSignals: number[];
    onToggleSignal: (index: number) => void;
    onToggleScope: (node: ScopeNode, select: boolean) => void;
    searchQuery: string;
}) {
    const [expanded, setExpanded] = useState(depth < 2);

    const hasChildren =
        (node.children && node.children.length > 0) ||
        (node.signals && node.signals.length > 0);

    // Filter signals by search query
    const matchingSignals = useMemo(() => {
        if (node.uiSignals) {
            if (!searchQuery) return node.uiSignals;
            const q = searchQuery.toLowerCase();
            return node.uiSignals.filter((uSig) => {
                const sig = signals[uSig.index];
                return (
                    sig &&
                    (uSig.name.toLowerCase().includes(q) ||
                        sig.fullPath.toLowerCase().includes(q))
                );
            });
        }

        if (!node.signals) return [];
        const baseSignals = node.signals.map(idx => ({ index: idx, name: signals[idx]?.name ?? '' }));
        if (!searchQuery) return baseSignals;

        const q = searchQuery.toLowerCase();
        return baseSignals.filter((uSig) => {
            const sig = signals[uSig.index];
            return (
                sig &&
                (uSig.name.toLowerCase().includes(q) ||
                    sig.fullPath.toLowerCase().includes(q))
            );
        });
    }, [node.uiSignals, node.signals, signals, searchQuery]);

    // Check if any descendant matches search
    const hasMatchingDescendants = useMemo(() => {
        if (!searchQuery) return true;
        if (matchingSignals.length > 0) return true;
        const q = searchQuery.toLowerCase();
        if (node.children) {
            return node.children.some((child) => scopeHasMatch(child, signals, q));
        }
        return false;
    }, [searchQuery, matchingSignals, node.children, signals]);

    const handleToggle = useCallback(() => setExpanded((e) => !e), []);

    // Determine bulk selection state
    const allSignalsInScope = useMemo(() => {
        return getAllSignalsInScope(node);
    }, [node]);

    const matchingSelectedCount = useMemo(() => {
        return allSignalsInScope.filter(idx => selectedSignals.includes(idx)).length;
    }, [allSignalsInScope, selectedSignals]);

    const isAllSelected = allSignalsInScope.length > 0 && matchingSelectedCount === allSignalsInScope.length;
    const isIndeterminate = matchingSelectedCount > 0 && matchingSelectedCount < allSignalsInScope.length;

    const handleBulkToggle = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        e.stopPropagation();
        onToggleScope(node, !isAllSelected);
    }, [isAllSelected, node, onToggleScope]);

    // Hide this entire scope if searching and nothing matches
    if (searchQuery && !hasMatchingDescendants) {
        return null;
    }

    // Skip root node display if it's the virtual root
    if (node.name === '<root>' && depth === 0) {
        return (
            <>
                {node.children?.map((child) => (
                    <ScopeTreeNode
                        key={child.fullPath || child.name}
                        node={child}
                        signals={signals}
                        depth={0}
                        selectedSignals={selectedSignals}
                        onToggleSignal={onToggleSignal}
                        onToggleScope={onToggleScope}
                        searchQuery={searchQuery}
                    />
                ))}
            </>
        );
    }

    return (
        <div className="tree-node">
            <div
                className="tree-node-header"
                style={{ paddingLeft: depth * 16 + 4 }}
                onClick={handleToggle}
            >
                <input
                    type="checkbox"
                    className="scope-check"
                    checked={isAllSelected}
                    ref={(el) => {
                        if (el) el.indeterminate = isIndeterminate;
                    }}
                    onChange={handleBulkToggle}
                    onClick={(e) => e.stopPropagation()}
                />
                <span className={`tree-chevron ${expanded ? 'expanded' : ''} ${!hasChildren ? 'leaf' : ''}`}>
                    &#9654;
                </span>
                <span className="tree-icon scope">&#128193;</span>
                <span className="tree-label">{node.name}</span>
                {node.signals && node.signals.length > 0 && (
                    <span className="tree-badge">{node.signals.length}</span>
                )}
            </div>

            {expanded && (
                <div className="tree-node-children">
                    {/* Render child scopes */}
                    {node.children?.map((child) => (
                        <ScopeTreeNode
                            key={child.fullPath || child.name}
                            node={child}
                            signals={signals}
                            depth={depth + 1}
                            selectedSignals={selectedSignals}
                            onToggleSignal={onToggleSignal}
                            onToggleScope={onToggleScope}
                            searchQuery={searchQuery}
                        />
                    ))}

                    {/* Render signals in this scope */}
                    {matchingSignals.map((uSig) => {
                        const sigIdx = uSig.index;
                        const sig = signals[sigIdx];
                        if (!sig) return null;
                        const isSelected = selectedSignals.includes(sigIdx);
                        return (
                            <div
                                key={sigIdx}
                                className={`signal-item ${isSelected ? 'selected' : ''}`}
                                style={{ paddingLeft: (depth + 1) * 16 + 4 }}
                                onClick={() => onToggleSignal(sigIdx)}
                            >
                                <input
                                    type="checkbox"
                                    className="signal-check"
                                    checked={isSelected}
                                    onChange={() => onToggleSignal(sigIdx)}
                                    onClick={(e) => e.stopPropagation()}
                                />
                                <span className="tree-icon signal">&#9632;</span>
                                <span className="tree-label">{uSig.name}</span>
                                <span className="tree-badge">
                                    {sig.type}
                                    {sig.width > 1 ? ` [${sig.msb ?? sig.width - 1}:${sig.lsb ?? 0}]` : ''}
                                </span>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ── Sidebar ────────────────────────────────────────────────────────

export function Sidebar() {
    const { state, dispatch } = useAppContext();

    const handleToggleSignal = useCallback(
        (index: number) => {
            dispatch({ type: 'TOGGLE_SIGNAL', index });
        },
        [dispatch]
    );

    const handleSearchChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            dispatch({ type: 'SET_SEARCH', query: e.target.value });
        },
        [dispatch]
    );

    const handleToggleScope = useCallback(
        (node: ScopeNode, select: boolean) => {
            const indices = getAllSignalsInScope(node);
            if (select) {
                dispatch({ type: 'ADD_SIGNALS', indices });
            } else {
                dispatch({ type: 'REMOVE_SIGNALS', indices });
            }
        },
        [dispatch]
    );

    const hierarchyToRender = useMemo(() => {
        if (!state.hierarchy) return null;
        if (!state.unflattenChisel) return state.hierarchy;
        return unflattenChisel(state.hierarchy, state.signals);
    }, [state.hierarchy, state.unflattenChisel, state.signals]);

    return (
        <div className={`sidebar ${state.sidebarCollapsed ? 'collapsed' : ''}`}>
            <div className="sidebar-header">
                <h2>Signal Explorer</h2>
            </div>

            {state.fileLoaded ? (
                <>
                    {/* Action bar */}
                    <div className="sidebar-actions" style={{ padding: '8px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <label style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={state.unflattenChisel}
                                onChange={() => dispatch({ type: 'TOGGLE_UNFLATTEN_CHISEL' })}
                            />
                            Restore Chisel Hierarchy
                        </label>
                    </div>

                    {/* Search */}
                    <div className="search-box">
                        <input
                            className="search-input"
                            type="text"
                            placeholder="Search signals..."
                            value={state.searchQuery}
                            onChange={handleSearchChange}
                        />
                    </div>

                    {/* Signal tree */}
                    <div className="signal-tree">
                        {hierarchyToRender && (
                            <ScopeTreeNode
                                node={hierarchyToRender}
                                signals={state.signals}
                                depth={0}
                                selectedSignals={state.selectedSignals}
                                onToggleSignal={handleToggleSignal}
                                onToggleScope={handleToggleScope}
                                searchQuery={state.searchQuery}
                            />
                        )}
                    </div>

                    {/* Metadata */}
                    {state.metadata && (
                        <div className="metadata-panel">
                            <h3>File Info</h3>
                            {state.metadata.date && (
                                <div className="metadata-row">
                                    <span className="label">Date</span>
                                    <span className="value">{state.metadata.date}</span>
                                </div>
                            )}
                            {state.metadata.version && (
                                <div className="metadata-row">
                                    <span className="label">Version</span>
                                    <span className="value">{state.metadata.version}</span>
                                </div>
                            )}
                            <div className="metadata-row">
                                <span className="label">Timescale</span>
                                <span className="value">
                                    {state.metadata.timescaleMagnitude}{' '}
                                    {state.metadata.timescaleUnit}
                                </span>
                            </div>
                            <div className="metadata-row">
                                <span className="label">Signals</span>
                                <span className="value">{state.metadata.signalCount}</span>
                            </div>
                            <div className="metadata-row">
                                <span className="label">Snapshots</span>
                                <span className="value">{state.metadata.snapshotCount}</span>
                            </div>
                            <div className="metadata-row">
                                <span className="label">Index Memory</span>
                                <span className="value">
                                    {(state.metadata.indexMemoryUsage / 1024).toFixed(1)} KB
                                </span>
                            </div>
                        </div>
                    )}
                </>
            ) : (
                <div className="empty-state">
                    <div className="empty-state-text">No file loaded</div>
                    <div className="empty-state-hint">
                        Open a VCD file to browse signals
                    </div>
                </div>
            )}
        </div>
    );
}
