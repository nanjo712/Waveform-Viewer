import { useState, useCallback, useMemo, useRef, useEffect, memo } from 'react';
import { List } from 'react-window';
import { useAppContext } from '../hooks/useAppContext.tsx';
import { unflattenChisel, getAllSignalsInScope, getSignalCountInScope } from '@waveform-viewer/core';
import type { ScopeNode, SignalDef, WaveformMetadata } from '@waveform-viewer/core';

// ── Types ──────────────────────────────────────────────────────────

type FlattenedItem =
    | { type: 'scope'; node: ScopeNode; depth: number }
    | { type: 'signal'; index: number; name: string; depth: number };

// ── Recursive search helper ────────────────────────────────────────

function scopeHasMatch(
    node: ScopeNode,
    signals: SignalDef[],
    query: string
): boolean {
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
    if (node.children) {
        for (const child of node.children) {
            if (scopeHasMatch(child, signals, query)) return true;
        }
    }
    return false;
}

// ── Tree Flattening Logic ──────────────────────────────────────────

function flattenTree(
    node: ScopeNode,
    signals: SignalDef[],
    expandedNodes: Set<string>,
    searchQuery: string,
    depth = 0,
    result: FlattenedItem[] = []
): FlattenedItem[] {
    const q = searchQuery.toLowerCase();
    const isRoot = node.name === '<root>' && depth === 0;

    // Filter signals in this scope
    let matchingSignals: { index: number; name: string }[] = [];
    if (node.uiSignals) {
        matchingSignals = !q
            ? node.uiSignals
            : node.uiSignals.filter(u => {
                const s = signals[u.index];
                return s && (u.name.toLowerCase().includes(q) || s.fullPath.toLowerCase().includes(q));
            });
    } else if (node.signals) {
        matchingSignals = node.signals.map(idx => ({ index: idx, name: signals[idx]?.name ?? '' }));
        if (q) {
            matchingSignals = matchingSignals.filter(u => {
                const s = signals[u.index];
                return s && (u.name.toLowerCase().includes(q) || s.fullPath.toLowerCase().includes(q));
            });
        }
    }

    // Check if this node or descendants match search
    const hasMatch = q ? (matchingSignals.length > 0 || (node.children?.some(c => scopeHasMatch(c, signals, q)) ?? false)) : true;
    if (!hasMatch) return result;

    if (!isRoot) {
        result.push({ type: 'scope', node, depth });
    }

    const isExpanded = isRoot || expandedNodes.has(node.fullPath || node.name);
    if (isExpanded) {
        // Add children scopes
        if (node.children) {
            for (const child of node.children) {
                flattenTree(child, signals, expandedNodes, searchQuery, isRoot ? 0 : depth + 1, result);
            }
        }
        // Add signals
        for (const sig of matchingSignals) {
            result.push({ type: 'signal', index: sig.index, name: sig.name, depth: isRoot ? 0 : depth + 1 });
        }
    }

    return result;
}

// ── Sidebar Content (Memoized) ────────────────────────────────────

interface SidebarContentProps {
    signals: SignalDef[];
    hierarchy: ScopeNode | null;
    searchQuery: string;
    selectedSignals: number[];
    unflattenChisel: boolean;
    sidebarCollapsed: boolean;
    metadata: WaveformMetadata | null;
    fileLoaded: boolean;
    dispatch: any;
    width: number;
}

