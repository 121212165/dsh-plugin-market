export const FUSE_MIN_PLUGINS = 2;
export const FUSE_MAX_PLUGINS = 5;
export const FUSE_LICENSE_ALLOWLIST = ['MIT', 'Apache-2.0'];
export class FuseValidationError extends Error {
    errors;
    constructor(errors) {
        super(errors.join('；'));
        this.name = 'FuseValidationError';
        this.errors = errors;
    }
}
/** Accept commas (ASCII/fullwidth), whitespace, or an array; keep first-seen order. */
export function parseFuseIds(input) {
    const parts = Array.isArray(input) ? input : [input];
    const ids = [];
    for (const part of parts) {
        for (const piece of String(part ?? '').split(/[,，\s]+/)) {
            const id = piece.trim();
            if (id && !ids.includes(id))
                ids.push(id);
        }
    }
    return ids;
}
/** Conservative SPDX-ish normalisation: only the two allowed licenses map.
 * Compound expressions and anything unknown (GPL/AGPL/BSD/blank) map to null. */
export function normalizeLicense(raw) {
    const value = String(raw ?? '').trim().toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ');
    if (value === 'mit' || value === 'mit license' || value === 'the mit license')
        return 'MIT';
    if (value === 'apache 2.0' || value === 'apache 2' ||
        value === 'apache license 2.0' || value === 'apache license version 2.0')
        return 'Apache-2.0';
    return null;
}
/** Gate every selected plugin before any matrix/artifact work happens. */
export function validateFuseSelection(input, index) {
    const ids = parseFuseIds(input);
    const errors = [];
    const rejected = [];
    const plugins = [];
    const eligible = [];
    const byId = new Map(index.plugins.map((plugin) => [plugin.id, plugin]));
    if (ids.length < FUSE_MIN_PLUGINS) {
        errors.push(`融合至少需要 ${FUSE_MIN_PLUGINS} 个插件（当前 ${ids.length} 个）`);
    }
    if (ids.length > FUSE_MAX_PLUGINS) {
        errors.push(`融合最多选 ${FUSE_MAX_PLUGINS} 个插件（当前 ${ids.length} 个）`);
    }
    for (const id of ids) {
        const plugin = byId.get(id);
        if (!plugin) {
            const reason = `插件 ${id} 不在市集数据中`;
            rejected.push({ id, reason });
            errors.push(reason);
            continue;
        }
        plugins.push(plugin);
        if (normalizeLicense(plugin.license) === null) {
            const reason = `插件 ${id} 的 license=${plugin.license || '(空)'} 不在白名单（仅 MIT / Apache-2.0；GPL 等传染性许可一律拒绝）`;
            rejected.push({ id, reason });
            errors.push(reason);
            continue;
        }
        eligible.push(plugin);
    }
    return { ok: errors.length === 0, ids, plugins, eligible, rejected, errors };
}
const DATA_KEYWORDS = [
    { key: 'token', label: 'token 计量', pattern: /token/i },
    { key: 'cost', label: '花费/成本', pattern: /花费|成本|费用|spend|cost/i },
    { key: 'quota', label: '用量/额度', pattern: /用量|额度|quota/i },
    { key: 'budget', label: '预算刹车', pattern: /预算|刹车|budget/i },
    { key: 'forecast', label: '预测/趋势', pattern: /预测|预估|环比|forecast/i },
    { key: 'persistence', label: '持久化/导出', pattern: /jsonl|csv|台账|导出|持久化/i },
    { key: 'session', label: '会话数据', pattern: /会话|session/i },
    { key: 'meter', label: '实时仪表', pattern: /仪表|meter/i },
];
/** Capabilities are derived only from catalog fields — no guessing at code. */
export function buildCapabilityMatrix(plugins) {
    const rows = new Map();
    const add = (pluginId, key, label, kind, source) => {
        const row = rows.get(key);
        if (row) {
            row.cells[pluginId] = true;
            return;
        }
        rows.set(key, { key, label, kind, source, cells: { [pluginId]: true } });
    };
    for (const plugin of plugins) {
        for (const entry of plugin.entries) {
            const isCommand = entry.startsWith('/');
            add(plugin.id, `${isCommand ? 'cmd' : 'tool'}:${entry}`, entry, isCommand ? 'command' : 'tool', 'entries');
        }
        for (const requirement of plugin.requires) {
            add(plugin.id, `req:${requirement}`, `宿主 ${requirement}`, 'host-requirement', 'requires');
        }
        if (plugin.category)
            add(plugin.id, `cat:${plugin.category}`, plugin.category, 'category', 'category');
        for (const keyword of DATA_KEYWORDS) {
            if (keyword.pattern.test(plugin.oneLiner ?? '')) {
                add(plugin.id, `data:${keyword.key}`, keyword.label, 'data-domain', 'oneLiner');
            }
        }
    }
    return { ids: plugins.map((plugin) => plugin.id), rows: [...rows.values()] };
}
const SOURCE_LABELS = {
    entries: 'entries 入口声明',
    requires: 'requires 宿主依赖',
    category: 'category 分类',
    oneLiner: 'oneLiner 能力描述',
};
/** A field shared by 2+ plugins is either an entry collision (conflict) or a
 * reusable capability (reuse). Both produce an actionable "reuse, don't
 * rewrite" instruction so the fused product never duplicates code. */
