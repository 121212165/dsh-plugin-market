const REQUIRED = ['installBundle', 'listPlugins', 'listBundles'];
/** Read one candidate without letting a ctx proxy abort the whole probe. */
function safeRead(read) {
    try {
        return read();
    }
    catch {
        return undefined;
    }
}
/** Every shape worth checking, reflect first: it is the only inject-free read
 * cordis guarantees not to throw. Plain-object hosts fall through to the rest. */
function candidates(root) {
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
export function probeSeam(ctx) {
    const root = (ctx ?? {});
    const list = candidates(root);
    const checked = list.map(([name]) => name);
    for (const [source, candidate] of list) {
        if (!candidate || typeof candidate !== 'object')
            continue;
        const methods = safeRead(() => REQUIRED.filter((name) => typeof candidate[name] === 'function')) ?? [];
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
export function adaptSeam(probe, ctx) {
    if (!probe.available)
        return null;
    const root = (ctx ?? {});
    const resolved = candidates(root).find(([, candidate]) => {
        if (!candidate || typeof candidate !== 'object')
            return false;
        return safeRead(() => typeof candidate.installBundle === 'function') === true;
    });
    const service = resolved?.[1] ?? {};
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
/** Quote a value as one POSIX shell argument. */
function shellQuote(value) {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}
/** Manual fallback text. Shown in degraded mode and in every failure's nextSteps. */
export function manualInstallCommands(spec, profile, groupId) {
    const safeProfile = shellQuote(profile || 'web');
    const packageName = spec.replace(/^@[^/]+\//, '');
    return [
        `dsh plugin --profile ${safeProfile} add ${shellQuote(spec)}`,
        `dsh --profile ${safeProfile} --dump-config | grep -F -- ${shellQuote(packageName)}`,
        `/market verify ${groupId}`,
    ];
}
