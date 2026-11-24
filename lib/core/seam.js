const REQUIRED = ['installBundle', 'listPlugins', 'listBundles'];
/** F6: optional host method — uninstall degrades to manual commands without it. */
const OPTIONAL = ['removeBundle'];
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
        const optional = safeRead(() => OPTIONAL.filter((name) => typeof candidate[name] === 'function')) ?? [];
        if (REQUIRED.every((name) => methods.includes(name))) {
            return {
                available: true,
                source,
                checked,
                methods: [...methods, ...optional],
                note: optional.includes('removeBundle')
                    ? '宿主 plugin_manager 可用，支持 installBundle 一键安装与 removeBundle 组卸载'
                    : '宿主 plugin_manager 可用，使用 installBundle 一键安装（无 removeBundle，卸载仅给手动命令）',
            };
        }
    }
    return {
        available: false,
        source: '',
        checked,
        methods: [],
        note: `未发现完整的 plugin_manager seam（需要 ${REQUIRED.join('/')}）；安装已降级为“复制命令 + 装完手动校验”，不会假装成功；若刚启用 plugin_manager，重启或重跑本命令`,
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
        async removeBundle(spec) {
            if (typeof service.removeBundle !== 'function') {
                return {
                    changed: false, application: 'failed', stage: 'remove', target: spec,
                    error: { code: 'unsupported', diagnostic: '宿主 plugin_manager 未提供 removeBundle' },
                };
            }
            return await service.removeBundle(spec);
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
/** Quote one argument for the shell used by the host's copy/paste instructions. */
const POSIX_SINGLE_QUOTE_ESCAPE = ["'", '"', "'", '"', "'"].join('');
export function quoteShellArgument(value, shell = process.platform === 'win32' ? 'powershell' : 'posix') {
    if (/[\r\n\0]/.test(value))
        throw new Error('shell argument must not contain line breaks or NUL');
    return shell === 'powershell'
        ? `'${value.replace(/'/g, "''")}'`
        : `'${value.replace(/'/g, POSIX_SINGLE_QUOTE_ESCAPE)}'`;
}
/** Manual fallback text. Shown in degraded mode and in every failure's nextSteps. */
export function manualInstallCommands(spec, profile, groupId, shell = process.platform === 'win32' ? 'powershell' : 'posix') {
    const safeProfile = quoteShellArgument(profile || 'web', shell);
    const safeSpec = quoteShellArgument(spec, shell);
    const packageName = quoteShellArgument(spec.replace(/^@[^/]+\//, ''), shell);
    const lookup = shell === 'powershell'
        ? `Select-String -SimpleMatch -Pattern ${packageName}`
        : `grep -F -- ${packageName}`;
    return [
        `dsh plugin --profile ${safeProfile} add ${safeSpec}`,
        `dsh --profile ${safeProfile} --dump-config | ${lookup}`,
        `/market verify ${groupId}`,
    ];
}
/** F5: in-process equivalent of `dsh --dump-config`. The authoritative CLI
 * output is captured on the real machine; inside a session the only safe read
 * of "what is actually mounted" is the host seam's own inventory. We render
 * it as raw text so the live loop can report it verbatim. Never throws. */
export async function dumpConfigView(seam) {
    if (!seam)
        return '(seam 不可用：无法读取宿主安装清单)';
    const [rows, bundles] = await Promise.all([
        (seam.listPlugins?.() ?? Promise.resolve([])).catch(() => []),
        (seam.listBundles?.() ?? Promise.resolve([])).catch(() => []),
    ]);
    const lines = ['# == installed plugins (dump-config view)'];
    for (const row of rows) {
        const id = row.id || row.entryId || row.moduleName || '?';
        lines.push(`- id: ${id}`, `  moduleName: ${row.moduleName ?? ''}`, `  enabled: ${row.enabled}`, `  fiberPhase: ${row.fiberPhase ?? 'unknown'}`);
    }
    lines.push('# == installed bundles');
    for (const bundle of bundles)
        lines.push(`- name: ${bundle.name}  enabled: ${bundle.enabled}`);
    if (!rows.length && !bundles.length)
        lines.push('(清单为空)');
    return lines.join('\n');
}
/** F5: best-effort invocation of one declared member entry through the host
 * command service. Cordis/command-service shapes differ, so every access is
 * guarded; when the host does not expose an executor we say so instead of
 * pretending the entry was called. */
export async function callEntryViaContext(ctx, entry) {
    const commands = ctx?.commands;
    if (!commands || typeof commands.execute !== 'function') {
        throw new Error('宿主未暴露 commands.execute：入口仅完成可见性探测，未实际调用');
    }
    const value = await commands.execute(entry);
    return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}
