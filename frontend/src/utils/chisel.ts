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

    for (const idx of node.signals) {
        const sig = signals[idx];
        if (!sig) continue;

        if (sig.name.includes('_')) {
            const parts = sig.name.split('_');
            const leafName = parts.pop()!;

            let currentPathStr = node.fullPath;
            let parentScopeNode: ScopeNode = clone;

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                currentPathStr += '.' + part;

                let childScope = parentScopeNode.children?.find(c => c.name === part);
                if (!childScope) {
                    childScope = {
                        name: part,
                        fullPath: currentPathStr,
                        children: [],
                        uiSignals: [],
                        signals: [],
                    };
                    if (!parentScopeNode.children) parentScopeNode.children = [];
                    parentScopeNode.children.push(childScope);
                }
                parentScopeNode = childScope;
            }

            if (!parentScopeNode.uiSignals) parentScopeNode.uiSignals = [];
            parentScopeNode.uiSignals.push({ index: idx, name: leafName });
        } else {
            if (!clone.uiSignals) clone.uiSignals = [];
            clone.uiSignals.push({ index: idx, name: sig.name });
        }
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

