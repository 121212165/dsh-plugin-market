#!/usr/bin/env node
// Vendored from 121212165/dsh-family-tools @ 0915c5e099bc212f259ea7e791c10ef9d241ce5e
// 源文件: tools/verify-plugin.mjs（家族官方门禁，勿本地修改逻辑）
// 同步方式: gh api / 本地家族仓检出后 cp tools/verify-plugin.mjs <本仓>/scripts/vendor/verify-plugin.mjs，再更新本头部的 commit SHA
// 升级门禁时重新同步并更新 SHA，勿改检查项。
// verify-plugin.mjs — SDS-1/2/3 规范校验器
// 用法: node tools/verify-plugin.mjs [-r] [插件目录...]
//   -r        = 联网模式：额外校验 repository.url 远端可达
//   不带参数 = 校验 workspace 内全部参与插件
// 退出码: 有 FAIL 项 -> 1；仅 WARN -> 0
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");
const EXCLUDED = new Set(["dsh-plugin-family-cards"]);
const PREBUILT = new Set(["dsh-plugin-token-telemetry"]);
// 本地实验仓：无 GitHub 远端、不参与分发，G0-9 分发完整性门禁豁免（family#5 同类决策）
const LOCAL_ONLY = new Set(["dsh-plugin-forge-v2"]);
// dsh-plugin-family / dsh-plugin-kit: 插件群共享库（@dsh-family/*），SDS-2 的宿主依赖项豁免
const SHARED = new Set(["dsh-plugin-family", "dsh-plugin-kit"]);

// tsconfig 必须开启的静态严格度（OPTIMIZATION-PLAN-2026-10-19 T0-3 / G2-1,2）
const STRICT_FLAGS = ["noUnusedLocals", "noUnusedParameters", "noFallthroughCasesInSwitch", "exactOptionalPropertyTypes"];

/** flatten {"a":{"b":1}} -> ["a.b"] */
function flatKeys(obj, prefix = "") {
  const keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) keys.push(...flatKeys(value, path));
    else keys.push(path);
  }
  return keys;
}

/** 归一化家族既有的两种合理形态（否则会误报）：
 * 1. zh.json 独有的 meta.description 中文长描述（家族统一约定，无需 en 对应键）；
 * 2. en.json/zh.json 各自带 description.<lang> 自描述（每文件只声明本语言的键，
 *    把本语言段归一为 LANG 占位符后即可对等比较）。 */
function normalizeLocaleKeys(keys, lang, fileBase) {
  return keys
    .filter(k => !(k.startsWith("meta.description") || k.startsWith(`meta.${lang}.`)))
    .map(k => {
      const parts = k.split(".");
      if (parts[parts.length - 1] === lang) parts[parts.length - 1] = "LANG";
      return parts.map(p => (p === fileBase ? "LANGFILE" : p)).join(".");
    });
}

function checkLibExists(dir) {
  return existsSync(join(dir, "lib"));
}

/** SDS-1：lib/ 自 2026-10-24 起入库；exports 必须落盘，不能靠未来 build 掩盖缺失。 */
function checkExportsTargets(dir, exports, id, fail) {
  for (const [key, target] of Object.entries(exports)) {
    if (key.startsWith("./locale/") || key === "./package.json" || key.includes("*")) continue;
    const paths = (typeof target === "string" ? [target] : Object.values(target)).filter(v => typeof v === "string");
    for (const p of paths) {
      if (!existsSync(resolve(dir, p))) fail.push(`G0-5: exports["${key}"] 指向不存在的 ${p}`);
    }
  }
}