export function detectOverlaps(matrix) {
    const overlaps = [];
    for (const row of matrix.rows) {
        const members = matrix.ids.filter((id) => row.cells[id] === true);
        if (members.length < 2)
            continue;
        const owner = members[0];
        const others = members.slice(1);
        const conflict = row.kind === 'command' || row.kind === 'tool';
        overlaps.push({
            key: row.key,
            label: row.label,
            kind: row.kind,
            source: row.source,
            members,
            owner,
            severity: conflict ? 'conflict' : 'reuse',
            detail: conflict
                ? `${members.join(' 与 ')} 都声明了 ${row.label}（${SOURCE_LABELS[row.source]}），融合后入口会撞车`
                : `${members.join(' 与 ')} 都用到「${row.label}」（${SOURCE_LABELS[row.source]}）`,
            reuse: conflict
                ? `以 ${owner} 的实现为准，${others.join('、')} 只做入口别名/转发，不重写`
                : `融合产物只实现一次「${row.label}」，复用 ${owner} 的实现与数据契约，${others.join('、')} 直接接入，不重写`,
        });
    }
    return overlaps;
}
export function buildReuseList(overlaps) {
    return overlaps.map((overlap) => ({
        field: overlap.key,
        label: overlap.label,
        owner: overlap.owner,
        consumers: overlap.members.filter((id) => id !== overlap.owner),
        instruction: overlap.reuse,
    }));
}
/** §8: every fused artifact must carry a mandatory "borrowed from & delta" table. */
export function buildSourceTable(plugins, overlaps) {
    return plugins.map((plugin) => {
        const license = normalizeLicense(plugin.license);
        const base = `作为「${overlaps.filter((o) => o.owner === plugin.id && o.members.length > 1).map((o) => o.label).join('、') || plugin.name}」的复用基准实现`;
        const reused = overlaps
            .filter((overlap) => overlap.members.includes(plugin.id) && overlap.owner !== plugin.id)
            .map((overlap) => `不重写「${overlap.label}」，改为复用 ${overlap.owner}`);
        const differences = [base, ...reused];
        const upstream = plugin.borrowedFrom.length
            ? `；上游借鉴：${plugin.borrowedFrom.join('、')}`
            : '';
        return {
            pluginId: plugin.id,
            name: plugin.name,
            repo: plugin.repo,
            license,
            borrowedFrom: plugin.borrowedFrom,
            differences,
            attribution: `保留 ${license} LICENSE，在 BORROWED.md 引用 ${plugin.repo}@${plugin.verifiedAt || 'snapshot'}${upstream}`,
        };
    });
}
const mdCell = (value) => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
function renderTaskBook(plan) {
    const { plugins, matrix, overlaps, reuseList, sourceTable, ids } = plan;
    const names = new Map(plugins.map((plugin) => [plugin.id, plugin.name]));
    const licenseList = FUSE_LICENSE_ALLOWLIST.join(' / ');
    const lines = [
        '# 融合任务书',
        '',
        '> 本任务书只在会话中输出，**不落盘**。确认后运行 `/market fuse <ids> --apply` 才写脚手架。',
        '',
        `选中插件：${ids.join(', ')}（${plugins.length} 个）`,
        `License 白名单：${licenseList}；GPL 等传染性许可一律拒绝。`,
        '',
        '## 1. 选中的插件',
        '',
        '| id | 名称 | 许可 | 入口 |',
        '| --- | --- | --- | --- |',
        ...plugins.map((plugin) => `| ${mdCell(plugin.id)} | ${mdCell(plugin.name)} | ${normalizeLicense(plugin.license)} | ${mdCell(plugin.entries.join(', '))} |`),
        '',
        '## 2. 能力矩阵',
        '',
        `| 能力 | 来源字段 | ${matrix.ids.map((id) => mdCell(names.get(id) ?? id)).join(' | ')} |`,
        `| --- | --- | ${matrix.ids.map(() => '---').join(' | ')} |`,
        ...matrix.rows.map((row) => `| ${mdCell(row.label)} | ${SOURCE_LABELS[row.source]} | ${matrix.ids.map((id) => row.cells[id] ? '✓' : '—').join(' | ')} |`),
        '',
        '## 3. 重叠冲突',
        '',
        ...(overlaps.length
            ? overlaps.map((overlap) => `- [${overlap.severity === 'conflict' ? '冲突' : '重叠'}] ${overlap.detail}；${overlap.reuse}`)
            : ['- 未发现重叠字段。']),
        '',
        '## 4. 复用不重写清单',
        '',
        ...(reuseList.length
            ? reuseList.map((item) => `- ${item.owner} → ${item.consumers.join('、') || '(全体)'}：${item.label}（${item.field}）— ${item.instruction}`)
            : ['- 无复用项；各插件能力互不重叠。']),
        '',
        '## 5. 借鉴来源与差异（§8 强制，不得省略）',
        '',
        '| 来源插件 | 仓库 | 许可 | 上游借鉴 | 差异 / 不重写项 | 署名方式 |',
        '| --- | --- | --- | --- | --- | --- |',
        ...sourceTable.map((row) => `| ${mdCell(row.name)} | ${mdCell(row.repo)} | ${row.license} | ${mdCell(row.borrowedFrom.join('、') || '无')} | ${mdCell(row.differences.join('；'))} | ${mdCell(row.attribution)} |`),
        '',
        '## 6. 脚手架落盘清单（仅 --apply 时写入）',
        '',
        '- package.json / tsconfig.json / tsconfig.build.json / cordis.patch.yml',
        '- src/index.ts / lib/index.js / lib/types/index.d.ts / test/smoke.test.mjs',
        '- README.md / BORROWED.md（借鉴来源与差异）/ LICENSE / fuse-plan.json',
        '',
        '## 7. License 合规声明',
        '',
        `融合池仅含 ${licenseList} 插件；任何 GPL / AGPL / 未知许可片段都拒绝进入产物。`,
        '落盘后先 `npm run build && npm run check`，再用 `node scripts/vendor/verify-plugin.mjs <产物目录>` 过官方门禁。',
    ];
    return lines.join('\n');
}
function renderSourceTableMarkdown(rows) {
    return [
        '# 借鉴来源与差异',
        '',
        '本脚手架融合自下列插件；下表为强制署名与差异声明（计划 §8）。',
        '',
        '| 来源插件 | 仓库 | 许可 | 上游借鉴 | 差异 / 不重写项 | 署名方式 |',
        '| --- | --- | --- | --- | --- | --- |',
        ...rows.map((row) => `| ${mdCell(row.name)} | ${mdCell(row.repo)} | ${row.license} | ${mdCell(row.borrowedFrom.join('、') || '无')} | ${mdCell(row.differences.join('；'))} | ${mdCell(row.attribution)} |`),
        '',
    ].join('\n');
}
function slugify(ids) {
    const parts = ids.map((id) => id.replace(/^dsh-plugin-/, '').replace(/[^a-z0-9]+/g, '-'));
    return `dsh-plugin-fused-${parts.join('-')}`.replace(/-+/g, '-').replace(/-$/, '');
}
/** Generate a gate-ready plugin scaffold. `lib/` is committed on purpose: the
 * family gate's G0-9 checks that the declared entry is in the git tree. */
