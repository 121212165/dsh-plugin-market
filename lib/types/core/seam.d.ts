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
export declare function quoteShellArgument(value: string, shell?: 'powershell' | 'posix'): string;
/** Manual fallback text. Shown in degraded mode and in every failure's nextSteps. */
export declare function manualInstallCommands(spec: string, profile: string, groupId: string, shell?: 'powershell' | 'posix'): string[];
/** F5: in-process equivalent of `dsh --dump-config`. The authoritative CLI
 * output is captured on the real machine; inside a session the only safe read
 * of "what is actually mounted" is the host seam's own inventory. We render
 * it as raw text so the live loop can report it verbatim. Never throws. */
export declare function dumpConfigView(seam: InstallSeam | null): Promise<string>;
/** F5: best-effort invocation of one declared member entry through the host
 * command service. Cordis/command-service shapes differ, so every access is
 * guarded; when the host does not expose an executor we say so instead of
 * pretending the entry was called. */
export declare function callEntryViaContext(ctx: unknown, entry: string): Promise<string>;
