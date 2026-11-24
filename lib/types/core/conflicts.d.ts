/** Pure conflict pre-check for group installs. No IO; every conflict carries
 * a copy-pasteable fix. The red line: never let a collision reach startup as
 * "command already registered" — warn here with an actionable alternative. */
import type { InstallPlan, InstalledBundle, InstalledRow } from './install-types.ts';
import type { GroupEntry, MarketIndex, PluginEntry } from './types.ts';
export interface PrecheckInput {
    group: GroupEntry;
    index: MarketIndex;
    inventory?: {
        plugins?: InstalledRow[];
        bundles?: InstalledBundle[];
    };
    /** Command names already registered in the host, e.g. from ctx.commands. */
    registeredCommands?: string[] | undefined;
    /** Only when the caller can read the registry; server runtime cannot access browser ctx.slots. */
    registeredSlots?: string[] | undefined;
    /** Group member ids the user chose to drop with `--without`. */
    excluded?: string[] | undefined;
    profile?: string;
    reinstall?: boolean | undefined;
}
/** Check collisions inside the group and against the live host inventory. */
export declare function planGroupInstall(input: PrecheckInput): InstallPlan;
/** Install spec: local fixture paths win (clean-profile tests), then the GitHub
 * repo (the `npm` names in the catalog were never published — installing them
 * 404s), npm only as a last resort. */
export declare function specFor(plugin: PluginEntry | undefined): string;
/** Human-readable pre-check block, reused by the command and the tool. */
export declare function renderConflicts(plan: InstallPlan): string;
