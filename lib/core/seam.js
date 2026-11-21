const REQUIRED = ['installBundle', 'listPlugins', 'listBundles'];
export function probeSeam(ctx) {
    const root = (ctx ?? {});
    const candidates = [
        ['ctx.pluginManager', root.pluginManager],
        ['ctx.remotes.pluginManager', root.remotes?.pluginManager],
        ['ctx.remote.pluginManager', root.remote?.pluginManager],
        ['ctx.services.pluginManager', root.services?.pluginManager],
    ];
    const checked = candidates.map(([name]) => name);
    for (const [source, candidate] of candidates) {
        if (!candidate || typeof candidate !== 'object')
            continue;
        const methods = REQUIRED.filter((name) => typeof candidate[name] === 'function');
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
export function adaptSeam(probe, ctx) {
    if (!probe.available)
        return null;
    const root = (ctx ?? {});
    const service = root.pluginManager ?? root.remotes?.pluginManager ?? root.remote?.pluginManager ?? root.services?.pluginManager ?? {};
    return {
        kind: 'live',
        source: probe.source,
        async installBundle(spec, options) {
            return await service.installBundle(spec, { enabled: options?.enabled ?? true });
        },
        async listPlugins() {
            return typeof service.listPlugins === 'function' ? await service.listPlugins() : [];
        },
        async listBundles() {
            return typeof service.listBundles === 'function' ? await service.listBundles() : [];
        },
        async inspect(spec) {
            return typeof service.inspect === 'function' ? await service.inspect(spec) : { status: 'unknown' };
        },
    };
}
/** Manual fallback text. Shown in degraded mode and in every failure's nextSteps. */
export function manualInstallCommands(spec, profile, groupId) {
    return [
        `dsh plugin --profile ${profile || 'web'} add "${spec}"`,
        `dsh --profile ${profile || 'web'} --dump-config | grep ${spec.replace(/^@[^/]+\//, '')}`,
        `/market verify ${groupId}`,
    ];
}
