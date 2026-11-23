/**
 * F4 — local plugin doctor.
 *
 * Verdicts come from the vendored family checker (`scripts/vendor/verify-plugin.mjs`):
 * this module only parses its output, maps each code to P0/P1/P2 and attaches a concrete
 * "where to edit + code to write" remedy. It deliberately does not re-implement the gates.
 *
 * The only local assertion is G0-6 locale resources: the family checker inspects the
 * `locale/` layout, while family plugins publish `src/locales` → `exports["./locales/*"]`
 * → `lib/locales` (M5 completion record). A repo missing that chain passes the vendored
 * checker silently, so the doctor must name G0-6 and give the exports edit location.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2 };
/** FAIL codes that are quality debt rather than hard publish blockers. */
const P1_FAIL_CODES = new Set(['SDS-1b', 'SDS-2']);
/** WARN codes that still mean "should fix", not merely "nice to have". */
const P1_WARN_CODES = new Set(['G0-6', 'SDS-1', 'SDS-2']);
/** Parse the vendor checker's `FAIL:` / `WARN:` sections (no re-judgement). */
export function parseVendorOutput(stdout) {
    const parsed = [];
    let severity = null;
    for (const rawLine of String(stdout).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === 'FAIL:') {
            severity = 'FAIL';
            continue;
        }
        if (line === 'WARN:') {
            severity = 'WARN';
            continue;
        }
        if (!severity || !line || line.startsWith('结果:'))
            continue;
        const match = line.match(/^(?:(?<id>[^:]+):\s*)?(?<code>G0-\d+|SDS-\d+[a-z]?):\s*(?<message>.*)$/);
        parsed.push(match?.groups
            ? { severity, code: match.groups.code ?? null, message: match.groups.message ?? '', raw: line }
            : { severity, code: null, message: line, raw: line });
    }
    return parsed;
}
export function priorityFor(severity, code) {
    if (severity === 'FAIL')
        return code && P1_FAIL_CODES.has(code) ? 'P1' : 'P0';
    return code && P1_WARN_CODES.has(code) ? 'P1' : 'P2';
}
function snippet(...lines) {
    return lines.join('\n');
}
const REMEDIES = {
    'G0-5': (line, _pkg) => {
        const key = line.message.match(/exports\["([^"]+)"\]/)?.[1] ?? '<exports-key>';
        const file = line.message.match(/指向不存在的\s+(\S+)/)?.[1] ?? '<missing-file>';
        return {
            location: `package.json#exports["${key}"] → ${file}`,
            fix: snippet('// package.json — 指向真实存在且已入库的文件（保留其它 exports 键）', `"exports": { "${key}": "<仓库内已存在的路径>" }`, `// ${file} 若由构建生成：npm run build 后 git add lib/ && git commit -m "build: commit lib/"`),
        };
    },
    'G0-6': (_line, _pkg) => ({
        location: 'package.json#exports["./locales/*"]、src/locales/<lang>.json、lib/locales/<lang>.json',
        fix: snippet('// 1) package.json — 与现有 exports 合并，勿覆盖 "." / "./core"', '"exports": { ".": { "default": "./lib/index.js" }, "./locales/*": "./lib/locales/*" }', '// 2) src/locales/zh-CN.json — 新增/补齐语言资源，键与其它语言文件逐一对应', '{ "market": { "title": "插件市集" } }', '// 3) scripts/copy-assets.mjs — 构建时拷贝到发布目录', "copyFileSync(join(root, 'src/locales/zh-CN.json'), join(root, 'lib/locales/zh-CN.json'))", '// 4) npm run build && git add lib/locales && git commit -m "build: locales"（G0-9 要求入库）'),
    }),
    'G0-7': (_line, _pkg) => ({
        location: '<插件仓>/.git/',
        fix: snippet('git init && git add -A && git commit -m "chore: init plugin repo"', '// G0-9 还需提交构建产物：npm run build && git add lib && git commit -m "build: commit lib/"'),
    }),
    'G0-8': (line, pkg) => ({
        location: 'package.json#repository.url',
        fix: snippet('"repository": { "type": "git", "url": "https://github.com/121212165/<repo>.git" }', line.severity === 'WARN'
            ? `// 当前值 ${pkg?.repository?.url ?? '(空)'} 未能联网确认；用 gh auth status && gh api repos/121212165/<repo> 复核`
            : '// 必须是家族命名空间 github.com/121212165/<repo>，不接受伪主机/子路径/凭据'),
    }),
    'G0-9': (line, _pkg) => {
        const file = line.message.match(/入口\s+(\S+)/)?.[1] ?? 'lib/index.js';
        return {
            location: `${file}（package.json#exports["."] 的入口）+ package.json#files`,
            fix: snippet('npm run build', `git add ${file} lib package.json && git commit -m "build: commit lib/ for git distribution"`, '// dsh-plugin-hub 的 git 通道在构建前校验 git 树里的入口，未提交会 400（ide-hub#1）'),
        };
    },
    'G0-10': (_line, _pkg) => ({
        location: 'src/index.ts（包入口）',
        fix: snippet("export { inject } from './plugin.ts';", '// 宿主从包入口读取 inject；不转发会以 "cannot get property ... without inject" 拒绝激活'),
    }),
    'SDS-1': (line, _pkg) => ({
        location: '<插件仓>/src/、test/、lib/、cordis.patch.yml、tsconfig.json、tsconfig.build.json',
        fix: snippet(line.message.includes('lib')
            ? 'mkdir -p src test lib && npm run build && git add lib && git commit -m "build: commit lib/"'
            : 'mkdir -p src test lib && npm run build', '// 这四类文件是家族插件的目录/构建产物契约，缺一即无法进入市场'),
    }),
    'SDS-1b': (_line, _pkg) => ({
        location: 'tsconfig.json#compilerOptions',
        fix: snippet('{ "compilerOptions": {', '  "noUnusedLocals": true,', '  "noUnusedParameters": true,', '  "noFallthroughCasesInSwitch": true,', '  "exactOptionalPropertyTypes": true', '} }'),
    }),
    'SDS-2': (line, _pkg) => ({
        location: 'package.json#dependencies / devDependencies / peerDependencies',
        fix: snippet('"devDependencies": { "typescript": "7.0.2", "@types/node": "26.6.2" },', '"peerDependencies": { "@deepseek-ai/cordis": ">=4.0.0" },', '"dependencies": {}  // 运行时只允许 @dsh-family/*；其它依赖移到 devDependencies 或去掉', line.message.includes('caret')
            ? '// @deepseek-ai/* 预发布外必须精确锁定：去掉版本号前的 ^'
            : '// 用 npm pkg set devDependencies.typescript=<精确版本> 可直接落盘'),
    }),
    'SDS-3': (line, pkg) => {
        const field = line.message.match(/缺字段\s+(\S+)/)?.[1] ?? '';
        const script = line.message.match(/缺 script\s+(\S+)/)?.[1] ?? '';
        let fix;
        if (line.message.includes('license'))
            fix = '"license": "MIT"';
        else if (line.message.includes('type 必须 module'))
            fix = '"type": "module"';
        else if (line.message.includes('sideEffects'))
            fix = '"sideEffects": false';
        else if (line.message.includes('engines.node'))
            fix = '"engines": { "node": ">=22.18" }';
        else if (line.message.includes('repository'))
            fix = '"repository": { "type": "git", "url": "https://github.com/121212165/<repo>.git" }';
        else if (script)
            fix = `"scripts": { "${script}": "<可执行命令>" }  // 缺的脚本：${script}；完整集合 build/prepare/test/typecheck/check`;
        else if (field)
            fix = `"${field}": "<按 SDS-3 填写>"  // 当前 package.json 缺此必需字段`;
        else
            fix = `npm pkg set <字段>=<值>  // 按门禁信息修正：${line.message}`;
        return {
            location: field ? `package.json#${field}` : script ? `package.json#scripts.${script}` : `package.json#${line.message.split(':')[0] ?? ''}`,
            fix: snippet(fix, `// 当前 name=${pkg?.name ?? '(未知)'} license=${pkg?.license ?? '(未知)'}`),
        };
    },
    'G0-VENDOR': (_line, _pkg) => ({
        location: 'scripts/vendor/verify-plugin.mjs',
        fix: snippet('node scripts/vendor/verify-plugin.mjs <插件仓路径>  // 先确认门禁脚本本身可运行', '// 若输出异常，按 vendor 头部记录的 commit SHA 重新同步脚本，勿修改门禁逻辑'),
    }),
};
function issueFrom(line, pkg, target) {
    const code = line.code ?? 'G0-VENDOR';
    const remedy = REMEDIES[code]?.(line, pkg) ?? {
        location: `${target}/package.json`,
        fix: snippet(`按门禁输出修改：${line.message}`, `改完重跑 /market doctor ${target}`),
    };
    return {
        code,
        priority: priorityFor(line.severity, line.code),
        severity: line.severity,
        message: line.message,
        location: remedy.location,
        fix: remedy.fix,
    };
}
function hasLocaleJson(dir) {
    try {
        return existsSync(dir) && readdirSync(dir).some((name) => name.endsWith('.json'));
    }
    catch {
        return false;
    }
}
/** The one local assertion: vendored G0-6 only sees `locale/`, not the published chain. */
function localLocaleIssue(target, pkg, vendorSpokeLocale) {
    if (vendorSpokeLocale)
        return null; // vendor owns this verdict; do not duplicate it
    const hasSrc = hasLocaleJson(join(target, 'src', 'locales'));
    const hasLib = hasLocaleJson(join(target, 'lib', 'locales'));
    const exported = typeof pkg?.exports?.['./locales/*'];
    const hasExport = exported === 'string' && (pkg?.exports?.['./locales/*']).length > 0;
    if (hasSrc && hasLib && hasExport)
        return null;
    const missing = [];
    if (!hasSrc)
        missing.push('src/locales/<lang>.json 不存在');
    if (!hasExport)
        missing.push('package.json#exports["./locales/*"] 未声明');
    if (!hasLib)
        missing.push('lib/locales/<lang>.json 未构建/未入库');
    return {
        code: 'G0-6',
        priority: 'P0',
        severity: 'FAIL',
        message: `locale 资源/导出链不完整（${missing.join('；')}）`,
        location: 'package.json#exports["./locales/*"]、src/locales/<lang>.json、lib/locales/<lang>.json',
        fix: snippet('// 1) package.json — 与现有 exports 合并，勿覆盖 "." / "./core"', '"exports": { ".": { "default": "./lib/index.js" }, "./locales/*": "./lib/locales/*" }', '// 2) src/locales/zh-CN.json — 新增/补齐语言资源，键与其它语言文件逐一对应', '{ "market": { "title": "插件市集" } }', '// 3) scripts/copy-assets.mjs — 构建时拷贝到发布目录（G0-6 的构建拷贝）', "copyFileSync(join(root, 'src/locales/zh-CN.json'), join(root, 'lib/locales/zh-CN.json'))", '// 4) npm run build && git add lib/locales && git commit -m "build: locales"（G0-9 要求入库）'),
    };
}
/** Run the vendored gate on a local plugin repo and turn its verdict into an actionable list. */
export async function runDoctor(options) {
    const target = String(options.target ?? '').trim();
    if (!target) {
        const issue = {
            code: 'ARGS',
            priority: 'P0',
            severity: 'FAIL',
            message: '缺少本地插件仓路径',
            location: '/market doctor <path> 的 <path> 参数（或 market_doctor 的 path 参数）',
            fix: snippet('/market doctor C:\\work\\dsh-plugin-foo', 'market_doctor { "path": "C:\\\\work\\\\dsh-plugin-foo" }'),
        };
        return {
            target: '',
            ok: false,
            counts: { P0: 1, P1: 0, P2: 0 },
            issues: [issue],
            gateSource: 'scripts/vendor/verify-plugin.mjs（家族官方判定）+ 本地 G0-6 断言',
            note: 'P0=发布阻断 / P1=应修 / P2=建议；体检只读，不修改目标仓。',
        };
    }
    const vendorScript = options.vendorScript
        ?? fileURLToPath(new URL('../../scripts/vendor/verify-plugin.mjs', import.meta.url));
    let pkg = null;
    try {
        pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    }
    catch {
        // Unreadable package.json is already reported by the vendor gate.
    }
    const result = spawnSync(process.execPath, [vendorScript, target], {
        encoding: 'utf8',
        windowsHide: true,
    });
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    const parsed = parseVendorOutput(stdout);
    const issues = parsed.map((line) => issueFrom(line, pkg, target));
    if (result.error) {
        issues.push({
            code: 'G0-VENDOR',
            priority: 'P1',
            severity: 'WARN',
            message: `门禁脚本无法执行：${result.error.message}`,
            location: vendorScript,
            fix: `node ${vendorScript} ${target}`,
        });
    }
    else if (result.status !== 0 && result.status !== 1) {
        issues.push({
            code: 'G0-VENDOR',
            priority: 'P1',
            severity: 'WARN',
            message: `门禁脚本异常退出（status=${String(result.status)}）`,
            location: vendorScript,
            fix: `node ${vendorScript} ${target} 查看完整输出`,
        });
    }
    if (stderr.trim()) {
        issues.push({
            code: 'G0-VENDOR',
            priority: 'P2',
            severity: 'WARN',
            message: `门禁 stderr：${stderr.trim().slice(0, 300)}`,
            location: vendorScript,
            fix: `node ${vendorScript} ${target} 复核`,
        });
    }
    const vendorSpokeLocale = parsed.some((line) => line.code === 'G0-6') || hasLocaleJson(join(target, 'locale'));
    const local = localLocaleIssue(target, pkg, vendorSpokeLocale);
    if (local)
        issues.push(local);
    issues.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.code.localeCompare(b.code));
    const counts = {
        P0: issues.filter((issue) => issue.priority === 'P0').length,
        P1: issues.filter((issue) => issue.priority === 'P1').length,
        P2: issues.filter((issue) => issue.priority === 'P2').length,
    };
    return {
        target,
        ok: counts.P0 === 0,
        counts,
        issues,
        gateSource: 'scripts/vendor/verify-plugin.mjs（家族官方判定，vendor @0915c5e）+ 本地 G0-6 资源/exports 断言',
        note: 'P0=发布阻断 / P1=应修 / P2=建议；门禁判定复用 vendor 输出，未另写一套门禁；体检只读，不修改目标仓。',
    };
}
/** Shared with the `/market doctor` command and the `market_doctor` model tool. */
export function renderDoctorReport(report) {
    const labels = {
        P0: 'P0 发布阻断',
        P1: 'P1 应修',
        P2: 'P2 建议',
    };
    const lines = [
        `插件体检报告：${report.target}`,
        `门禁来源：${report.gateSource}`,
        '',
    ];
    for (const priority of ['P0', 'P1', 'P2']) {
        const group = report.issues.filter((issue) => issue.priority === priority);
        lines.push(`${labels[priority]}（${group.length}）`);
        if (!group.length) {
            lines.push('  （无）');
        }
        else {
            for (const issue of group) {
                lines.push(`  [${issue.code}] ${issue.message}`);
                lines.push(`    修改位置：${issue.location}`);
                lines.push('    建议代码：');
                for (const fixLine of issue.fix.split('\n'))
                    lines.push(`      ${fixLine}`);
            }
        }
        lines.push('');
    }
    lines.push(report.ok
        ? '结论：可发布（无 P0）；P1/P2 建议在下次提交前处理。'
        : `结论：不通过 —— ${report.counts.P0} 个 P0 发布阻断必须先修。`);
    lines.push(`重跑：/market doctor ${report.target || '<path>'}`);
    lines.push(report.note);
    return lines.join('\n');
}
