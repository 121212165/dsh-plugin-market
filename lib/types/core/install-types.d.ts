/** M2 install contract. Pure types only — no dsh imports, no IO. */
export type ApplicationState = 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled';
export interface ChangeResultLike {
    changed: boolean;
    application: ApplicationState;
    stage: 'install' | 'enable' | 'remove';
    target: string;
    enabled?: boolean;
    error?: {
        code?: string;
        diagnostic?: string;
    };
    warnings?: string[];
    packageResult?: {
        exitCode: number;
        output?: string;
        logPath?: string;
        kind?: string;
        timedOut?: boolean;
    };
    pendingBuilds?: string[];
    bundle?: string;
}
export interface InstalledRow {
    id: string;
    /** Real dsh hosts identify loader rows by `entryId`, not `id`. */
    entryId?: string;
    moduleName?: string;
    enabled: boolean;
    fiberPhase?: 'active' | 'failed' | 'pending' | 'loading' | 'unloading' | null;
    meta?: {
        title?: string;
    };
}
export interface InstalledBundle {
    name: string;
    enabled: boolean;
    rows?: {
        rowId: string;
        moduleName?: string;
    }[];
}
/** The seam we need from the host. Everything optional degrades gracefully. */
export interface InstallSeam {
    kind: 'live' | 'fake';
    source: string;
    installBundle(spec: string, options?: {
        enabled?: boolean;
    }): Promise<ChangeResultLike>;
    listPlugins?(): Promise<InstalledRow[]>;
    listBundles?(): Promise<InstalledBundle[]>;
    inspect?(spec: string): Promise<{
        status: string;
        problem?: string;
        reason?: string;
    }>;
}
export interface SeamProbe {
    available: boolean;
    source: string;
    checked: string[];
    methods: string[];
    note: string;
}
export type ConflictKind = 'command' | 'tool' | 'slot' | 'package' | 'already-installed' | 'missing-member' | 'dsh-range';
export interface Conflict {
    kind: ConflictKind;
    key: string;
    members: string[];
    detail: string;
    severity: 'blocking' | 'warn';
    /** Concrete, copy-pasteable next action — never a stack trace. */
    fix: string;
}
export interface PlannedStep {
    member: string;
    spec: string;
    action: 'install' | 'skip-installed' | 'skip-excluded';
    reason?: string;
}
export interface InstallPlan {
    groupId: string;
    steps: PlannedStep[];
    conflicts: Conflict[];
    blocked: boolean;
}
export interface InstallStepResult {
    member: string;
    spec: string;
    status: 'installing' | 'done' | 'skipped' | 'failed';
    application?: ApplicationState;
    detail: string;
    nextSteps: string[];
}
export interface VerificationMember {
    member: string;
    present: boolean;
    active: boolean;
    enabled: boolean;
    detail: string;
    nextSteps: string[];
}
export interface VerificationReport {
    groupId: string;
    members: VerificationMember[];
    ok: boolean;
    summary: string;
}
export interface InstallReport {
    groupId: string;
    mode: 'live' | 'degraded';
    startedAt: string;
    finishedAt: string;
    ok: boolean;
    summary: string;
    conflicts: Conflict[];
    steps: InstallStepResult[];
    verification: VerificationReport | null;
    nextSteps: string[];
    /** F5: the post-install live loop (dump-config → one entry call → four-state report). */
    liveLoop?: LiveLoopReport | null;
}
/** One line of the F5 four-state report: state name + explicit next step. */
export interface FourStateLine {
    member: string;
    application: ApplicationState;
    /** State name plus wording; `overridden` always says "被更高优先级层覆盖". */
    label: string;
    detail: string;
    nextStep: string;
}
/** Result of invoking one declared member entry during the live loop. */
export interface EntryProbeResult {
    entry: string;
    ok: boolean;
    /** Raw output from the host command, or the reason it could not be called. */
    output: string;
}
/** F5: what actually took effect after install, as observed through the host. */
export interface LiveLoopReport {
    groupId: string;
    /** Raw `dsh --dump-config` output, or the in-process seam view when unavailable. */
    dumpConfig: string;
    /** Member ids whose declaration appears in the dump-config output. */
    membersInDump: string[];
    /** The single member entry invoked once; null when no entry could be probed. */
    entry: EntryProbeResult | null;
    /** One line per member with the four-state label and its next step. */
    states: FourStateLine[];
    /** Reused from `verifyGroup` — F5 never re-implements four-state semantics. */
    verification: VerificationReport;
    ok: boolean;
    summary: string;
    startedAt: string;
    finishedAt: string;
}
export declare const APPLICATION_LABEL: Record<ApplicationState, string>;
