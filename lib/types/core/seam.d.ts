/** Runtime seam detection for the host `plugin_manager`.
 *
 * The authoritative check is cordis_inspect_query in a live dsh session; at
 * runtime we probe the shapes we can actually call. Missing seam => degraded
 * mode with copy-pasteable commands, never a fake success.
 *
 * A cordis Context is a proxy: reading a service that is not declared in
 * `inject` throws (`pluginManager without inject`) instead of returning
 * undefined. So every candidate read is guarded, and `ctx.reflect.get()` is
 * tried first because it is the inject-free accessor cordis provides. */
import type { InstallSeam, SeamProbe } from './install-types.ts';
export declare function probeSeam(ctx: unknown): SeamProbe;
/** Adapt a probed host service to InstallSeam. Wraps every call so a seam
 * signature change becomes a readable failure instead of a thrown error. */
export declare function adaptSeam(probe: SeamProbe, ctx: unknown): InstallSeam | null;
/** Manual fallback text. Shown in degraded mode and in every failure's nextSteps. */
export declare function manualInstallCommands(spec: string, profile: string, groupId: string): string[];
