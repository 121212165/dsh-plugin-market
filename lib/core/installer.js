/** M2 orchestration: pre-check → ordered install → four-state verification.
 * The orchestrator never throws: every failure becomes a visible report with
 * an executable next step. */
import { planGroupInstall, renderConflicts, specFor } from './conflicts.js';
import { callEntryViaContext, dumpConfigView, manualInstallCommands, quoteShellArgument } from './seam.js';
const stamp = (now) => new Date((now ?? Date.now)()).toISOString();
const messageOf = (error) => error instanceof Error ? error.message : String(error);
const safeDiagnosticText = (value) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);
/** F5: one wording table for all four application states. `overridden` is
 * deliberately explicit ("被更高优先级层覆盖") so it can never be confused
 * with a generic failure. Every state carries a concrete next step. */
export const FOUR_STATE_GUIDANCE = {
    applied: {
        label: 'applied · 已生效',
        nextStep: '无需重启；运行 /market verify <groupId> 复核四态与命令可见性',
    },
    'restart-required': {
        label: 'restart-required · 需重启后生效',
        nextStep: '重启 dsh web 后开新会话，再运行 /market verify <groupId>',
    },
    overridden: {
        label: 'overridden · 被更高优先级层覆盖',
        nextStep: '被更高优先级层覆盖：检查并移除更高优先级的 patch/层（dsh plugin --profile <profile> list），不要当作安装成功',
    },
    failed: {
        label: 'failed · 失败',
        nextStep: '查看 pnpm/宿主日志定位失败原因，修好后重试 /market install <groupId>',
    },
    cancelled: {
        label: 'cancelled · 已取消',
        nextStep: 'profile 已回滚；确认后重新运行 /market install <groupId>',
    },
};
/** Render a single four-state line with its next step. */
export function renderFourStateLine(state, member, detail) {
    const guidance = FOUR_STATE_GUIDANCE[state];
    return {
        member,
        application: state,
        label: guidance.label,
        detail: detail ?? guidance.label,
        nextStep: guidance.nextStep,
    };
}
function pluginOf(index, id) {
    return index.plugins.find((plugin) => plugin.id === id);
}
function memberKeys(plugin, id) {
    return [id, plugin?.npm ?? '', plugin?.repo ?? '', plugin?.repo.split('/').pop() ?? '']
        .filter(Boolean).map((value) => value.toLowerCase());
}
function findRow(rows, plugin, id) {
    const keys = new Set(memberKeys(plugin, id));
    return rows.find((row) => [row.id, row.entryId ?? '', row.moduleName ?? '', ...String(row.id).split(':')]
        .filter(Boolean).some((value) => keys.has(String(value).toLowerCase())));
}
/** Map a host failure code to a step the user can actually take. */
export function nextStepsFor(result, spec, profile) {
    const code = result.error?.code ?? result.packageResult?.kind ?? 'operation-error';
    const diagnostic = result.error?.diagnostic ? `（${safeDiagnosticText(result.error.diagnostic)}）` : '';
    switch (code) {
        case 'incompatible-version':
            return [`当前 dsh 版本拒绝该插件的 peer 范围${diagnostic}；升级 dsh 或换用兼容版本`, `/market seams 查看当前 host 信息；dsh --version 确认版本`];
        case 'not-found':
        case 'no-matching-version':
        case 'invalid-spec':
            return [`包名/仓库地址无效${diagnostic}；先 npm view ${quoteShellArgument(spec)} version 确认包存在`, `修正市集数据后重试：/market install <id>`];
        case 'network':
        case 'timeout':
            return result.packageResult?.timedOut
                ? [`宿主 pnpm 静默超时（plugin-manager.idleTimeoutMs，默认 600000）${diagnostic}；调高该配置或先手动装好依赖再重试`, `重试 /market install <id>（安装失败不会写坏 profile）`]
                : [`网络或 registry 不可达${diagnostic}；检查代理后重试`, `重试 /market install <id>（安装失败不会写坏 profile）`];
        case 'build-blocked':
            return [`构建脚本未获批准${diagnostic}；确认可信后再传入 approvedBuilds`, `dsh plugin --profile ${quoteShellArgument(profile)} list 查看 pendingBuilds`];
        case 'pendingBuilds':
            return [`有待批准构建脚本：${(result.pendingBuilds ?? []).join(', ') || '见输出'}；确认后重试`, `/market seams 查看 seam 是否支持 approvedBuilds`];
        case 'management-required':
        case 'unaddressable':
            return [`该层受管理策略保护${diagnostic}；需管理员或更高权限安装`, `用 /market seams 查看当前 profile 与层，再决定是否切换 profile`];
        case 'overridden':
            return [`被更高优先级层覆盖${diagnostic}；运行 dsh plugin --profile ${quoteShellArgument(profile)} list 检查 patch 顺序`, `确认要保留哪一层后，用 /market install <id> --without <冲突成员> 或移除旧层`];
        case 'cancelled':
            return ['安装已取消，profile 文件已回滚；确认后重新运行 /market install <id>'];
        default:
            return [
                `安装失败：${code}${diagnostic}`,
                result.packageResult?.logPath ? `查看完整日志：${result.packageResult.logPath}` : `手动安装：${manualInstallCommands(spec, profile, '该组').join(' → ')}`,
                '/market seams 检查 seam；/market group <id> 复核成员与协同点',
            ];
    }
}
function classify(result, member, spec, profile) {
    const application = result.application ?? 'failed';
    const base = { member, spec, application };
    const label = {
        applied: '已生效', 'restart-required': '需重启后生效', overridden: '被更高优先级层覆盖', failed: '失败', cancelled: '已取消',
    };
    if (application === 'failed' || application === 'cancelled') {
        const rawDetail = result.error?.diagnostic || result.packageResult?.output?.trim().split('\n').slice(-1)[0] || label[application];
        const detail = safeDiagnosticText(rawDetail);
        return { ...base, status: 'failed', detail: `${detail}（stage=${result.stage}, target=${result.target}）`, nextSteps: nextStepsFor(result, spec, profile) };
    }
    if (application === 'overridden') {
        return {
            ...base, status: 'failed', detail: `${member} 被更高优先级层覆盖，不要当作安装成功`,
            nextSteps: nextStepsFor({ ...result, error: { ...result.error, code: 'overridden' } }, spec, profile),
        };
    }
    if (application === 'restart-required') {
        return {
            ...base, status: 'done',
            detail: `${member} 已写入 profile，需重启 dsh web 后生效`,
            nextSteps: [`重启 web 后开新会话，运行 /market verify <groupId>`, `/market group <groupId> 查看可执行的验收步骤`],
        };
    }
    return {
        ...base, status: 'done', detail: `${member} 已安装并生效（stage=${result.stage}）`,
        nextSteps: ['/market verify <groupId> 复核四态与命令可见性'],
    };
}
/** Verify what actually mounted, not what we intended to mount. */
export async function verifyGroup(input) {
    const group = input.index.groups.find((candidate) => candidate.id === input.groupId);
    if (!group) {
        return { groupId: input.groupId, members: [], ok: false, summary: `找不到组 ${input.groupId || '(空)'}；用 /market 查看可用组` };
    }
    let rows = [];
    try {
        rows = (await input.seam?.listPlugins?.()) ?? [];
    }
    catch {
        rows = [];
    }
    const liveCommands = new Set((input.registeredCommands ?? []).map((name) => name.startsWith('/') ? name : `/${name}`));
    const requestedIds = new Set(input.memberIds ?? group.members);
    const checkedIds = group.members.filter((id) => requestedIds.has(id));
    const members = checkedIds.map((id) => {
        const plugin = pluginOf(input.index, id);
        const row = findRow(rows, plugin, id);
        const application = input.applicationByMember?.[id];
        const present = Boolean(row);
        const enabled = row?.enabled === true;
        const active = row?.fiberPhase === 'active' || (row?.fiberPhase == null && present);
        const nextSteps = [];
        const detail = [];
        if (!present) {
            detail.push('未在安装清单中出现');
            nextSteps.push(`/market install ${group.id} --reinstall 重试 ${id}`);
        }
        if (!enabled) {
            detail.push('row 处于 disabled');
            nextSteps.push(`dsh plugin --profile ${quoteShellArgument(input.profile ?? 'web')} set ${quoteShellArgument(id)} enabled`);
        }
        if (present && !active) {
            detail.push(`fiberPhase=${row?.fiberPhase ?? 'unknown'}`);
            nextSteps.push('重启 web 后开新会话再运行 /market verify');
        }
        if (application === 'overridden') {
            detail.push('application=overridden，被更高优先级层覆盖');
            nextSteps.push(`检查更高优先级 patch：dsh plugin --profile ${quoteShellArgument(input.profile ?? 'web')} list`);
        }
        if (application === 'restart-required') {
            detail.push('application=restart-required');
            nextSteps.push('重启 web 后开新会话再验证');
        }
        const hostResultMismatch = (application === 'failed' || application === 'cancelled')
            && present && active && enabled;
        if (hostResultMismatch) {
            detail.push(`宿主原始 application=${application}，但 listPlugins 显示已挂载、enabled、active；宿主结果与清单不一致`);
            nextSteps.push('检查宿主 plugin-manager 的 Already up to date / dependency diff 判定；保留原始四态，不要盲目重复安装');
            nextSteps.push('确认运行状态后向宿主仓报告该矛盾；插件仓不会把 application 改写成 applied');
        }
        const missingCommands = (plugin?.entries ?? []).filter((entry) => entry.startsWith('/') && !liveCommands.has(entry));
        if (liveCommands.size && missingCommands.length && present && active) {
            detail.push(`命令未注册：${missingCommands.join(' ')}`);
            nextSteps.push('在新会话里让模型调用一次该命令；若仍不可见，检查 profile 是否 restart-required');
        }
        if (!detail.length)
            detail.push('已挂载、enabled、active，声明的命令均可见');
        return { member: id, present, active, enabled, hostResultMismatch, detail: detail.join('；'), nextSteps };
    });
    // `overridden` is a failure even when the row is present/enabled/active:
    // a higher-priority layer shadowed it. Check the source state, not the
    // wording of a next step (which previously let this slip through).
    const ok = members.length > 0 && members.every((member) => member.present && member.active && member.enabled
        && !member.hostResultMismatch
        && input.applicationByMember?.[member.member] !== 'overridden');
    const partial = checkedIds.length < group.members.length;
    const mismatch = members.filter((member) => member.hostResultMismatch);
    return {
        groupId: group.id,
        members,
        ok,
        summary: mismatch.length
            ? `宿主结果与清单不一致：${mismatch.map((member) => member.member).join(', ')} 的原始 application 失败，但清单显示 active；操作不视为完全成功`
            : ok
                ? `验收通过：${members.length}/${group.members.length} 个纳入校验的成员已挂载且生效${partial ? '（部分安装）' : ''}（用 /market group ${group.id} 查看业务验收步骤）`
                : `验收未通过：${members.filter((member) => !member.present || !member.active || !member.enabled).map((member) => member.member).join(', ') || (members.length ? '见各成员详情' : '没有纳入校验的成员')}`,
    };
}
/** Full install flow. `seam === null` means degraded: we return manual steps
 * and never claim anything was installed. */
