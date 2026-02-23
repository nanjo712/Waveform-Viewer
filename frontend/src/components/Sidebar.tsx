import { useState, useCallback, useMemo } from 'react';
import { useAppContext } from '../hooks/useAppContext';
import type { ScopeNode, SignalDef } from '../types/vcd';

// ── Recursive search helper ────────────────────────────────────────

function scopeHasMatch(
  node: ScopeNode,
  signals: SignalDef[],
  query: string
): boolean {
  // Check own signals
  if (node.signals) {
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
  searchQuery,
}: {
  node: ScopeNode;
  signals: SignalDef[];
  depth: number;
  selectedSignals: number[];
  onToggleSignal: (index: number) => void;
  searchQuery: string;
}) {
  const [expanded, setExpanded] = useState(depth < 2);

  const hasChildren =
    (node.children && node.children.length > 0) ||
    (node.signals && node.signals.length > 0);

  // Filter signals by search query
  const matchingSignals = useMemo(() => {
    if (!node.signals) return [];
    if (!searchQuery) return node.signals;
    const q = searchQuery.toLowerCase();
    return node.signals.filter((idx) => {
      const sig = signals[idx];
      return (
        sig &&
        (sig.name.toLowerCase().includes(q) ||
          sig.fullPath.toLowerCase().includes(q))
      );
    });
  }, [node.signals, signals, searchQuery]);

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

  // Hide this entire scope if searching and nothing matches
  if (searchQuery && !hasMatchingDescendants) {
    return null;
  }

  const handleToggle = useCallback(() => setExpanded((e) => !e), []);

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
              searchQuery={searchQuery}
            />
          ))}

          {/* Render signals in this scope */}
          {matchingSignals.map((sigIdx) => {
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
                <span className="tree-label">{sig.name}</span>
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

  return (
    <div className={`sidebar ${state.sidebarCollapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header">
        <h2>Signal Explorer</h2>
      </div>

      {state.fileLoaded ? (
        <>
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
            {state.hierarchy && (
              <ScopeTreeNode
                node={state.hierarchy}
                signals={state.signals}
                depth={0}
                selectedSignals={state.selectedSignals}
                onToggleSignal={handleToggleSignal}
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
                <span className="label">Transitions</span>
                <span className="value">{state.metadata.totalTransitions}</span>
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