export function buildScaffolding(plan) {
    const { plugins, ids, matrix, overlaps, reuseList, sourceTable } = plan;
    const slug = slugify(ids);
    const description = `融合脚手架：${plugins.map((plugin) => plugin.name).join(' + ')}（由 /market fuse 生成）`;
    const pkg = {
        name: slug,
        version: '0.1.0',
        description,
        type: 'module',
        license: 'MIT',
        main: './lib/index.js',
        types: './lib/types/index.d.ts',
        exports: {
            '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
            './package.json': './package.json',
        },
        files: ['lib', 'src', 'README.md', 'LICENSE', 'BORROWED.md', 'cordis.patch.yml', 'fuse-plan.json'],
        engines: { node: '>=22.18' },
        scripts: {
            build: 'tsc -p tsconfig.json',
            prepare: 'npm run build',
            test: 'node --test test/*.test.mjs',
            typecheck: 'tsc --noEmit',
            check: 'npm run typecheck && npm test && npm run build',
        },
        devDependencies: { '@types/node': '26.6.2', typescript: '7.0.2' },
        peerDependencies: { '@deepseek-ai/cordis': '>=4.0.0' },
        sideEffects: false,
        repository: { type: 'git', url: `https://github.com/121212165/${slug}.git` },
    };
    const tsconfig = {
        compilerOptions: {
            target: 'ES2023', lib: ['ES2023'], module: 'NodeNext', moduleResolution: 'NodeNext',
            strict: true, noUnusedLocals: true, noUnusedParameters: true,
            noFallthroughCasesInSwitch: true, exactOptionalPropertyTypes: true,
            noEmit: false, declaration: true, declarationDir: './lib/types', outDir: './lib', rootDir: './src',
            skipLibCheck: true, types: ['node'],
        },
        include: ['src/**/*.ts'],
        exclude: ['lib', 'node_modules'],
    };
    const indexSource = [
        `/** ${description}. Generated by /market fuse — fill in real logic, then build + verify. */`,
        `export const name = ${JSON.stringify(slug)};`,
        `export const fusedFrom = ${JSON.stringify(ids)};`,
        `export const reuse = ${JSON.stringify(reuseList.map((item) => ({ field: item.field, owner: item.owner, consumers: item.consumers })))};`,
        `export const overlaps = ${JSON.stringify(overlaps.map((item) => ({ key: item.key, label: item.label, severity: item.severity, members: item.members })))};`,
        'export function inspect(): { name: string; fusedFrom: string[] } { return { name, fusedFrom }; }',
        '',
    ].join('\n');
    const libSource = [
        `/** ${description}. Generated by /market fuse — replace with built output. */`,
        `export const name = ${JSON.stringify(slug)};`,
        `export const fusedFrom = ${JSON.stringify(ids)};`,
        `export const reuse = ${JSON.stringify(reuseList.map((item) => ({ field: item.field, owner: item.owner, consumers: item.consumers })))};`,
        `export const overlaps = ${JSON.stringify(overlaps.map((item) => ({ key: item.key, label: item.label, severity: item.severity, members: item.members })))};`,
        'export function inspect() { return { name, fusedFrom }; }',
        '',
    ].join('\n');
    const readme = [
        `# ${slug}`,
        '',
        description,
        '',
        `融合来源：${ids.join(', ')}`,
        '',
        '## 复用不重写清单',
        '',
        ...(reuseList.length ? reuseList.map((item) => `- ${item.owner} → ${item.consumers.join('、') || '(全体)'}：${item.label}（${item.field}）— ${item.instruction}`) : ['- 无。']),
        '',
        '## 借鉴来源与差异',
        '',
        '见 BORROWED.md（强制署名表）。融合池仅含 MIT / Apache-2.0，GPL 片段一律拒绝。',
        '',
        '## 门禁',
        '',
        '`npm run build && npm run check && node scripts/vendor/verify-plugin.mjs .`',
        '',
    ].join('\n');
    const mitLicense = [
        'MIT License',
        '',
        `Copyright (c) ${new Date().getUTCFullYear()} fused artifact (see BORROWED.md for upstream sources)`,
        '',
        'Permission is hereby granted, free of charge, to any person obtaining a copy',
        'of this software and associated documentation files (the "Software"), to deal',
        'in the Software without restriction, including without limitation the rights',
        'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
        'copies of the Software, and to permit persons to whom the Software is',
        'furnished to do so, subject to the following conditions:',
        '',
        'The above copyright notice and this permission notice shall be included in all',
        'copies or substantial portions of the Software.',
        '',
        'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
        'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
        'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
        'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
        'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
        'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
        'SOFTWARE.',
        '',
    ].join('\n');
    const planJson = JSON.stringify({
        ids,
        licenses: plugins.map((plugin) => ({ id: plugin.id, license: normalizeLicense(plugin.license) })),
        matrix,
        overlaps,
        reuseList,
        sourceTable,
        generatedAt: '',
    }, null, 2) + '\n';
    return [
        { path: 'package.json', content: JSON.stringify(pkg, null, 2) + '\n' },
        { path: 'tsconfig.json', content: JSON.stringify(tsconfig, null, 2) + '\n' },
        { path: 'tsconfig.build.json', content: JSON.stringify({ extends: './tsconfig.json', compilerOptions: { noEmit: false } }, null, 2) + '\n' },
        { path: 'cordis.patch.yml', content: '# Generated fuse scaffold — fill in the real cordis injection patch.\ninsert: []\n' },
        { path: 'src/index.ts', content: indexSource },
        { path: 'lib/index.js', content: libSource },
        { path: 'lib/types/index.d.ts', content: `export declare const name: string;\nexport declare const fusedFrom: string[];\nexport declare function inspect(): { name: string; fusedFrom: string[] };\n` },
        { path: 'test/smoke.test.mjs', content: `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { inspect } from '../lib/index.js';\ntest('fuse scaffold exposes metadata', () => {\n  const value = inspect();\n  assert.equal(value.name, ${JSON.stringify(slug)});\n  assert.deepEqual(value.fusedFrom, ${JSON.stringify(ids)});\n});\n` },
        { path: 'README.md', content: readme },
        { path: 'BORROWED.md', content: renderSourceTableMarkdown(sourceTable) },
        { path: 'LICENSE', content: mitLicense },
        { path: 'fuse-plan.json', content: planJson },
    ];
}
/** One entry point for both the command and the tool. Phase 1 returns the task
 * book only; phase 2 (--apply) additionally returns the files to write. */
