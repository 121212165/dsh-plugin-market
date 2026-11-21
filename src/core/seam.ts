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
import type { ChangeResultLike, InstallSeam, SeamProbe } from './install-types.ts';

type UnknownCtx = Record<string, any>;

const REQUIRED = ['installBundle', 'listPlugins', 'listBundles'] as const;

/** Read one candidate without letting a ctx proxy abort the whole probe. */
function safeRead<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Every shape worth checking, reflect first: it is the only inject-free read
 * cordis guarantees not to throw. Plain-object hosts fall through to the rest. */
function candidates(root: UnknownCtx): [string, unknown][] {
  return [
    [
      "ctx.reflect.get('pluginManager')",
      safeRead(() => {
        const reflect = root.reflect;
        return typeof reflect?.get === 'function' ? reflect.get('pluginManager') : undefined;
      }),
    ],
    ['ctx.pluginManager', safeRead(() => root.pluginManager)],
    ['ctx.remotes.pluginManager', safeRead(() => root.remotes?.pluginManager)],
    ['ctx.remote.pluginManager', safeRead(() => root.remote?.pluginManager)],
    ['ctx.services.pluginManager', safeRead(() => root.services?.pluginManager)],
  ];
}

export function probeSeam(ctx: unknown): SeamProbe {
  const root = (ctx ?? {}) as UnknownCtx;
  const list = candidates(root);
  const checked = list.map(([name]) => name);
  for (const [source, candidate] of list) {
    if (!candidate || typeof candidate !== 'object') continue;
    const methods = safeRead(() =>
      REQUIRED.filter((name) => typeof (candidate as UnknownCtx)[name] === 'function'),
    ) ?? [];
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
    note: '未发现可用的 plugin_manager seam；安装已降级为“复制命令 + 装完手动校验”，不会假装成功；若刚启用 plugin_manager，重启或重跑本命令',
  };
}

/** Adapt a probed host service to InstallSeam. Wraps every call so a seam
 * signature change becomes a readable failure instead of a thrown error. */
export function adaptSeam(probe: SeamProbe, ctx: unknown): InstallSeam | null {
  if (!probe.available) return null;
  const root = (ctx ?? {}) as UnknownCtx;
  const resolved = candidates(root).find(([, candidate]) => {
    if (!candidate || typeof candidate !== 'object') return false;
    return safeRead(() => typeof (candidate as UnknownCtx).installBundle === 'function') === true;
  });
  const service: UnknownCtx = (resolved?.[1] as UnknownCtx | undefined) ?? {};
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
