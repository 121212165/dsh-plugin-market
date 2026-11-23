export type DoctorPriority = 'P0' | 'P1' | 'P2';
export type GateSeverity = 'FAIL' | 'WARN';
export interface DoctorIssue {
    /** Gate code from the vendor output (G0-5/6/7/8/9/10, SDS-1/1b/2/3) or G0-VENDOR. */
    code: string;
    /** P0 = release blocker, P1 = should fix, P2 = suggestion. */
    priority: DoctorPriority;
    severity: GateSeverity;
    /** Original gate message, kept verbatim so the verdict is traceable. */
    message: string;
    /** Exact file / JSON key to edit. */
    location: string;
    /** Concrete code or command — never "consider improving". */
    fix: string;
}
export interface DoctorCounts {
    P0: number;
    P1: number;
    P2: number;
}
export interface DoctorReport {
    target: string;
    /** True only when there are no P0 issues. */
    ok: boolean;
    counts: DoctorCounts;
    issues: DoctorIssue[];
    gateSource: string;
    note: string;
}
/** Minimal shape needed for remedy enrichment; the vendor tool owns full validation. */
export interface PackageSnapshot {
    name?: string;
    license?: string;
    exports?: Record<string, unknown>;
    files?: string[];
    engines?: {
        node?: string;
    };
    repository?: {
        url?: string;
    };
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    [key: string]: unknown;
}
export interface ParsedGateLine {
    severity: GateSeverity;
    code: string | null;
    message: string;
    raw: string;
}
export interface DoctorOptions {
    target: string;
    /** Override for tests; resolved to the repo's vendored checker by default. */
    vendorScript?: string;
}
export type DoctorRunner = (target: string) => Promise<DoctorReport>;
/** Parse the vendor checker's `FAIL:` / `WARN:` sections (no re-judgement). */
export declare function parseVendorOutput(stdout: string): ParsedGateLine[];
export declare function priorityFor(severity: GateSeverity, code: string | null): DoctorPriority;
/** Run the vendored gate on a local plugin repo and turn its verdict into an actionable list. */
export declare function runDoctor(options: DoctorOptions): Promise<DoctorReport>;
/** Shared with the `/market doctor` command and the `market_doctor` model tool. */
export declare function renderDoctorReport(report: DoctorReport): string;
