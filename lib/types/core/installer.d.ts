import type { ApplicationState, ChangeResultLike, FourStateLine, InstallReport, InstallSeam, LiveLoopReport, VerificationReport } from './install-types.ts';
import type { MarketIndex } from './types.ts';
export interface InstallInput {
    groupId: string;
    index: MarketIndex;
    seam: InstallSeam | null;
    profile?: string;
    excluded?: string[] | undefined;
    reinstall?: boolean | undefined;
    registeredCommands?: string[] | undefined;
    now?: (() => number) | undefined;
    onProgress?: (line: string) => void;
    /** F5: hooks for the automatic post-install live loop. */
    dumpConfig?: (() => Promise<string> | string) | string | undefined;
    callEntry?: ((entry: string) => Promise<string> | string) | undefined;
    ctx?: unknown;
}
export interface VerifyInput {
    groupId: string;
    index: MarketIndex;
    seam: InstallSeam | null;
    applicationByMember?: Record<string, ApplicationState>;
    registeredCommands?: string[] | undefined;
    profile?: string;
    now?: (() => number) | undefined;
}
/** F5: inputs for the automatic post-install live loop. Both IO hooks are
 * optional so tests can inject deterministic raw output; in production they
 * default to the seam view and ctx.commands.execute via seam.ts. */
export interface LiveLoopInput {
    groupId: string;
    index: MarketIndex;
    seam: InstallSeam | null;
    /** `application` from each member's ChangeResult during install. */
    applicationByMember: Record<string, ApplicationState>;
    profile?: string;
    registeredCommands?: string[] | undefined;
    /** Raw dump-config text (or a provider); defaults to dumpConfigView(seam). */
    dumpConfig?: (() => Promise<string> | string) | string | undefined;
    /** Invoke a declared entry once; defaults to callEntryViaContext. */
    callEntry?: ((entry: string) => Promise<string> | string) | undefined;
    /** Host context, used only by the default callEntry hook. */
    ctx?: unknown;
    now?: (() => number) | undefined;
}
/** F5: one wording table for all four application states. `overridden` is
 * deliberately explicit ("被更高优先级层覆盖") so it can never be confused
 * with a generic failure. Every state carries a concrete next step. */
export declare const FOUR_STATE_GUIDANCE: Record<ApplicationState, {
    label: string;
    nextStep: string;
}>;
/** Render a single four-state line with its next step. */
export declare function renderFourStateLine(state: ApplicationState, member: string, detail?: string): FourStateLine;
/** Map a host failure code to a step the user can actually take. */
export declare function nextStepsFor(result: ChangeResultLike, spec: string, profile: string): string[];
/** Verify what actually mounted, not what we intended to mount. */
export declare function verifyGroup(input: VerifyInput): Promise<VerificationReport>;
/** Full install flow. `seam === null` means degraded: we return manual steps
 * and never claim anything was installed. */
export declare function runGroupInstall(input: InstallInput): Promise<InstallReport>;
/** Render the full report for both the command and the model-facing tool. */
export declare function renderInstallReport(report: InstallReport): string;
/** Exposed so tests and the command can verify without reinstalling. */
export declare function runVerify(input: VerifyInput & {
    profile?: string;
}): Promise<string>;
/** F5: the automatic post-install live loop — dump-config → one entry call →
 * four-state report. Four-state semantics are reused: `verifyGroup` supplies
 * the verification and `FOUR_STATE_GUIDANCE` only adds explicit wording. */
export declare function runPostInstallLoop(input: LiveLoopInput): Promise<LiveLoopReport>;