function checkLocale(dir, fail, warn) {
  const localeDir = join(dir, "locale");
  if (!existsSync(localeDir)) return;
  const files = readdirSync(localeDir).filter(n => n.endsWith(".json"));
  if (files.length < 2) {
    if (files.length) warn.push(`G0-6: locale 只有 ${files[0]}，缺对等语言文件`);
    return;
  }
  let base = null;
  for (const file of files) {
    const fileBase = file.replace(/\.json$/, "");
    let keys;
    try {
      keys = normalizeLocaleKeys(flatKeys(JSON.parse(readFileSync(join(localeDir, file), "utf8"))), fileBase, fileBase);
    } catch {
      fail.push(`G0-6: locale/${file} 无法解析`);
      continue;
    }
    if (base === null) { base = { file, keys }; continue; }
    const missing = base.keys.filter(k => !keys.includes(k));
    const extra = keys.filter(k => !base.keys.includes(k));
    for (const k of missing) fail.push(`G0-6: locale/${file} 缺键 ${k}（${base.file} 有）`);
    for (const k of extra) fail.push(`G0-6: locale/${file} 多键 ${k}（${base.file} 没有）`);
  }
}

function checkGit(dir, id, warn, fail) {
  if (!existsSync(join(dir, ".git"))) {
    fail.push(`G0-7: 目录不在版本控制下（所有家族插件已建仓，新插件必须先建仓再入库）`);
    return;
  }
  // 对已建仓目录：tag 由发布脚本/建仓脚本保证，这里只检查 git dir 完整性
}

/** dsh-plugin-hub v1.5.2 预检的入口解析（exports["."] default→import→require → main → index.js） */
function resolveEntry(pkgs) {
  const e = pkgs.exports?.["."];
  if (typeof e === "string") return e;
  if (e && typeof e === "object") return e.default ?? e.import ?? e.require ?? null;
  return pkgs.main ?? "./index.js";
}

