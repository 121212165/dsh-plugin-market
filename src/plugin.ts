/**
 * dsh wiring for the market (M1 read + M2 one-click install).
 * `/market` dispatches group / install / uninstall / verify / seams / fuse;
 * every IO path is behind RuntimeDeps so assembly tests can block hosts, swap
 * the host seam and assert the four application states deterministically. Fuse
 * is two-step: the task book is never written; only `--apply` writes scaffolding.
 */
import { readFileSync } from 'node:fs';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-tools';

import {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_MIRROR_URL,
  DEFAULT_RAW_URL,
  DEFAULT_STALE_AFTER_MS,
  DEFAULT_TIMEOUT_MS,
  parseMarketArgs,
  readMarket,
  renderGroup,
  renderList,
  renderStamp,
  renderInstallReport,
  runGroupInstall,
  runVerify,
  uninstallGroup,
  renderUninstallReport,
  createProfileManifestStore,
  probeSeam,
  adaptSeam,
  manualInstallCommands,
  runFuse,
  renderFuseRejection,
  FuseValidationError,
  type FuseFile,
  type InstallSeam,
  type ManifestStore,
  type MarketRead,
  type ReaderDeps,
  type SeamProbe,
} from './core/index.ts';

export const name = 'market';
export const inject = ['commands', 'tools'];

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
  fuseOutDir: Schema.string().default('./fused-plugin'),
});

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
  fuseWriter?: (root: string, files: FuseFile[]) => Promise<Array<{ path: string; action: string }>>;
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

function defaultFetch(url: string, timeoutMs: number): Promise<string> {
  return fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  }).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  });
}

function readEmbeddedSnapshot(): string {
  const candidates = [
    new URL('./snapshot.json', import.meta.url),
    new URL('../src/snapshot.json', import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      // try next location (src during dev/tests, lib after build)
    }
  }
  return '';
}

function normalizeConfig(input: Partial<Config> | Config): Config {
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
    fuseOutDir: input.fuseOutDir ?? './fused-plugin',
  };
}

/** F3 default scaffold writer: relative file paths under the configured dir. */
async function defaultFuseWriter(root: string, files: FuseFile[]): Promise<Array<{ path: string; action: string }>> {
  const written: Array<{ path: string; action: string }> = [];
  for (const file of files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
    written.push({ path: file.path, action: 'written' });
  }
  return written;
}

