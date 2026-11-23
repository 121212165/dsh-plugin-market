import type { InstallSeam, ManifestStore, UninstallReport } from './install-types.ts';
import type { MarketIndex } from './types.ts';
export interface UninstallInput {
    groupId: string;
    index: MarketIndex;
    seam: InstallSeam | null;
    profile?: string;
    now?: (() => number) | undefined;
    /** Manifest snapshot/restore hook. Omit → host manifest is left untouched. */
    manifest?: ManifestStore | undefined;
    onProgress?: (line: string) => void;
}
/** Production manifest IO. `DSH_HOME` lets real-device runs point at an
 * isolated profile; every read is best-effort, writes only restore a snapshot. */
export declare function createProfileManifestStore(profile: string): ManifestStore;
/** Roll a group back to its pre-install manifest, members in reverse order. */
export declare function uninstallGroup(input: UninstallInput): Promise<UninstallReport>;
/** Human-readable report for both the command and the model-facing tool. */
export declare function renderUninstallReport(report: UninstallReport): string;
