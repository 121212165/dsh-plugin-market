/** F3 fuse — pure capability matrix / overlap / reuse / attribution logic.
 *
 * No IO lives here: the command and the `market_fuse` tool share these
 * functions, while disk writes stay in the assembly layer. The license red
 * line (§8 of the plan) is enforced before any artifact is rendered: the pool
 * only accepts MIT / Apache-2.0, and GPL (or any unrecognised) license is
 * rejected outright — never copied into a fused product.
 */
import type { MarketIndex, PluginEntry } from './types.ts';
export declare const FUSE_MIN_PLUGINS = 2;
export declare const FUSE_MAX_PLUGINS = 5;
export declare const FUSE_LICENSE_ALLOWLIST: readonly ['MIT', 'Apache-2.0'];
export type FuseLicense = (typeof FUSE_LICENSE_ALLOWLIST)[number];
export type CapabilityKind = 'command' | 'tool' | 'host-requirement' | 'category' | 'data-domain';
export type CapabilitySource = 'entries' | 'requires' | 'category' | 'oneLiner';
export interface FuseRejection {
    id: string;
    reason: string;
}
export interface FuseValidation {
    ok: boolean;
    ids: string[];
    /** Resolved selected plugins in selection order (including license failures). */
    plugins: PluginEntry[];
    /** Plugins whose license is in the allowlist (the actual fusion pool). */
    eligible: PluginEntry[];
    rejected: FuseRejection[];
    errors: string[];
}
export declare class FuseValidationError extends Error {
    readonly errors: string[];
    constructor(errors: string[]);
}
/** Accept commas (ASCII/fullwidth), whitespace, or an array; keep first-seen order. */
export declare function parseFuseIds(input: string | string[]): string[];
/** Conservative SPDX-ish normalisation: only the two allowed licenses map.
 * Compound expressions and anything unknown (GPL/AGPL/BSD/blank) map to null. */
export declare function normalizeLicense(raw: string | undefined): FuseLicense | null;
/** Gate every selected plugin before any matrix/artifact work happens. */
export declare function validateFuseSelection(input: string | string[], index: MarketIndex): FuseValidation;
export interface CapabilityRow {
    key: string;
    label: string;
    kind: CapabilityKind;
    source: CapabilitySource;
    /** plugin id -> whether this plugin carries the capability */
    cells: Record<string, boolean>;
}
export interface CapabilityMatrix {
    ids: string[];
    rows: CapabilityRow[];
}
/** Capabilities are derived only from catalog fields — no guessing at code. */
export declare function buildCapabilityMatrix(plugins: PluginEntry[]): CapabilityMatrix;
export interface Overlap {
    key: string;
    label: string;
    kind: CapabilityKind;
    source: CapabilitySource;
    members: string[];
    /** Canonical implementation to reuse: first plugin that carries the field. */
    owner: string;
    severity: 'conflict' | 'reuse';
    detail: string;
    reuse: string;
}
/** A field shared by 2+ plugins is either an entry collision (conflict) or a
 * reusable capability (reuse). Both produce an actionable "reuse, don't
 * rewrite" instruction so the fused product never duplicates code. */
export declare function detectOverlaps(matrix: CapabilityMatrix): Overlap[];
export interface ReuseItem {
    field: string;
    label: string;
    owner: string;
    consumers: string[];
    instruction: string;
}
export declare function buildReuseList(overlaps: Overlap[]): ReuseItem[];
export interface SourceRow {
    pluginId: string;
    name: string;
    repo: string;
    license: FuseLicense;
    borrowedFrom: string[];
    differences: string[];
    attribution: string;
}
/** §8: every fused artifact must carry a mandatory "borrowed from & delta" table. */
export declare function buildSourceTable(plugins: PluginEntry[], overlaps: Overlap[]): SourceRow[];
export interface FusePlan {
    ids: string[];
    plugins: PluginEntry[];
    validation: FuseValidation;
    matrix: CapabilityMatrix;
    overlaps: Overlap[];
    reuseList: ReuseItem[];
    sourceTable: SourceRow[];
    taskBook: string;
    scaffolding: FuseFile[];
}
export interface FuseFile {
    path: string;
    content: string;
}
/** Generate a gate-ready plugin scaffold. `lib/` is committed on purpose: the
 * family gate's G0-9 checks that the declared entry is in the git tree. */
export declare function buildScaffolding(plan: Omit<FusePlan, 'taskBook' | 'scaffolding'>): FuseFile[];
/** One entry point for both the command and the tool. Phase 1 returns the task
 * book only; phase 2 (--apply) additionally returns the files to write. */
export declare function buildFusePlan(index: MarketIndex, input: string | string[]): FusePlan;
export interface FuseResult {
    ok: true;
    plan: FusePlan;
    phase: 'task-book' | 'applied';
    text: string;
    files: FuseFile[];
}
export declare function runFuse(index: MarketIndex, input: string | string[], apply: boolean): FuseResult;
export declare function renderFuseRejection(error: FuseValidationError | string): string;