const SidebarContent = memo(({
    signals,
    hierarchy,
    searchQuery,
    selectedSignals,
    unflattenChisel: unflatten,
    sidebarCollapsed,
    metadata,
    fileLoaded,
    dispatch,
    width
}: SidebarContentProps) => {
    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
    const [initialized, setInitialized] = useState(false);

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

    const handleToggleExpand = useCallback((path: string) => {
        setExpandedNodes(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, []);

    const hierarchyToRender = useMemo(() => {
        if (!hierarchy) return null;
        if (!unflatten) return hierarchy;
        return unflattenChisel(hierarchy, signals);
    }, [hierarchy, unflatten, signals]);

    // Initialize expansion for top levels
    if (!initialized && hierarchyToRender) {
        const initial = new Set<string>();
        initial.add(hierarchyToRender.fullPath || hierarchyToRender.name);
        hierarchyToRender.children?.forEach(c => initial.add(c.fullPath || c.name));
        setExpandedNodes(initial);
        setInitialized(true);
    }

    const selectedSet = useMemo(() => new Set(selectedSignals), [selectedSignals]);

    const items = useMemo(() => {
        if (!hierarchyToRender) return [];
        return flattenTree(hierarchyToRender, signals, expandedNodes, searchQuery);
    }, [hierarchyToRender, signals, expandedNodes, searchQuery]);

    const [treeHeight, setTreeHeight] = useState(800);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!containerRef.current) return;
        const obs = new ResizeObserver((entries) => {
            if (entries[0]) {
                setTreeHeight(entries[0].contentRect.height);
            }
        });
        obs.observe(containerRef.current);
        return () => obs.disconnect();
    }, []);

    const Row = useCallback(({ index, style, ...rest }: any) => {
        const item = items[index];
        if (!item) return null;
        if (item.type === 'scope') {
            const { node, depth } = item;
            const path = node.fullPath || node.name;
            const expanded = expandedNodes.has(path);
            const hasChildren = (node.children && node.children.length > 0) || (node.signals && node.signals.length > 0);

            // Calculate selection status
            let isAllSelected = false;
            let isIndeterminate = false;

            // Optimization for root/huge scopes
            const isRootNode = node.name === '<root>';
            if (isRootNode) {
                const totalCount = signals.length;
                const selCount = selectedSignals.length;
                isAllSelected = totalCount > 0 && selCount === totalCount;
                isIndeterminate = selCount > 0 && selCount < totalCount;
            } else {
                const totalInScope = getSignalCountInScope(node);
                if (totalInScope > 0) {
                    const allSignals = getAllSignalsInScope(node);
                    const selectedCount = allSignals.filter(idx => selectedSet.has(idx)).length;
                    isAllSelected = selectedCount === totalInScope;
                    isIndeterminate = selectedCount > 0 && selectedCount < totalInScope;
                }
            }

            return (
                <div className="tree-node" style={style}>
                    <div
                        className="tree-node-header"
                        style={{ paddingLeft: depth * 16 + 4 }}
                        onClick={() => handleToggleExpand(path)}
                    >
                        <input
                            type="checkbox"
                            className="scope-check"
                            checked={isAllSelected}
                            ref={(el) => { if (el) el.indeterminate = isIndeterminate; }}
                            onChange={(e) => {
                                e.stopPropagation();
                                handleToggleScope(node, !isAllSelected);
                            }}
                            onClick={(e) => e.stopPropagation()}
                        />
                        <span className={`tree-chevron ${expanded ? 'expanded' : ''} ${!hasChildren ? 'leaf' : ''}`}>
                            &#9654;
                        </span>
                        <span className="tree-icon scope">&#128193;</span>
                        <span className="tree-label" style={{ overflow: 'visible', textOverflow: 'clip' }}>{node.name}</span>
                        {node.signals && node.signals.length > 0 && (
                            <span className="tree-badge">{node.signals.length}</span>
                        )}
                    </div>
                </div>
            );
        } else {
            const { index: sigIdx, name, depth } = item;
            const sig = signals[sigIdx];
            if (!sig) return null;
            const isSelected = selectedSet.has(sigIdx);
            return (
                <div
                    className={`signal-item ${isSelected ? 'selected' : ''}`}
                    style={{ ...style, paddingLeft: depth * 16 + 4, display: 'flex', alignItems: 'center' }}
                    onClick={() => handleToggleSignal(sigIdx)}
                >
                    <input
                        type="checkbox"
                        className="signal-check"
                        checked={isSelected}
                        onChange={() => handleToggleSignal(sigIdx)}
                        onClick={(e) => e.stopPropagation()}
                        readOnly
                    />
                    <span className="tree-icon signal">&#9632;</span>
                    <span className="tree-label" style={{ overflow: 'visible', textOverflow: 'clip' }}>{name}</span>
                    <span className="tree-badge">
                        {sig.type}
                        {sig.width > 1 ? ` [${sig.msb ?? sig.width - 1}:${sig.lsb ?? 0}]` : ''}
                    </span>
                </div>
            );
        }
    }, [items, expandedNodes, selectedSet, signals, selectedSignals, handleToggleExpand, handleToggleScope, handleToggleSignal]);

    return (
        <div
            className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}
            style={!sidebarCollapsed ? { width: 'var(--sidebar-width)' } : {}}
        >
            <div className="sidebar-header">
                <h2>Signal Explorer</h2>
            </div>

            {fileLoaded ? (
                <>
                    <div className="sidebar-actions" style={{ padding: '8px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <label style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={unflatten}
                                onChange={() => dispatch({ type: 'TOGGLE_UNFLATTEN_CHISEL' })}
                            />
                            Restore Chisel Hierarchy
                        </label>
                    </div>

                    <div className="search-box">
                        <input
                            className="search-input"
                            type="text"
                            placeholder="Search signals..."
                            value={searchQuery}
                            onChange={handleSearchChange}
                        />
                    </div>

                    <div className="signal-tree" ref={containerRef} style={{ flex: 1, minHeight: 0, overflowX: 'auto' }}>
                        {items.length > 0 ? (
                            <List
                                rowCount={items.length}
                                rowHeight={24}
                                rowProps={{}}
                                style={{ height: treeHeight, width: 'max-content', minWidth: '100%' }}
                                rowComponent={Row}
                            />
                        ) : (
                            <div className="empty-state" style={{ padding: '20px' }}>No signals found</div>
                        )}
                    </div>

                    {metadata && (
                        <div className="metadata-panel">
                            <h3>File Info</h3>
                            {metadata.date && (
                                <div className="metadata-row">
                                    <span className="label">Date</span>
                                    <span className="value">{metadata.date}</span>
                                </div>
                            )}
                            {metadata.version && (
                                <div className="metadata-row">
                                    <span className="label">Version</span>
                                    <span className="value">{metadata.version}</span>
                                </div>
                            )}
                            <div className="metadata-row">
                                <span className="label">Timescale</span>
                                <span className="value">
                                    {metadata.timescaleMagnitude}{' '}
                                    {metadata.timescaleUnit}
                                </span>
                            </div>
                            <div className="metadata-row">
                                <span className="label">Signals</span>
                                <span className="value">{metadata.signalCount}</span>
                            </div>
                            <div className="metadata-row">
                                <span className="label">Snapshots</span>
                                <span className="value">{metadata.snapshotCount}</span>
                            </div>
                            <div className="metadata-row">
                                <span className="label">Index Memory</span>
                                <span className="value">
                                    {(metadata.indexMemoryUsage / 1024).toFixed(1)} KB
                                </span>
                            </div>
                        </div>
                    )}
                </>
            ) : (
                <div className="empty-state">
                    <div className="empty-state-text">No file loaded</div>
                    <div className="empty-state-hint">
                        Open a waveform file to browse signals
                    </div>
                </div>
            )}
        </div>
    );
});

// ── Sidebar Container ───────────────────────────────────────────

export function Sidebar({ width }: { width: number }) {
    const { state, dispatch } = useAppContext();

    // Only pass necessary props to ensure SidebarContent only re-renders when relevant data changes.
    // Significantly, we OMIT viewStart/viewEnd to avoid re-renders during scrubbing.
    return (
        <SidebarContent
            signals={state.signals}
            hierarchy={state.hierarchy}
            searchQuery={state.searchQuery}
            selectedSignals={state.selectedSignals}
            unflattenChisel={state.unflattenChisel}
            sidebarCollapsed={state.sidebarCollapsed}
            metadata={state.metadata}
            fileLoaded={state.fileLoaded}
            dispatch={dispatch}
            width={width}
        />
    );
}