export async function runGroupInstall(input) {
    const startedAt = stamp(input.now);
    const group = input.index.groups.find((candidate) => candidate.id === input.groupId);
    const profile = input.profile || 'web';
    const empty = (summary, conflicts = []) => ({
        groupId: input.groupId,
        mode: input.seam ? 'live' : 'degraded',
        startedAt,
        finishedAt: stamp(input.now),
        ok: false,
        summary,
        conflicts,
        steps: [],
        verification: null,
        hostSlotDetection: input.registeredSlots === undefined ? 'unavailable' : 'available',
        nextSteps: input.seam ? [] : (group?.members ?? []).flatMap((id) => manualInstallCommands(specFor(pluginOf(input.index, id)), profile, input.groupId)),
    });
    if (!group)
        return empty(`找不到组 ${input.groupId || '(空)'}；用 /market 查看可用组`);
    if (!input.seam) {
        return empty(`plugin_manager seam 不可用（已核实 ${input.index.groups.length} 组中的 ${group.id}），未执行任何安装。请复制下面的命令手动安装，再用 /market verify 校验。若刚启用 plugin_manager，重启或重跑本命令。`);
    }
    let plugins = [];
    let bundles = [];
    try {
        plugins = (await input.seam.listPlugins?.()) ?? [];
        bundles = (await input.seam.listBundles?.()) ?? [];
    }
    catch (error) {
        return empty(`读取宿主安装清单失败：${error instanceof Error ? error.message : String(error)}；为避免误装已停止`, []);
    }
    const plan = planGroupInstall({
        group, index: input.index, inventory: { plugins, bundles },
        registeredCommands: input.registeredCommands, registeredSlots: input.registeredSlots, excluded: input.excluded,
        profile, reinstall: input.reinstall,
    });
    if (plan.blocked) {
        const fixes = plan.conflicts.filter((conflict) => conflict.severity === 'blocking').map((conflict) => conflict.fix);
        return {
            ...empty(`安装前预检未通过：${plan.conflicts.filter((c) => c.severity === 'blocking').map((c) => c.detail).join('；')}`, plan.conflicts),
            nextSteps: [...new Set(fixes)],
        };
    }
    const includedIds = plan.steps.filter((step) => step.action !== 'skip-excluded').map((step) => step.member);
    if (includedIds.length === 0) {
        const steps = plan.steps.map((step) => ({
            member: step.member, spec: step.spec, status: 'skipped',
            detail: step.reason ?? '按 --without 跳过', nextSteps: [],
        }));
        const verification = {
            groupId: group.id, members: [], ok: false,
            summary: `未校验：全部 ${group.members.length} 个组成员均被排除`,
        };
        return {
            groupId: group.id, mode: 'live', startedAt, finishedAt: stamp(input.now), ok: false,
            summary: `${group.name}：已安装 0/${group.members.length} 个成员（全部被排除），未调用 installBundle；不是完整安装`,
            conflicts: plan.conflicts, steps, verification,
            hostSlotDetection: input.registeredSlots === undefined ? 'unavailable' : 'available',
            nextSteps: [`移除 --without，或至少保留一个成员后重试 /market install ${group.id}`],
        };
    }
    const steps = [];
    const applicationByMember = {};
    for (const planned of plan.steps) {
        if (planned.action !== 'install') {
            steps.push({ member: planned.member, spec: planned.spec, status: 'skipped', detail: planned.reason ?? '跳过', nextSteps: [] });
            continue;
        }
        input.onProgress?.(`安装 ${planned.member} ← ${planned.spec}`);
        try {
            const result = await input.seam.installBundle(planned.spec, { enabled: true });
            applicationByMember[planned.member] = result.application ?? 'failed';
            steps.push(classify(result, planned.member, planned.spec, profile));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            applicationByMember[planned.member] = 'failed';
            steps.push({
                member: planned.member, spec: planned.spec, status: 'failed',
                detail: `调用 plugin_manager.installBundle 失败：${message}`,
                nextSteps: [
                    `/market seams 核实宿主的 installBundle 签名是否变化（${input.seam.source}）`,
                    `手动安装：${manualInstallCommands(planned.spec, profile, group.id).join(' → ')}`,
                ],
            });
        }
    }
    const verification = await verifyGroup({
        groupId: group.id, index: input.index, seam: input.seam,
        applicationByMember, memberIds: includedIds, registeredCommands: input.registeredCommands, now: input.now, profile,
    });
    // F5: automatically run the live loop once after install. The four states
    // come from the same ChangeResult.application values used above, so no
    // semantics are re-implemented here.
    const attemptedIds = steps.filter((step) => step.status !== 'skipped').map((step) => step.member);
    const liveLoop = attemptedIds.length
        ? await runPostInstallLoop({
            groupId: group.id, index: input.index, seam: input.seam,
            applicationByMember, memberIds: attemptedIds, registeredCommands: input.registeredCommands,
            profile, dumpConfig: input.dumpConfig, callEntry: input.callEntry,
            ctx: input.ctx, now: input.now,
        })
        : null;
    const failed = steps.filter((step) => step.status === 'failed');
    const installedCount = verification.members.filter((member) => member.present && member.active && member.enabled).length;
    const partial = includedIds.length < group.members.length;
    const excludedMembers = plan.steps.filter((step) => step.action === 'skip-excluded').map((step) => step.member);
    const nextSteps = [...new Set([
            ...steps.flatMap((step) => step.nextSteps),
            ...verification.members.flatMap((member) => member.nextSteps),
            ...(failed.length ? [] : [`按 /market group ${group.id} 的验收步骤做一次真回路`]),
        ])];
    const ok = failed.length === 0 && verification.ok;
    return {
        groupId: group.id,
        mode: 'live',
        startedAt,
        finishedAt: stamp(input.now),
        ok,
        summary: ok
            ? `${group.name}：已安装 ${installedCount}/${group.members.length} 个组成员${partial ? '（部分安装）' : ''}，${verification.summary}${excludedMembers.length ? `；按要求跳过 ${excludedMembers.join(', ')}` : ''}`
            : `${group.name}：${failed.length} 步失败；${verification.summary}${excludedMembers.length ? `；已安装 ${installedCount}/${group.members.length} 个组成员（部分安装），按要求跳过 ${excludedMembers.join(', ')}` : ''}`,
        conflicts: plan.conflicts,
        steps,
        verification,
        hostSlotDetection: input.registeredSlots === undefined ? 'unavailable' : 'available',
        nextSteps,
        liveLoop,
    };
}
/** Render the full report for both the command and the model-facing tool. */
export function renderInstallReport(report) {
    const lines = [
        `安装报告 · ${report.groupId} · ${report.mode === 'degraded' ? '降级模式' : '宿主安装'}`,
        report.summary,
        `时间 ${report.startedAt} → ${report.finishedAt}`,
        '',
    ];
    if (report.conflicts.length)
        lines.push(renderConflicts({ groupId: report.groupId, steps: [], conflicts: report.conflicts, blocked: !report.ok }), '');
    if (report.mode === 'live' && report.hostSlotDetection === 'unavailable') {
        lines.push('宿主 slot 检测：无法检测当前宿主已占用 slot；仅检查组内 slot 冲突（host plugin_manager 不暴露浏览器 ctx.slots registry）。', '');
    }
    for (const step of report.steps) {
        const mark = step.status === 'done' ? '✓' : step.status === 'failed' ? '✗' : '·';
        lines.push(`${mark} ${step.member}  ${step.spec}`);
        lines.push(`    ${step.detail}${step.application ? ` [${step.application}]` : ''}`);
    }
    if (report.verification) {
        lines.push('', `生效校验：${report.verification.summary}`);
        for (const member of report.verification.members)
            lines.push(`  ${member.member}：${member.detail}`);
    }
    if (report.liveLoop) {
        const loop = report.liveLoop;
        lines.push('', '装后生效回路（dump-config → 入口调用 → 四态）：');
        lines.push(`  dump-config：${loop.membersInDump.length}/${loop.states.length} 成员可见`);
        for (const line of loop.dumpConfig.split('\n').slice(0, 6))
            lines.push(`    ${line}`);
        lines.push(`  入口调用：${loop.entry ? `${loop.entry.entry} · ${loop.entry.ok ? '调用成功' : '未实际调用'} · ${loop.entry.output}` : '无可探测入口'}`);
        lines.push('  四态：');
        for (const state of loop.states) {
            lines.push(`    ${state.member}：${state.label}（${state.detail}） → ${state.nextStep}`);
        }
        lines.push(`  ${loop.summary}`);
    }
    if (report.nextSteps.length) {
        lines.push('', '下一步：');
        for (const step of report.nextSteps)
            lines.push(`  → ${step}`);
    }
    return lines.join('\n');
}
/** Exposed so tests and the command can verify without reinstalling. */
export async function runVerify(input) {
    const probe = await verifyGroup(input);
    return [
        `生效校验 · ${input.groupId}`,
        probe.summary,
        ...probe.members.map((member) => `  ${member.member}：${member.detail}${member.nextSteps.length ? ` → ${member.nextSteps.join(' | ')}` : ''}`),
    ].join('\n');
}
/** F5: the automatic post-install live loop — dump-config → one entry call →
 * four-state report. Four-state semantics are reused: `verifyGroup` supplies
 * the verification and `FOUR_STATE_GUIDANCE` only adds explicit wording. */
