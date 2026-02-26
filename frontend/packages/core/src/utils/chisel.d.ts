import type { ScopeNode, SignalDef } from '../types/waveform.ts';
export declare function unflattenChisel(node: ScopeNode, signals: SignalDef[]): ScopeNode;
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
export declare function buildSignalDisplayMap(root: ScopeNode): Map<number, SignalDisplayInfo>;
export declare function getAllSignalsInScope(node: ScopeNode): number[];
