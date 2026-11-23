/** F6 — group uninstall / rollback. Removes the installed members of a group
 * in reverse `members` order, skipping anything not present so a second run is
 * a no-op. A failed removal restores the pre-uninstall manifest and returns
 * copy-pasteable recovery commands. Never throws; every path is a report. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { specFor } from './conflicts.js';
import { manualInstallCommands } from './seam.js';
const stamp = (now) => new Date((now ?? Date.now)()).toISOString();
const messageOf = (error) => error instanceof Error ? error.message : String(error);
/** Production manifest IO. `DSH_HOME` lets real-device runs point at an
 * isolated profile; every read is best-effort, writes only restore a snapshot. */
export function createProfileManifestStore(profile) {
    const home = process.env.DSH_HOME || homedir();
    const directory = join(home, '.dsh', 'profiles', profile || 'web');
    const paths = {
        packageJson: join(directory, 'package.json'),
        pnpmLock: join(directory, 'pnpm-lock.yaml'),
    };
    return {
        async read() {
            const files = {};
            for (const key of ['packageJson', 'pnpmLock']) {
                try {
                    files[key] = await readFile(paths[key], 'utf8');
                }
                catch {
                    // absent or unreadable — nothing to snapshot for this file
                }
            }
            return files;
        },
        async write(files) {
            for (const key of ['packageJson', 'pnpmLock']) {
                const text = files[key];
                if (text == null)
                    continue;
                await mkdir(dirname(paths[key]), { recursive: true });
                await writeFile(paths[key], text, 'utf8');
            }
        },
    };
}
function pluginOf(index, id) {
    return index.plugins.find((plugin) => plugin.id === id);
}
function memberKeys(plugin, id) {
    return [id, plugin?.npm ?? '', plugin?.repo ?? '', plugin?.repo.split('/').pop() ?? '']
        .filter(Boolean).map((value) => value.toLowerCase());
}
/** A member is removable only when the host inventory actually shows it.
 * This is the idempotency gate: nothing installed → nothing to remove. */