export async function runPostInstallLoop(input) {
    const startedAt = stamp(input.now);
    const group = input.index.groups.find((candidate) => candidate.id === input.groupId);
    const profile = input.profile ?? 'web';
    const selectedMembers = new Set(input.memberIds ?? group?.members ?? []);
    const memberIds = (group?.members ?? []).filter((id) => selectedMembers.has(id));
    // 1. dump-config (authoritative CLI output when injected, seam view otherwise)
    let dumpConfig;
    try {
        const source = input.dumpConfig;
        dumpConfig = typeof source === 'function'
            ? String(await source())
            : String(source ?? await dumpConfigView(input.seam));
    }
    catch (error) {
        dumpConfig = `dump-config 读取失败：${messageOf(error)}`;
    }
    const dumpLower = dumpConfig.toLowerCase();
    const membersInDump = memberIds.filter((id) => dumpLower.includes(id.toLowerCase()));
    // 2. one member entry call (only entries the host actually reports as visible)
    const live = new Set((input.registeredCommands ?? []).map((name) => name.startsWith('/') ? name : `/${name}`));
    const chosenEntry = memberIds
        .flatMap((id) => (pluginOf(input.index, id)?.entries ?? []).filter((entry) => entry.startsWith('/')))
        .find((entry) => live.size === 0 || live.has(entry));
    let entry = null;
    if (chosenEntry) {
        const call = input.callEntry ?? ((name) => callEntryViaContext(input.ctx, name));
        try {
            entry = { entry: chosenEntry, ok: true, output: String(await call(chosenEntry)) };
        }
        catch (error) {
            entry = { entry: chosenEntry, ok: false, output: messageOf(error) };
        }
    }
    // 3. four-state report via the existing verifier — never re-implemented
    const verification = await verifyGroup({
        groupId: input.groupId,
        index: input.index,
        seam: input.seam,
        applicationByMember: input.applicationByMember,
        memberIds,
        registeredCommands: input.registeredCommands,
        profile,
        now: input.now,
    });
    const states = memberIds.map((id) => {
        const application = input.applicationByMember[id] ?? 'failed';
        const detail = verification.members.find((member) => member.member === id)?.detail;
        return renderFourStateLine(application, id, detail);
    });
    const overriddenCount = states.filter((state) => state.application === 'overridden').length;
    const appliedCount = states.filter((state) => state.application === 'applied').length;
    const ok = states.length > 0
        && states.every((state) => state.application === 'applied' || state.application === 'restart-required')
        && verification.ok;
    const summary = overriddenCount
        ? `${appliedCount}/${states.length} 成员 applied；${overriddenCount} 个成员被更高优先级层覆盖（overridden，不视为安装成功）`
        : ok
            ? `装后回路通过：${states.length} 个成员生效，dump-config 可见 ${membersInDump.length}/${states.length}，入口 ${entry?.entry ?? '无'} ${entry?.ok ? '调用成功' : '未实际调用'}`
            : verification.members.some((member) => member.hostResultMismatch)
                ? `宿主结果与清单不一致：宿主仍返回 failed，但 listPlugins 显示成员 active；操作不视为完全成功，需修复宿主判定`
                : `装后回路未通过：${states.map((state) => `${state.member}=${state.application}`).join('，')}`;
    return {
        groupId: input.groupId,
        dumpConfig,
        membersInDump,
        entry,
        states,
        verification,
        ok,
        summary,
        startedAt,
        finishedAt: stamp(input.now),
    };
}
