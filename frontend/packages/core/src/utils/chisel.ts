import type { ScopeNode, SignalDef } from '../types/waveform.ts';

/**
 * Checks if a signal name matches Chisel/FIRRTL compiler-generated temporary patterns.
 * These include:
 *   - ^_            : leading underscore — inlined sub-module port connections
 *                     (e.g. _accumulator_0_io_out, _pes_0_0_io_data_east_data_raw_bits)
 *   - _T / _T_N    : intermediate expression temporaries
 *   - _GEN / _GEN_N: mux/conditional assignment wires
 *   - _RANDOM       : simulation random init values
 *   - _WIRE / _WIRE_N: anonymous Wire() declarations
 */
const COMPILER_GENERATED_RE = /^_|_T(_\d+)?$|_GEN(_\d+)?$|_RANDOM|_WIRE(_\d+)?$/;

function isCompilerGenerated(name: string): boolean {
    return COMPILER_GENERATED_RE.test(name);
}

export function unflattenChisel(node: ScopeNode, signals: SignalDef[]): ScopeNode {
    const clone: ScopeNode = {
        name: node.name,
        fullPath: node.fullPath,
        children: node.children ? node.children.map(c => unflattenChisel(c, signals)) : [],
        uiSignals: [],
        signals: node.signals ? [...node.signals] : [],
    };

    if (!node.signals || node.signals.length === 0) {
        return clone;
    }

    type TrieNode = {
        name: string;
        children: Map<string, TrieNode>;
        sigIndices: number[];
        leafCount: number;
    };

    const root: TrieNode = { name: '', children: new Map(), sigIndices: [], leafCount: 0 };
    const compilerGeneratedSignals: { index: number; name: string }[] = [];

    for (const idx of node.signals) {
        const sig = signals[idx];
        if (!sig) continue;

        // Filter out compiler-generated temporary signals
        if (isCompilerGenerated(sig.name)) {
            compilerGeneratedSignals.push({ index: idx, name: sig.name });
            continue;
        }

        const parts = sig.name.split('_');
        let current = root;
        current.leafCount++;

        for (const part of parts) {
            if (!current.children.has(part)) {
                current.children.set(part, { name: part, children: new Map(), sigIndices: [], leafCount: 0 });
            }
            current = current.children.get(part)!;
            current.leafCount++;
        }
        current.sigIndices.push(idx);
    }

    function traverseTrie(trieNode: TrieNode, currentScope: ScopeNode) {
        for (const [part, childNode] of trieNode.children.entries()) {
            if (childNode.leafCount === 1) {
                let leaf = childNode;
                const remainingParts = [part];
                while (leaf.children.size > 0) {
                    const nextPart = Array.from(leaf.children.keys())[0];
                    leaf = leaf.children.get(nextPart)!;
                    remainingParts.push(nextPart);
                }
                if (!currentScope.uiSignals) currentScope.uiSignals = [];
                currentScope.uiSignals.push({
                    index: leaf.sigIndices[0],
                    name: remainingParts.join('_')
                });
            } else {
                let childScope: ScopeNode | undefined = undefined;
                if (childNode.children.size > 0) {
                    childScope = currentScope.children?.find(c => c.name === part);
                    if (!childScope) {
                        childScope = {
                            name: part,
                            fullPath: currentScope.fullPath ? currentScope.fullPath + '.' + part : part,
                            children: [],
                            uiSignals: [],
                            signals: []
                        };
                        if (!currentScope.children) currentScope.children = [];
                        currentScope.children.push(childScope);
                    }
                }

                for (const idx of childNode.sigIndices) {
                    if (!currentScope.uiSignals) currentScope.uiSignals = [];
                    currentScope.uiSignals.push({
                        index: idx,
                        name: part
                    });
                }

                if (childScope) {
                    traverseTrie(childNode, childScope);
                }
            }
        }
    }

    traverseTrie(root, clone);

    // Place compiler-generated temporary signals into a dedicated _COMPILER_GENERATED_ scope
    if (compilerGeneratedSignals.length > 0) {
        const compilerScope: ScopeNode = {
            name: '_COMPILER_GENERATED_',
            fullPath: clone.fullPath ? clone.fullPath + '._COMPILER_GENERATED_' : '_COMPILER_GENERATED_',
            children: [],
            uiSignals: compilerGeneratedSignals.map(s => ({ index: s.index, name: s.name })),
            signals: [],
        };
        compilerScope.uiSignals!.sort((a, b) => a.name.localeCompare(b.name));
        if (!clone.children) clone.children = [];
        clone.children.push(compilerScope);
    }

    // Sort synthetic children and signals if any
    if (clone.children) {
        clone.children.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (clone.uiSignals) {
        clone.uiSignals.sort((a, b) => a.name.localeCompare(b.name));
    }

    return clone;
}

/** Display metadata for a signal in the waveform list under Chisel mode. */
export interface SignalDisplayInfo {
    /** The shortened display name produced by trie-based unflattening. */
    displayName: string;
    /** Scope path from root to the signal (excludes `<root>` and `_COMPILER_GENERATED_`). */
    scopePath: string[];
}

/**
 * Walk an unflattened ScopeNode tree and build a map from signal index to its
 * display name and hierarchical scope path.
 *
 * For signals inside the synthetic `_COMPILER_GENERATED_` scope, the path
 * reflects the real parent scope (i.e. `_COMPILER_GENERATED_` is omitted).
 */
export function buildSignalDisplayMap(root: ScopeNode): Map<number, SignalDisplayInfo> {
    const map = new Map<number, SignalDisplayInfo>();

    function walk(node: ScopeNode, pathStack: string[]) {
        // Determine the path to pass to children / signals in this node.
        const isVirtualRoot = node.name === '<root>';
        const isCompilerScope = node.name === '_COMPILER_GENERATED_';
        // Only push real scope names into the path.
        const currentPath = (isVirtualRoot || isCompilerScope)
            ? pathStack
            : [...pathStack, node.name];

        if (node.uiSignals) {
            for (const uSig of node.uiSignals) {
                let displayName = uSig.name;
                let scopePath = currentPath;

                // When the display name is a pure number (e.g. "0", "3"), merge it
                // with the last scope segment: "data" + "0" → "data[0]"
                if (/^\d+$/.test(displayName) && scopePath.length > 0) {
                    const parentName = scopePath[scopePath.length - 1];
                    displayName = `${parentName}[${displayName}]`;
                    scopePath = scopePath.slice(0, -1);
                }

                map.set(uSig.index, { displayName, scopePath });
            }
        }

        if (node.children) {
            for (const child of node.children) {
                walk(child, currentPath);
            }
        }
    }

    walk(root, []);
    return map;
}

export function getAllSignalsInScope(node: ScopeNode): number[] {
    const indices = new Set<number>();

    if (node.uiSignals) {
        node.uiSignals.forEach(s => indices.add(s.index));
    } else if (node.signals) {
        node.signals.forEach(idx => indices.add(idx));
    }

    if (node.children) {
        for (const child of node.children) {
            const childSignals = getAllSignalsInScope(child);
            childSignals.forEach(idx => indices.add(idx));
        }
    }

    return Array.from(indices);
}