export function buildFusePlan(index, input) {
    const validation = validateFuseSelection(input, index);
    if (!validation.ok)
        throw new FuseValidationError(validation.errors);
    const plugins = validation.eligible;
    const matrix = buildCapabilityMatrix(plugins);
    const overlaps = detectOverlaps(matrix);
    const reuseList = buildReuseList(overlaps);
    const sourceTable = buildSourceTable(plugins, overlaps);
    const base = { ids: validation.ids, plugins, validation, matrix, overlaps, reuseList, sourceTable };
    return { ...base, taskBook: renderTaskBook(base), scaffolding: buildScaffolding(base) };
}
export function runFuse(index, input, apply) {
    const plan = buildFusePlan(index, input);
    if (!apply) {
        return {
            ok: true, plan, phase: 'task-book', files: [],
            text: `${plan.taskBook}\n\n任务书未落盘。确认后运行 \`/market fuse ${plan.ids.join(',')} --apply\` 写入脚手架。`,
        };
    }
    return {
        ok: true, plan, phase: 'applied', files: plan.scaffolding,
        text: `${plan.taskBook}\n\n## 脚手架落盘\n\n写入 ${plan.scaffolding.length} 个文件到输出目录；落盘后运行 \`npm run check\` 与 \`node scripts/vendor/verify-plugin.mjs <产物目录>\`。`,
    };
}
export function renderFuseRejection(error) {
    const errors = typeof error === 'string' ? [error] : error.errors;
    return [
        '# 融合任务书（已拒绝）',
        '',
        '未产出任何脚手架，未落盘。原因：',
        ...errors.map((reason) => `- ${reason}`),
        '',
        '修正后重试：`/market fuse <2–5 个插件 id>`（仅 MIT / Apache-2.0）。',
    ].join('\n');
}