function isInstalled(id, plugin, rows, bundles) {
    const keys = new Set(memberKeys(plugin, id));
    // `entryId` is added by newer hosts; read it defensively so this module
    // works both before and after F5 without importing F5-only types.
    const rowHit = rows.some((row) => [row.id, row.entryId ?? '', row.moduleName ?? '', ...String(row.id).split(':')]
        .filter(Boolean).some((value) => keys.has(String(value).toLowerCase())));
    if (rowHit)
        return true;
    const npm = plugin?.npm?.toLowerCase();
    return Boolean(npm && bundles.some((bundle) => bundle.name.toLowerCase() === npm));
}
function manualUninstallCommands(spec, profile, groupId) {
    const packageName = spec.replace(/^@[^/]+\//, '').replace(/^github:/, '').split('/').pop() || spec;
    const targetProfile = profile || 'web';
    return [
        `dsh plugin --profile ${targetProfile} remove "${packageName}"`,
        `dsh --profile ${targetProfile} --dump-config | grep -F "${packageName}"`,
        `/market verify ${groupId}`,
    ];
}
/** Shared four-state wording source: the same `application` values install/F5
 * use, with `APPLICATION_LABEL` semantics. F6 never rewrites F5's guidance. */
function applicationDetail(application, member) {
    switch (application) {
        case 'applied':
            return `${member} 已移除并生效`;
        case 'restart-required':
            return `${member} 已从 profile 移除，需重启 dsh web 后生效`;
        case 'overridden':
            return `${member} 被更高优先级层覆盖，移除可能未真正生效`;
        case 'cancelled':
            return `${member} 移除已取消`;
        case 'failed':
        default:
            return `${member} 移除失败`;
    }
}
function nextStepsForFailure(spec, profile, groupId, diagnostic) {
    const suffix = diagnostic ? `（${diagnostic.slice(0, 160)}）` : '';
    return [
        `确认 profile 状态：dsh plugin --profile ${profile} list${suffix}`,
        ...manualUninstallCommands(spec, profile, groupId),
        `/market seams 核实宿主 removeBundle 签名（F6 组卸载依赖该方法）`,
    ];
}
/** Roll a group back to its pre-install manifest, members in reverse order. */
export async function uninstallGroup(input) {
    const startedAt = stamp(input.now);
    const profile = input.profile || 'web';
    const group = input.index.groups.find((candidate) => candidate.id === input.groupId);
    const empty = (summary, mode = input.seam ? 'live' : 'degraded') => ({
        groupId: input.groupId, mode, startedAt, finishedAt: stamp(input.now),
        ok: false, idempotent: false, manifestRestored: false,
        summary, steps: [], recovery: [], nextSteps: [],
    });
    if (!group)
        return empty(`找不到组 ${input.groupId || '(空)'}；用 /market 查看可用组`);
    if (!input.seam || typeof input.seam.removeBundle !== 'function') {
        return {
            ...empty(`plugin_manager 的 removeBundle 不可用（${input.seam?.source || 'seam 不可用'}），未执行任何卸载。请复制下面的命令手动移除成员，再用 /market verify 校验。`, 'degraded'),
            recovery: [...group.members].reverse().flatMap((id) => manualUninstallCommands(specFor(pluginOf(input.index, id)), profile, group.id)),
            nextSteps: ['/market seams 查看宿主安装能力；若刚启用 plugin_manager，重启或重跑本命令'],
        };
    }
    let rows = [];
    let bundles = [];
    try {
        rows = (await input.seam.listPlugins?.()) ?? [];
        bundles = (await input.seam.listBundles?.()) ?? [];
    }
    catch (error) {
        return empty(`读取宿主安装清单失败：${messageOf(error)}；为避免误删已停止`);
    }
    // Snapshot before touching anything. Snapshot failure is non-fatal: we still
    // uninstall, and only lose the byte-for-byte restore safety net.
    let snapshot;
    try {
        snapshot = await input.manifest?.read();
    }
    catch {
        snapshot = undefined;
    }
    // Reverse `members` order — a group install went forward, rollback goes back.
    const reverseMembers = [...group.members].reverse();
    const targets = reverseMembers
        .map((id) => ({ member: id, plugin: pluginOf(input.index, id) }))
        .filter(({ member, plugin }) => isInstalled(member, plugin, rows, bundles))
        .map(({ member, plugin }) => ({ member, spec: specFor(plugin) }));
    if (!targets.length) {
        return {
            ...empty(`组 ${group.id} 没有已安装成员，无需卸载（幂等）`),
            ok: true,
            idempotent: true,
            nextSteps: [`/market verify ${group.id} 复核清单已恢复原状`],
        };
    }
    const steps = [];
    for (const { member, spec } of targets) {
        input.onProgress?.(`卸载 ${member} ← ${spec}`);
        try {
            const result = await input.seam.removeBundle(spec);
            const application = result.application ?? 'failed';
            const failed = application === 'failed' || application === 'cancelled' || application === 'overridden';
            const diagnostic = result.error?.diagnostic || result.packageResult?.output?.trim().split('\n').slice(-1)[0];
            steps.push({
                member, spec, status: failed ? 'failed' : 'removed', application,
                detail: failed
                    ? `${applicationDetail(application, member)}（stage=${result.stage}, target=${result.target}）${diagnostic ? `：${diagnostic.slice(0, 160)}` : ''}`
                    : `${applicationDetail(application, member)}（stage=${result.stage}, target=${result.target}）`,
                nextSteps: failed ? nextStepsForFailure(spec, profile, group.id, diagnostic) : [],
            });
        }
        catch (error) {
            steps.push({
                member, spec, status: 'failed', application: 'failed',
                detail: `调用 plugin_manager.removeBundle 失败：${messageOf(error)}`,
                nextSteps: nextStepsForFailure(spec, profile, group.id, messageOf(error)),
            });
        }
    }
    const removed = steps.filter((step) => step.status === 'removed');
    const failed = steps.filter((step) => step.status === 'failed');
    let manifestRestored = false;
    if (failed.length && snapshot && input.manifest) {
        try {
            await input.manifest.write(snapshot);
            manifestRestored = true;
        }
        catch {
            // report the manual restore command below instead of throwing
        }
    }
    const recovery = failed.length
        ? [
            ...new Set([
                ...removed.flatMap((step) => manualInstallCommands(step.spec, profile, group.id)),
                ...failed.flatMap((step) => manualUninstallCommands(step.spec, profile, group.id)),
            ]),
            manifestRestored
                ? `已从快照恢复 ${profile} profile 的 package.json / pnpm-lock.yaml`
                : `手动恢复：核对 ${profile} profile 的 package.json / pnpm-lock.yaml 与 pnpm-lock.yaml`,
        ]
        : [];
    const ok = failed.length === 0;
    const summary = ok
        ? `组 ${group.id} 已按 members 逆序卸载 ${removed.length} 个成员，清单已恢复到安装前状态`
        : `组 ${group.id} 卸载未完成：${failed.length} 步失败${manifestRestored ? '；原始 package.json / pnpm-lock.yaml 已恢复' : '；原始清单未改动'}`;
    return {
        groupId: group.id,
        mode: 'live',
        startedAt,
        finishedAt: stamp(input.now),
        ok,
        idempotent: false,
        manifestRestored,
        summary,
        steps,
        recovery,
        nextSteps: ok
            ? [`/market verify ${group.id} 确认清单已恢复；如需重装运行 /market install ${group.id}`]
            : [...new Set(failed.flatMap((step) => step.nextSteps))],
    };
}
/** Human-readable report for both the command and the model-facing tool. */
export function renderUninstallReport(report) {
    const lines = [
        `卸载报告 · ${report.groupId} · ${report.mode === 'degraded' ? '降级模式' : '宿主卸载'}`,
        report.summary,
        `时间 ${report.startedAt} → ${report.finishedAt}`,
    ];
    if (report.idempotent)
        lines.push('幂等：没有已安装成员，未调用宿主卸载');
    lines.push('');
    for (const step of report.steps) {
        const mark = step.status === 'removed' ? '✓' : step.status === 'failed' ? '✗' : '·';
        lines.push(`${mark} ${step.member}  ${step.spec}`);
        lines.push(`    ${step.detail}${step.application ? ` [${step.application}]` : ''}`);
    }
    if (report.recovery.length) {
        lines.push('', '恢复命令（可直接复制）：');
        for (const command of report.recovery)
            lines.push(`  → ${command}`);
    }
    if (report.nextSteps.length) {
        lines.push('', '下一步：');
        for (const step of report.nextSteps)
            lines.push(`  → ${step}`);
    }
    return lines.join('\n');
}