/** Parse `--without a,b` / `--reinstall` from the rest of the install args. */
function parseInstallOptions(rest: string[]): { excluded: string[]; reinstall: boolean } {
  const excluded: string[] = [];
  let reinstall = false;
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!;
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

/** F3 args: `/market fuse a,b [--apply]`. Flags stay out of the id list. */
function parseFuseArgs(target: string, rest: string[]): { ids: string; apply: boolean } {
  const apply = rest.includes('--apply');
  const ids = [target, ...rest.filter((token) => !token.startsWith('--'))].join(' ').trim();
  return { ids, apply };
}

export function apply(ctx: Context, configInput: Partial<Config> | Config, deps: RuntimeDeps = {}): void {
  const config = normalizeConfig(configInput);
  const log = ctx.logger('market');
  if (!config.enabled) {
    log.info('disabled by config');
    return;
  }

  const cachePath = expandHome(config.cachePath);
  const readerDeps: ReaderDeps = {
    fetchText: deps.fetchText ?? defaultFetch,
    readCache: deps.readCache ?? (async () => {
      try {
        const info = await stat(cachePath);
        if (Date.now() - info.mtimeMs > config.cacheTtlMs) return null;
        return await readFile(cachePath, 'utf8');
      } catch {
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

  const read = (): Promise<MarketRead> => readMarket(readerDeps);

  // M2 seam: a missing plugin_manager degrades to manual commands, never to a
  // fake "installed" report. Resolution is per call, not startup-only: the host
  // may register plugin_manager after this plugin mounts, so every install /
  // verify / seams path re-probes and picks up late registration without a
  // reload. Tests override both probe and seam deterministically.
  const resolveSeam = (): { probe: SeamProbe; seam: InstallSeam | null } => {
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
  const registeredCommands = (): string[] => {
    if (deps.registeredCommands) return deps.registeredCommands();
    const capture = ctx as unknown as { commands?: { list?: () => unknown[] } };
    return typeof capture.commands?.list === 'function'
      ? capture.commands.list().map((command) => String((command as { name?: unknown }).name ?? ''))
      : [];
  };
  log.info(startup.seam
    ? `install seam available · ${startup.seam.source}`
    : `install seam unavailable · ${startup.probe.note}`);

  ctx.commands.register({
    name: 'market',
    description: '插件市集：/market 列组，/market group <id> 看详情，/market install <id> 一键安装（含冲突预检与四态校验），/market uninstall <id> 按 members 逆序卸载回滚，/market verify <id> 只校验，/market fuse <ids> 出融合任务书（--apply 才落盘脚手架），/market seams 查宿主安装能力。断网用内置快照。',
    input: { hint: '[group <id> | install <id> [--without a,b] [--reinstall] | uninstall <id> | verify <id> | fuse <a,b> [--apply] | seams]' },
    handler: async ({ rawInput }: { rawInput?: string }) => {
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
          if (!seam) lines.push('', '手动安装模板：', ...manualInstallCommands('<npm 包或本地路径>', config.profile, '<groupId>').map((line) => `  ${line}`));
          return { kind: 'success' as const, text: lines.join('\n') };
        }
        if (args.subcommand === 'help') {
          return {
            kind: 'success' as const,
            text: '用法：/market 列组 · /market group <id> 详情 · /market install <id> 一键安装 · /market install <id> --without a,b 跳过冲突成员 · /market uninstall <id> 按 members 逆序卸载回滚（幂等，失败给恢复命令）· /market verify <id> 校验四态 · /market fuse <a,b,c> 出融合任务书（不落盘），加 --apply 才写脚手架 · /market seams 查安装能力',
          };
        }

        const result = await read();
        const shortcutGroup = args.subcommand === 'list' && args.target && result.index.groups.some((group) => group.id === args.target);
        if (args.subcommand === 'group' || shortcutGroup) {
          return { kind: 'success' as const, text: renderGroup(result, args.target) };
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
          return { kind: report.ok ? ('success' as const) : ('error' as const), text: renderInstallReport(report) };
        }
        if (args.subcommand === 'uninstall') {
          const report = await uninstallGroup({
            groupId: args.target,
            index: result.index,
            seam: resolveSeam().seam,
            profile: config.profile,
            now: deps.now,
            manifest: deps.manifest ?? createProfileManifestStore(config.profile),
          });
          return { kind: report.ok ? ('success' as const) : ('error' as const), text: renderUninstallReport(report) };
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
          return { kind: 'success' as const, text };
        }
        if (args.subcommand === 'fuse') {
          const options = parseFuseArgs(args.target, args.rest);
          try {
            const fused = runFuse(result.index, options.ids, options.apply);
            if (!options.apply) return { kind: 'success' as const, text: fused.text };
            const outDir = expandHome(config.fuseOutDir);
            const written = await (deps.fuseWriter ?? defaultFuseWriter)(outDir, fused.files);
            return {
              kind: 'success' as const,
              text: `${fused.text}\n\n输出目录：${outDir}\n${written.map((entry) => `  - ${entry.path} (${entry.action})`).join('\n')}`,
            };
          } catch (error) {
            if (error instanceof FuseValidationError) {
              return { kind: 'error' as const, text: renderFuseRejection(error) };
            }
            throw error;
          }
        }
        return { kind: 'success' as const, text: renderList(result) };
      } catch (error) {
        // Defense in depth: a rendering/orchestration bug must surface as a
        // readable error with next steps, never as an unhandled handler throw.
        return {
          kind: 'error' as const,
          text: `市集操作失败：${error instanceof Error ? error.message : String(error)}\n下一步：/market seams 检查安装能力；/market group <id> 复核组数据；必要时按 dsh plugin --profile ${config.profile} list 手动处理。`,
        };
      }
    },
  });

  ctx.tools.register(
    defineTool({
      name: 'market_list',
      description: '只读列出 dsh 插件市集的插件组（含快照时间与来源层）；无需账号、不修改任何配置。',
      parameters: {
        groupId: { type: 'string', description: '可选，查看某个组的详情（成员、真实协同点、验收步骤）' },
      },
      output: {
        schema: { type: 'string' } as const,
        render: (_args, value) => [{ type: 'text', text: String(value).slice(0, 4000) }],
      },
      presentCall: (args: { groupId?: string }) => ({
        card: 'generic' as const,
        title: args.groupId ? `插件组详情：${args.groupId}` : '插件市集（只读）',
        kind: 'fetch' as const,
      }),
      presentResult: () => ({
        card: 'generic' as const,
        title: '插件市集',
        kind: 'fetch' as const,
      }),
      async execute(args: { groupId?: string }) {
        const result = await read();
        const text = args.groupId ? renderGroup(result, args.groupId) : renderList(result);
        return `${renderStamp(result.meta)}\n\n${text}`;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'market_install',
      description: '按组一键安装 dsh 插件：先做命令名/工具名/包名/slot 冲突预检，再按 members 顺序调用宿主 plugin_manager.installBundle，最后用 application 四态与 listPlugins 校验是否真正生效。冲突时返回可执行修复建议；seam 不可用时只给手动命令，不假装成功。',
      parameters: {
        groupId: { type: 'string', required: true, description: '插件组 id，如 archive-chain' },
        without: { type: 'string', description: '可选，逗号分隔的跳过的成员 id' },
        reinstall: { type: 'boolean', description: '可选，重新安装已存在的成员' },
      },
      output: {
        schema: { type: 'string' } as const,
        render: (_args, value) => [{ type: 'text', text: String(value).slice(0, 6000) }],
      },
      presentCall: (args: { groupId: string; without?: string }) => ({
        card: 'generic' as const,
        title: args.without ? `安装插件组 ${args.groupId}（跳过 ${args.without}）` : `安装插件组 ${args.groupId}`,
        kind: 'execute' as const,
        rawInput: args.groupId,
      }),
      presentResult: (_args: unknown, value: unknown) => ({
        card: 'generic' as const,
        title: '插件组安装报告',
        kind: 'execute' as const,
        rawInput: String(value).slice(0, 4000),
      }),
      async execute(args: { groupId?: string; without?: string; reinstall?: boolean }) {
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
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'market_uninstall',
      description: '按组卸载/回滚：按 members 逆序调用宿主 plugin_manager.removeBundle，只移除当前已安装成员（幂等）。失败时恢复安装前 package.json / pnpm-lock.yaml 并给出可复制的恢复命令；报告沿用 application 四态。',
      parameters: {
        groupId: { type: 'string', required: true, description: '插件组 id，如 archive-chain' },
      },
      output: {
        schema: { type: 'string' } as const,
        render: (_args, value) => [{ type: 'text', text: String(value).slice(0, 6000) }],
      },
      presentCall: (args: { groupId: string }) => ({
        card: 'generic' as const,
        title: `卸载插件组 ${args.groupId}（回滚）`,
        kind: 'execute' as const,
        rawInput: args.groupId,
      }),
      presentResult: (_args: unknown, value: unknown) => ({
        card: 'generic' as const,
        title: '插件组卸载报告',
        kind: 'execute' as const,
        rawInput: String(value).slice(0, 4000),
      }),
      async execute(args: { groupId?: string }) {
        const result = await read();
        const report = await uninstallGroup({
          groupId: String(args.groupId ?? ''),
          index: result.index,
          seam: resolveSeam().seam,
          profile: config.profile,
          now: deps.now,
          manifest: deps.manifest ?? createProfileManifestStore(config.profile),
        });
        return `${renderStamp(result.meta)}\n\n${renderUninstallReport(report)}`;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'market_verify',
      description: '只校验某个插件组的安装结果：对照宿主 listPlugins 的行状态与 application 四态，逐成员报告 applied / restart-required / overridden / failed 及下一步。不执行安装。',
      parameters: {
        groupId: { type: 'string', required: true, description: '插件组 id' },
      },
      output: {
        schema: { type: 'string' } as const,
        render: (_args, value) => [{ type: 'text', text: String(value).slice(0, 4000) }],
      },
      presentCall: (args: { groupId: string }) => ({
        card: 'generic' as const,
        title: `校验插件组 ${args.groupId}`,
        kind: 'fetch' as const,
      }),
      presentResult: () => ({ card: 'generic' as const, title: '插件组生效校验', kind: 'fetch' as const }),
      async execute(args: { groupId?: string }) {
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
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'market_fuse',
      description: '融合 2–5 个插件（仅 MIT/Apache-2.0）：第一步只输出融合任务书（能力矩阵、重叠冲突、复用不重写清单、借鉴来源与差异表），不落盘；apply=true 才写脚手架。GPL 等传染性许可一律拒绝。',
      parameters: {
        ids: { type: 'string', required: true, description: '逗号分隔的 2–5 个插件 id，如 dsh-plugin-quota,dsh-plugin-cost-ledger' },
        apply: { type: 'boolean', description: '可选，true 时把脚手架落盘（默认只出任务书，不落盘）' },
      },
      output: {
        schema: { type: 'string' } as const,
        render: (_args, value) => [{ type: 'text', text: String(value).slice(0, 12000) }],
      },
      presentCall: (args: { ids: string; apply?: boolean }) => ({
        card: 'generic' as const,
        title: args.apply ? `落盘融合脚手架：${args.ids}` : `融合任务书：${args.ids}`,
        kind: args.apply ? ('execute' as const) : ('fetch' as const),
        ...(args.apply ? { rawInput: args.ids } : {}),
      }),
      presentResult: (args: { apply?: boolean }, value: unknown) => ({
        card: 'generic' as const,
        title: args.apply ? '融合脚手架落盘报告' : '融合任务书',
        kind: args.apply ? ('execute' as const) : ('fetch' as const),
        rawInput: String(value).slice(0, 4000),
      }),
      async execute(args: { ids?: string; apply?: boolean }) {
        const result = await read();
        try {
          const fused = runFuse(result.index, String(args.ids ?? ''), args.apply === true);
          if (!args.apply) return fused.text;
          const outDir = expandHome(config.fuseOutDir);
          const written = await (deps.fuseWriter ?? defaultFuseWriter)(outDir, fused.files);
          return `${fused.text}\n\n输出目录：${outDir}\n${written.map((entry) => `  - ${entry.path} (${entry.action})`).join('\n')}`;
        } catch (error) {
          if (error instanceof FuseValidationError) return renderFuseRejection(error);
          throw error;
        }
      },
    }),
  );

  log.info(`mounted · ${startup.seam ? 'install-ready' : 'read-only + manual-install guidance'} · cache=${cachePath}`);
}