export function gitCommitted(dir, rel, run = execFileSync) {
  try {
    // ls-files 只证明进入索引；必须检查 HEAD，暂存而未提交不算分发就绪。
    run("git", ["-C", dir, "cat-file", "-e", `HEAD:${rel.replaceAll("\\", "/").replace(/\/$/, "")}`], { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false; // 无 HEAD、未提交或 git 执行失败，均不能证明分发完整性
  }
}

/** G0-9 分发完整性：dsh-plugin-hub git 通道在下载 tarball（= git 树）后、任何构建之前
 * 校验 package.json 声明的入口文件是否在包里。构建产物不提交 → 市场安装 400（ide-hub#1 根因）。 */
function checkDistribution(dir, pkgs, fail) {
  const entry = resolveEntry(pkgs);
  if (!entry) return;
  const rel = entry.replace(/^\.\//, "");
  const tracked = gitCommitted(dir, rel);
  if (tracked === false) {
    fail.push(
      existsSync(join(dir, rel))
        ? `G0-9: 入口 ${rel} 已生成但未提交（市场 git 通道预检会 400，见 ide-hub#1；build 后提交 lib/）`
        : `G0-9: 入口 ${rel} 既不存在也未提交（先 npm run build 再提交 lib/）`
    );
  }
  for (const f of pkgs.files ?? []) {
    if (f.includes("*") || f === "lib" || f === "src") continue; // lib 由入口检查覆盖；src 不影响分发预检
    if (existsSync(join(dir, f)) && gitCommitted(dir, f) === false) {
      fail.push(`G0-9: files 声明的 ${f} 未提交（市场 git 分发缺资产）`);
    }
  }
}

export function runtimeDependencyWarnings(dependencies = {}) {
  const unexpected = Object.keys(dependencies).filter(name => !/^@dsh-family\/[^/]+$/.test(name)).sort();
  return unexpected.length ? [`SDS-2: 非 @dsh-family/* 运行时 dependencies: ${unexpected.join(", ")}（仍为 WARN，未获准放行）`] : [];
}

export function parseGitHubRepository(url) {
  // 精确验证协议、主机、家族 owner 和单一 repo 段；拒绝伪主机、凭据、query、fragment、子路径。
  const match = typeof url === "string" && url.match(/^(?:git\+)?https:\/\/github\.com\/121212165\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match || match[1] === "." || match[1] === "..") return null;
  return `121212165/${match[1]}`;
}

export function checkRepoReachable(url, id, fail, warn, run = execFileSync) {
  const repo = parseGitHubRepository(url);
  if (!repo) {
    fail.push(`${id}: G0-8: repository.url 结构无效: ${url}`);
    return;
  }
  try {
    run("gh", ["api", "--hostname", "github.com", "--method", "GET", `repos/${repo}`], {
      encoding: "utf8", timeout: 10_000, stdio: "pipe",
    });
  } catch (error) {
    const detail = `${error.stderr ?? ""}\n${error.stdout ?? ""}\n${error.message ?? ""}`;
    const status = detail.match(/\bHTTP(?:\/\S+)?\s+(\d{3})\b/)?.[1];
    if (status === "404") {
      fail.push(`${id}: G0-8: repository ${url} HTTP 404（不存在或当前 gh 身份不可见）`);
    } else {
      const reason = status ? `HTTP ${status}，鉴权/限流/服务异常` : `网络/超时/gh 不可用：${error.code ?? "unknown"}`;
      warn.push(`${id}: G0-8: repository ${url} 未完成可达性验证（${reason}；不能判定为 404）`);
    }
  }
}

function check(dir) {
  const id = basename(dir);
  const pkgs = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const fail = [], warn = [];

  // --- SDS-1 目录结构：lib/ 是已入库的分发产物，发布前还须验证 build 后无漂移 ---
  const isPrebuilt = PREBUILT.has(id);
  const isShared = SHARED.has(id);
  if (!isPrebuilt) {
    for (const need of ["src", "test"]) {
      if (!existsSync(join(dir, need))) fail.push(`SDS-1: 缺 ${need}/`);
    }
    if (!checkLibExists(dir)) fail.push(`SDS-1: 缺 lib/（已入库的分发产物；build 后须提交）`);
    if (checkLibExists(dir) && !existsSync(join(dir, "lib", "index.js"))) fail.push(`SDS-1: lib 已存在但缺 lib/index.js`);
    const opts = isShared ? ["tsconfig.json", "tsconfig.build.json"] : ["cordis.patch.yml", "tsconfig.json", "tsconfig.build.json"];
    for (const opt of opts) {
      if (!existsSync(join(dir, opt))) warn.push(`SDS-1: 缺 ${opt}`);
    }
  } else {
    if (!existsSync(join(dir, "lib"))) fail.push(`SDS-1: prebuilt 插件缺 lib/`);
  }

  // --- SDS-1b 静态严格度（T0-3 断言）---
  if (!isPrebuilt && existsSync(join(dir, "tsconfig.json"))) {
    const tsconfig = JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
    const options = tsconfig.compilerOptions ?? {};
    for (const flag of STRICT_FLAGS) {
      if (options[flag] !== true) fail.push(`SDS-1b: tsconfig.json 缺 ${flag}（G2-1/2 静态严格度门禁）`);
    }
  }

  // --- SDS-2 依赖 ---
  const dev = pkgs.devDependencies ?? {};
  const peer = pkgs.peerDependencies ?? {};
  warn.push(...runtimeDependencyWarnings(pkgs.dependencies ?? {}));
  if (!isPrebuilt && !isShared) {
    if (!dev["typescript"]) fail.push(`SDS-2: 缺 typescript devDep`);
    if (!dev["@types/node"]) fail.push(`SDS-2: 缺 @types/node devDep`);
  }
  if (!isShared && !peer["@deepseek-ai/cordis"]) fail.push(`SDS-2: 缺 cordis peerDependency`);
  // 预发布版本不允许 caret 升级歧义之外的非精确锚点
  for (const [dep, ver] of Object.entries({ ...dev })) {
    if (dep.startsWith("@deepseek-ai/") && ver.startsWith("^")) {
      const isPre = /-alpha|-rc|-beta/.test(ver);
      if (!isPre) warn.push(`SDS-2: ${dep} 使用 caret（正式版应精确锁定）`);
    }
  }

  // --- SDS-3 元数据 ---
  const must = ["name", "version", "description", "type", "license", "main", "exports", "files", "engines"];
  if (LOCAL_ONLY.has(id)) {
    if (pkgs.private !== true || pkgs.repository || pkgs.bugs) fail.push('SDS-3: local-only 必须 private:true 且不声明 repository/bugs');
  } else must.push('repository');
  for (const f of must) if (!(f in pkgs)) fail.push(`SDS-3: 缺字段 ${f}`);
  if (pkgs.type !== "module") fail.push(`SDS-3: type 必须 module`);
  if (pkgs.license !== "MIT") fail.push(`SDS-3: license 必须 MIT`);
  if (pkgs.sideEffects !== false) warn.push(`SDS-3: sideEffects 未显式 false`);
  const s = pkgs.scripts ?? {};
  const gateScripts = isPrebuilt ? [] : ["build", "prepare", "test", "typecheck", "check"];
  for (const sc of gateScripts) {
    if (!(sc in s)) fail.push(`SDS-3: 缺 script ${sc}`);
  }
  if (pkgs.engines?.node) {
    const m = pkgs.engines.node.match(/(\d+)\.(\d+)/);
    if (!m || +m[1] < 22 || (+m[1] === 22 && +m[2] < 18)) fail.push(`SDS-3: engines.node 低于 22.18`);
  }
  // repository 必须是 github.com/121212165 命名空间（家族发布面）
  if (!LOCAL_ONLY.has(id) && !parseGitHubRepository(pkgs.repository?.url)) {
    fail.push(`SDS-3: repository.url 必须为 https://github.com/121212165/<repo>[.git]（可带 git+ 前缀）: ${pkgs.repository?.url}`);
  }

  // --- G0-5 exports target 落盘 ---
  checkExportsTargets(dir, pkgs.exports ?? {}, id, fail);

  // --- G0-6 locale 键对等 ---
  checkLocale(dir, fail, warn);

  // --- G0-7 git 仓库 ---
  checkGit(dir, id, warn, fail);

  // --- G0-9 分发完整性（dsh-plugin-hub git 通道预检，2026-10-24 起构建产物提交入库）---
  if (LOCAL_ONLY.has(id)) warn.push(`G0-9: 本地实验仓（无远端、不参与分发），分发门禁豁免`);
  else checkDistribution(dir, pkgs, fail);

  // --- G0-10 入口转发 inject（cordis 从包入口读取 inject；漏转会让宿主拒绝 ctx.commands/tools）---
  if (!isPrebuilt && existsSync(join(dir, "src", "plugin.ts")) && existsSync(join(dir, "src", "index.ts"))) {
    const pluginSrc = readFileSync(join(dir, "src", "plugin.ts"), "utf8");
    const entrySrc = readFileSync(join(dir, "src", "index.ts"), "utf8");
    if (/export const inject\s*=/.test(pluginSrc) && !/\binject\b/.test(entrySrc)) {
      fail.push(`G0-10: src/plugin.ts 声明了 inject，但 src/index.ts 未转发（宿主会以 "cannot get property ... without inject" 拒绝激活）`);
    }
  }

  return { id, fail, warn, repoUrl: pkgs.repository?.url };
}

function main() {
  const online = process.argv.includes("-r");
  const FAIL = [], WARN = [];
  const names = readdirSync(root).filter(n => n.startsWith("dsh-plugin") && existsSync(join(root, n, "package.json")) && !EXCLUDED.has(n));
  const requested = process.argv.slice(2).filter(a => a !== "-r");
  const targets = (requested.length ? requested : names.map(n => join(root, n))).filter(dir => !EXCLUDED.has(basename(dir)));
  for (const dir of targets) {
    try {
      const { id, fail, warn, repoUrl } = check(dir);
      fail.forEach(f => FAIL.push(`${id}: ${f}`));
      warn.forEach(w => WARN.push(`${id}: ${w}`));
      if (online && parseGitHubRepository(repoUrl)) checkRepoReachable(repoUrl, id, FAIL, WARN);
    } catch (e) {
      FAIL.push(`${basename(dir)}: 校验失败 — ${e.message}`);
    }
  }

  if (FAIL.length) console.log("FAIL:\n" + FAIL.map(l => "  " + l).join("\n"));
  if (WARN.length) console.log("WARN:\n" + WARN.map(l => "  " + l).join("\n"));
  if (!FAIL.length && !WARN.length) console.log("OK: all plugin specs pass");
  console.log(`\n结果: ${targets.length} 插件 / ${FAIL.length} FAIL / ${WARN.length} WARN${online ? "（联网模式）" : ""}`);
  process.exitCode = FAIL.length ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
