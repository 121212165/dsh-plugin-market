import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { type FuseFile, type InstallSeam, type ManifestStore, type ReaderDeps, type SeamProbe } from './core/index.ts';
export declare const name = "market";
export declare const inject: string[];
export interface Config {
    enabled: boolean;
    rawUrl: string;
    mirrorUrl: string;
    cachePath: string;
    timeoutMs: number;
    cacheTtlMs: number;
    staleAfterMs: number;
    /** Profile used only in manual fallback commands; install itself uses the current profile. */
    profile: string;
    /** Kill switch for the write path (read stays available). */
    allowInstall: boolean;
    /** Output directory for F3 fuse scaffolding (only written with --apply). */
    fuseOutDir: string;
}
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    enabled: Schema<boolean, boolean, "defined">;
    rawUrl: Schema<string, string, "defined">;
    mirrorUrl: Schema<string, string, "defined">;
    cachePath: Schema<string, string, "defined">;
    timeoutMs: Schema<number, number, "defined">;
    cacheTtlMs: Schema<number, number, "defined">;
    staleAfterMs: Schema<number, number, "defined">;
    profile: Schema<string, string, "defined">;
    allowInstall: Schema<boolean, boolean, "defined">;
    fuseOutDir: Schema<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: Schema<boolean, boolean, "defined">;
    rawUrl: Schema<string, string, "defined">;
    mirrorUrl: Schema<string, string, "defined">;
    cachePath: Schema<string, string, "defined">;
    timeoutMs: Schema<number, number, "defined">;
    cacheTtlMs: Schema<number, number, "defined">;
    staleAfterMs: Schema<number, number, "defined">;
    profile: Schema<string, string, "defined">;
    allowInstall: Schema<boolean, boolean, "defined">;
    fuseOutDir: Schema<string, string, "defined">;
}>>, "plain">;
/** Optional overrides; every field has a production default. */
export interface RuntimeDeps {
    fetchText?: ReaderDeps['fetchText'];
    readCache?: ReaderDeps['readCache'];
    writeCache?: ReaderDeps['writeCache'];
    embedded?: string;
    /** F6: manifest snapshot/restore hook for group uninstall/rollback. */
    manifest?: ManifestStore;
    now?: () => number;
    /** Host install seam; tests inject a fake, production probes ctx.pluginManager. */
    seam?: InstallSeam;
    seamProbe?: SeamProbe;
    /** Current host command names, for live command-collision pre-checks. */
    registeredCommands?: () => string[];
    /** F3: injected writer captures scaffold files in tests; production writes disk. */
    fuseWriter?: (root: string, files: FuseFile[]) => Promise<Array<{
        path: string;
        action: string;
    }>>;
}
export declare function apply(ctx: Context, configInput: Partial<Config> | Config, deps?: RuntimeDeps): void;
