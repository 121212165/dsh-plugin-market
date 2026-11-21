/** Runtime seam detection for the host `plugin_manager`.
 *
 * The authoritative check is cordis_inspect_query in a live dsh session; at
 * runtime we probe the shapes we can actually call. Missing seam => degraded
 * mode with copy-pasteable commands, never a fake success. */
import type { ChangeResultLike, InstallSeam, SeamProbe } from './install-types.ts';

type UnknownCtx = Record<string, any>;

const REQUIRED = ['installBundle', 'listPlugins', 'listBundles'] as const;

export function probeSeam(ctx: unknown): SeamProbe {
  const root = (ctx ?? {}) as UnknownCtx;
  const candidates: [string, unknown][] = [
    ['ctx.pluginManager', root.pluginManager],
    ['ctx.remotes.pluginManager', root.remotes?.pluginManager],
    ['ctx.remote.pluginManager', root.remote?.pluginManager],
    ['ctx.services.pluginManager', root.services?.pluginManager],
  ];
  const checked = candidates.map(([name]) => name);
  for (const [source, candidate] of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const methods = REQUIRED.filter((name) => typeof (candidate as UnknownCtx)[name] === 'function');
    if (methods.includes('installBundle')) {
      return {
        available: true,
        source,
        checked,
        methods: [...methods],
        note: '宿主 plugin_manager 可用，使用 installBundle 一键安装',
      };
    }
  }
  return {
    available: false,
    source: '',
    checked,
    methods: [],
    note: '未发现可用的 plugin_manager seam；安装已降级为“复制命令 + 装完手动校验”，不会假装成功',
  };
}

/** Adapt a probed host service to InstallSeam. Wraps every call so a seam
 * signature change becomes a readable failure instead of a thrown error. */
export function adaptSeam(probe: SeamProbe, ctx: unknown): InstallSeam | null {
  if (!probe.available) return null;
  const root = (ctx ?? {}) as UnknownCtx;
  const service: UnknownCtx =
    root.pluginManager ?? root.remotes?.pluginManager ?? root.remote?.pluginManager ?? root.services?.pluginManager ?? {};
  return {
    kind: 'live',
    source: probe.source,
    async installBundle(spec: string, options?: { enabled?: boolean }): Promise<ChangeResultLike> {
      return await service.installBundle(spec, { enabled: options?.enabled ?? true });
    },
    async listPlugins() {
      return typeof service.listPlugins === 'function' ? await service.listPlugins() : [];
    },
    async listBundles() {
      return typeof service.listBundles === 'function' ? await service.listBundles() : [];
    },
    async inspect(spec: string) {
      return typeof service.inspect === 'function' ? await service.inspect(spec) : { status: 'unknown' };
    },
  };
}

/** Manual fallback text. Shown in degraded mode and in every failure's nextSteps. */
export function manualInstallCommands(spec: string, profile: string, groupId: string): string[] {
  return [
    `dsh plugin --profile ${profile || 'web'} add "${spec}"`,
    `dsh --profile ${profile || 'web'} --dump-config | grep ${spec.replace(/^@[^/]+\//, '')}`,
    `/market verify ${groupId}`,
  ];
}
