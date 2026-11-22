import type { ApplicationState, ChangeResultLike, InstallReport, InstallSeam, VerificationReport } from './install-types.ts';
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
}
export interface VerifyInput {
    groupId: string;
    index: MarketIndex;
    seam: InstallSeam | null;
    applicationByMember?: Record<string, ApplicationState>;
    memberIds?: string[];
    registeredCommands?: string[] | undefined;
    profile?: string;
    now?: (() => number) | undefined;
}
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
