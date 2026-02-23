import type { ScopeNode, SignalDef } from '../types/vcd';

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

    for (const idx of node.signals) {
        const sig = signals[idx];
        if (!sig) continue;

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

    // Sort synthetic children and signals if any
    if (clone.children) {
        clone.children.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (clone.uiSignals) {
        clone.uiSignals.sort((a, b) => a.name.localeCompare(b.name));
    }

    return clone;
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

