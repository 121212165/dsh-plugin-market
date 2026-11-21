/**
 * dsh wiring for the market (M1 read + M2 one-click install).
 * `/market` dispatches group / install / verify / seams; every IO path is
 * behind RuntimeDeps so assembly tests can block hosts, swap the host seam
 * and assert the four application states deterministically.
 */
import { readFileSync } from 'node:fs';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_CACHE_TTL_MS, DEFAULT_MIRROR_URL, DEFAULT_RAW_URL, DEFAULT_STALE_AFTER_MS, DEFAULT_TIMEOUT_MS, parseMarketArgs, readMarket, renderGroup, renderList, renderStamp, renderInstallReport, runGroupInstall, runVerify, probeSeam, adaptSeam, manualInstallCommands, } from './core/index.js';
export const name = 'market';
export const inject = ['commands', 'tools'];
export const Config = Schema.object({
    enabled: Schema.boolean().default(true),
    rawUrl: Schema.string().default(DEFAULT_RAW_URL),
    mirrorUrl: Schema.string().default(DEFAULT_MIRROR_URL),
    cachePath: Schema.string().default('~/.dsh/market/index.json'),
    timeoutMs: Schema.natural().default(DEFAULT_TIMEOUT_MS),
    cacheTtlMs: Schema.natural().default(DEFAULT_CACHE_TTL_MS),
    staleAfterMs: Schema.natural().default(DEFAULT_STALE_AFTER_MS),
    profile: Schema.string().default('web'),
    allowInstall: Schema.boolean().default(true),
});
function expandHome(value) {
    if (value === '~')
        return homedir();
    if (value.startsWith('~/') || value.startsWith('~\\'))
        return join(homedir(), value.slice(2));
    return value;
}
function defaultFetch(url, timeoutMs) {
    return fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' },
    }).then((response) => {
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
        return response.text();
    });
}
function readEmbeddedSnapshot() {
    const candidates = [
        new URL('./snapshot.json', import.meta.url),
        new URL('../src/snapshot.json', import.meta.url),
    ];
    for (const candidate of candidates) {
        try {
            return readFileSync(candidate, 'utf8');
        }
        catch {
            // try next location (src during dev/tests, lib after build)
        }
    }
    return '';
}
function normalizeConfig(input) {
    return {
        enabled: input.enabled ?? true,
        rawUrl: input.rawUrl ?? DEFAULT_RAW_URL,
        mirrorUrl: input.mirrorUrl ?? DEFAULT_MIRROR_URL,
        cachePath: input.cachePath ?? '~/.dsh/market/index.json',
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        cacheTtlMs: input.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
        staleAfterMs: input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
        profile: input.profile ?? 'web',
        allowInstall: input.allowInstall ?? true,
    };
}
/** Parse `--without a,b` / `--reinstall` from the rest of the install args. */
function parseInstallOptions(rest) {
    const excluded = [];
    let reinstall = false;
    for (let index = 0; index < rest.length; index++) {
        const token = rest[index];
        if (token === '--reinstall') {
            reinstall = true;
            continue;
        }
        if (token.startsWith('--without=')) {
            excluded.push(...token.slice('--without='.length).split(',').filter(Boolean));
            continue;
        }
        if (token === '--without' && rest[index + 1]) {
            excluded.push(...String(rest[++index]).split(',').filter(Boolean));
        }
    }
    return { excluded: [...new Set(excluded)], reinstall };
}
export function apply(ctx, configInput, deps = {}) {
    const config = normalizeConfig(configInput);
    const log = ctx.logger('market');
    if (!config.enabled) {
        log.info('disabled by config');
        return;
    }
    const cachePath = expandHome(config.cachePath);
    const readerDeps = {
        fetchText: deps.fetchText ?? defaultFetch,
        readCache: deps.readCache ?? (async () => {
            try {
                const info = await stat(cachePath);
                if (Date.now() - info.mtimeMs > config.cacheTtlMs)
                    return null;
                return await readFile(cachePath, 'utf8');
            }
            catch {
                return null;
            }
        }),
        writeCache: deps.writeCache ?? (async (text) => {
            await mkdir(dirname(cachePath), { recursive: true });
            await writeFile(cachePath, text, 'utf8');
        }),
        embedded: deps.embedded ?? readEmbeddedSnapshot(),
        rawUrl: config.rawUrl,
        mirrorUrl: config.mirrorUrl,
        timeoutMs: config.timeoutMs,
        cacheTtlMs: config.cacheTtlMs,
        staleAfterMs: config.staleAfterMs,
        now: deps.now,
        log: (message) => log.info(message),
    };
    const read = () => readMarket(readerDeps);
    // M2 seam: a missing plugin_manager degrades to manual commands, never to a
    // fake "installed" report. Resolution is per call, not startup-only: the host
    // may register plugin_manager after this plugin mounts, so every install /
    // verify / seams path re-probes and picks up late registration without a
    // reload. Tests override both probe and seam deterministically.
    const resolveSeam = () => {
        if (deps.seam) {
            return {
                probe: deps.seamProbe ?? {
                    available: true,
                    source: deps.seam.source,
                    checked: ['deps.seam'],
                    methods: ['installBundle'],
                    note: '测试注入的安装 seam',
                },
                seam: deps.seam,
            };
        }
        const probe = deps.seamProbe ?? probeSeam(ctx);
        return { probe, seam: config.allowInstall ? adaptSeam(probe, ctx) : null };
    };
    const startup = resolveSeam();
    const registeredCommands = () => {
        if (deps.registeredCommands)
            return deps.registeredCommands();
        const capture = ctx;
        return typeof capture.commands?.list === 'function'
            ? capture.commands.list().map((command) => String(command.name ?? ''))
            : [];
    };
    log.info(startup.seam
        ? `install seam available · ${startup.seam.source}`
        : `install seam unavailable · ${startup.probe.note}`);
    ctx.commands.register({
        name: 'market',
        description: '插件市集：/market 列组，/market group <id> 看详情，/market install <id> 一键安装（含冲突预检与四态校验），/market verify <id> 只校验，/market seams 查宿主安装能力。断网用内置快照。',
        input: { hint: '[group <id> | install <id> [--without a,b] [--reinstall] | verify <id> | seams]' },
        handler: async ({ rawInput }) => {
            const args = parseMarketArgs(rawInput);
            try {
                // seams is read-only and needs no snapshot; keep it available even if data is empty.
                if (args.subcommand === 'seams') {
                    const { probe, seam } = resolveSeam();
                    const lines = [
                        '宿主安装能力（plugin_manager seam）',
                        `  状态：${probe.available ? '可用' : '不可用 → 降级为手动命令'}`,
                        `  来源：${probe.source || '(无)'}`,
                        `  已检查：${probe.checked.join('、')}`,
                        `  方法：${probe.methods.join(', ') || '(无)'}`,
                        `  说明：${probe.note}`,
                    ];
                    if (!seam)
                        lines.push('', '手动安装模板：', ...manualInstallCommands('<npm 包或本地路径>', config.profile, '<groupId>').map((line) => `  ${line}`));
                    return { kind: 'success', text: lines.join('\n') };
                }
                if (args.subcommand === 'help') {
                    return {
                        kind: 'success',
                        text: '用法：/market 列组 · /market group <id> 详情 · /market install <id> 一键安装 · /market install <id> --without a,b 跳过冲突成员 · /market verify <id> 校验四态 · /market seams 查安装能力',
                    };
                }
                const result = await read();
                const shortcutGroup = args.subcommand === 'list' && args.target && result.index.groups.some((group) => group.id === args.target);
                if (args.subcommand === 'group' || shortcutGroup) {
                    return { kind: 'success', text: renderGroup(result, args.target) };
                }
                if (args.subcommand === 'install') {
                    const options = parseInstallOptions(args.rest);
                    const report = await runGroupInstall({
                        groupId: args.target,
                        index: result.index,
                        seam: resolveSeam().seam,
                        profile: config.profile,
                        registeredCommands: registeredCommands(),
                        now: deps.now,
                        ...options,
                    });
                    return { kind: report.ok ? 'success' : 'error', text: renderInstallReport(report) };
                }
                if (args.subcommand === 'verify') {
                    const text = await runVerify({
                        groupId: args.target,
                        index: result.index,
                        seam: resolveSeam().seam,
                        profile: config.profile,
                        registeredCommands: registeredCommands(),
                        now: deps.now,
                    });
                    return { kind: 'success', text };
                }
                return { kind: 'success', text: renderList(result) };
            }
            catch (error) {
                // Defense in depth: a rendering/orchestration bug must surface as a
                // readable error with next steps, never as an unhandled handler throw.
                return {
                    kind: 'error',
                    text: `市集操作失败：${error instanceof Error ? error.message : String(error)}\n下一步：/market seams 检查安装能力；/market group <id> 复核组数据；必要时按 dsh plugin --profile ${config.profile} list 手动处理。`,
                };
            }
        },
    });
    ctx.tools.register(defineTool({
        name: 'market_list',
        description: '只读列出 dsh 插件市集的插件组（含快照时间与来源层）；无需账号、不修改任何配置。',
        parameters: {
            groupId: { type: 'string', description: '可选，查看某个组的详情（成员、真实协同点、验收步骤）' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value).slice(0, 4000) }],
        },
        presentCall: (args) => ({
            card: 'generic',
            title: args.groupId ? `插件组详情：${args.groupId}` : '插件市集（只读）',
            kind: 'fetch',
        }),
        presentResult: () => ({
            card: 'generic',
            title: '插件市集',
            kind: 'fetch',
        }),
        async execute(args) {
            const result = await read();
            const text = args.groupId ? renderGroup(result, args.groupId) : renderList(result);
            return `${renderStamp(result.meta)}\n\n${text}`;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'market_install',
        description: '按组一键安装 dsh 插件：先做命令名/工具名/包名/slot 冲突预检，再按 members 顺序调用宿主 plugin_manager.installBundle，最后用 application 四态与 listPlugins 校验是否真正生效。冲突时返回可执行修复建议；seam 不可用时只给手动命令，不假装成功。',
        parameters: {
            groupId: { type: 'string', required: true, description: '插件组 id，如 archive-chain' },
            without: { type: 'string', description: '可选，逗号分隔的跳过的成员 id' },
            reinstall: { type: 'boolean', description: '可选，重新安装已存在的成员' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value).slice(0, 6000) }],
        },
        presentCall: (args) => ({
            card: 'generic',
            title: args.without ? `安装插件组 ${args.groupId}（跳过 ${args.without}）` : `安装插件组 ${args.groupId}`,
            kind: 'execute',
            rawInput: args.groupId,
        }),
        presentResult: (_args, value) => ({
            card: 'generic',
            title: '插件组安装报告',
            kind: 'execute',
            rawInput: String(value).slice(0, 4000),
        }),
        async execute(args) {
            const result = await read();
            const report = await runGroupInstall({
                groupId: String(args.groupId ?? ''),
                index: result.index,
                seam: resolveSeam().seam,
                profile: config.profile,
                registeredCommands: registeredCommands(),
                now: deps.now,
                excluded: String(args.without ?? '').split(',').map((part) => part.trim()).filter(Boolean),
                reinstall: args.reinstall === true,
            });
            return `${renderStamp(result.meta)}\n\n${renderInstallReport(report)}`;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'market_verify',
        description: '只校验某个插件组的安装结果：对照宿主 listPlugins 的行状态与 application 四态，逐成员报告 applied / restart-required / overridden / failed 及下一步。不执行安装。',
        parameters: {
            groupId: { type: 'string', required: true, description: '插件组 id' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value).slice(0, 4000) }],
        },
        presentCall: (args) => ({
            card: 'generic',
            title: `校验插件组 ${args.groupId}`,
            kind: 'fetch',
        }),
        presentResult: () => ({ card: 'generic', title: '插件组生效校验', kind: 'fetch' }),
        async execute(args) {
            const result = await read();
            return runVerify({
                groupId: String(args.groupId ?? ''),
                index: result.index,
                seam: resolveSeam().seam,
                profile: config.profile,
                registeredCommands: registeredCommands(),
                now: deps.now,
            });
        },
    }));
    log.info(`mounted · ${startup.seam ? 'install-ready' : 'read-only + manual-install guidance'} · cache=${cachePath}`);
}
