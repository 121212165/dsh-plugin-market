/**
 * M3 验收测试：不依赖浏览器与 dsh 运行时，直接执行真实 lib/client.js。
 * 覆盖：5 卡数量、窄屏不溢出的样式守卫、token-only 颜色、无组件外 DOM 写、
 * 快照时间标注、slot 注册契约、构建产物与源同步。
 *
 * 运行：node --test test/client.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src', 'client.tsx'), 'utf8');
const built = readFileSync(join(root, 'lib', 'client.js'), 'utf8');

/** 极简 createElement：产出可遍历的纯对象树，等价于 React 元素的 type/props/children。 */
function h(type, props, ...children) {
  const nextProps = { ...(props || {}), children: children.flat() };
  // 函数组件就地展开（React 的等价行为），否则 <Card/> 永远只是一层壳。
  if (typeof type === 'function') return type(nextProps);
  return { type, props: nextProps };
}

function loadBuilt() {
  let loaded;
  // 真实产物就是一段脚本：用 Function 执行它，语法错会当场抛出。
  new Function('window', built)({
    __ModuleLoader__: { load: (m) => { loaded = m; } },
  });
  assert.ok(loaded && typeof loaded.factory === 'function', 'ModuleLoader.load 必须被调用');
  return loaded.factory(() => ({ createElement: h }));
}

function mount(market) {
  const captured = {};
  const ctx = {
    market,
    slots: {
      inject(name, factory) {
        captured.slot = name;
        captured.component = factory();
        return captured.component;
      },
      register(meta, component) {
        captured.meta = meta;
        return component;
      },
    },
  };
  const mod = loadBuilt();
  assert.equal(mod.inject[0], 'slots');
  mod.apply(ctx);
  assert.equal(captured.slot, 'conversation.view');
  assert.equal(captured.meta.name, 'conversation.view');
  assert.equal(captured.meta.id, 'dsh-market-groups');
  return { tree: captured.component(), captured };
}

function walk(node, out = []) {
  if (node == null || typeof node !== 'object') return out;
  out.push(node);
  for (const child of node.props?.children || []) walk(child, out);
  return out;
}

function allText(nodes) {
  let out = '';
  const visit = (n) => {
    if (typeof n === 'string') { out += n + ' '; return; }
    if (!n || typeof n !== 'object') return;
    for (const c of n.props?.children || []) visit(c);
  };
  for (const n of nodes) visit(n);
  return out;
}
const FRESH = '2026-11-21T12:00:00.000Z';

test('构建产物与源同步：源内容逐字出现在 lib/client.js', () => {
  for (const line of src.split('\n')) {
    if (line.trim()) assert.ok(built.includes(line), '产物缺失源行：' + line.slice(0, 60));
  }
});

test('加载 + 装配：注册到 conversation.view，渲染出 5 张卡', () => {
  const { tree } = mount({ generatedAt: FRESH, now: Date.parse(FRESH) });
  const nodes = walk(tree);
  const cards = nodes.filter((n) => n.props?.['data-market-card']);
  assert.equal(cards.length, 5, 'M3 验收要求 5 张组卡片');
  assert.equal(nodes.filter((n) => n.props?.['data-market-panel'] !== undefined).length, 1);
  assert.deepEqual(cards.map((c) => c.props['data-market-card']), [
    'starter-three', 'archive-chain', 'saving-combo', 'handoff-duo', 'plugin-dev',
  ]);
});

test('窄屏不溢出守卫：grid 用 min() 轨道，卡片 min-width:0 + border-box + anywhere', () => {
  const { tree } = mount({ generatedAt: FRESH, now: Date.parse(FRESH) });
  const nodes = walk(tree);
  const grid = nodes.find((n) => n.props?.style?.gridTemplateColumns);
  assert.match(grid.props.style.gridTemplateColumns, /minmax\(min\(100%,\s*\d+px\),\s*1fr\)/);
  assert.equal(grid.props.style.boxSizing, 'border-box');
  assert.equal(grid.props.style.width, '100%');
  assert.equal(grid.props.style.maxWidth, '100%');

  const cards = nodes.filter((n) => n.props?.['data-market-card']);
  for (const c of cards) {
    assert.equal(c.props.style.minWidth, 0);
    assert.equal(c.props.style.boxSizing, 'border-box');
    assert.equal(c.props.style.maxWidth, '100%');
    assert.equal(c.props.style.overflowWrap, 'anywhere');
  }
});

const ALLOWED_TOKENS = new Set([
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1',
  '--dsw-alias-border-l2', '--dsw-alias-border-l3',
  '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
  '--dsw-alias-label-primary-foreground', '--dsw-alias-brand-primary',
  '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary',
]);

test('深浅色同一个实现：所有颜色都是 --dsw-alias-* token，无字面色', () => {
  const { tree } = mount({ generatedAt: FRESH, now: Date.parse(FRESH) });
  const nodes = walk(tree);
  let colorCount = 0;
  for (const n of nodes) {
    for (const [key, value] of Object.entries(n.props?.style || {})) {
      if (typeof value !== 'string') continue;
      const vars = value.match(/var\((--[\w-]+)\)/g) || [];
      for (const v of vars) {
        const name = v.slice(4, -1);
        assert.ok(ALLOWED_TOKENS.has(name), '未知 token：' + name);
      }
      if (/^(color|background|border|borderTop|borderBottom)$/.test(key) || /color/i.test(key)) {
        colorCount++;
        assert.match(value, /var\(--dsw-alias-/, key + ' 未用 token：' + value);
        assert.doesNotMatch(value, /#[0-9a-fA-F]{3,8}|\brgba?\(|\bhsla?\(|\b(?:white|black|red|green|blue|gray|grey)\b/);
      }
    }
    assert.equal(n.props?.dangerouslySetInnerHTML, undefined, '禁止 dangerouslySetInnerHTML');
  }
  assert.ok(colorCount >= 15, '颜色样式数量异常：' + colorCount);
});

test('无 DOM 写到组件外：源码不出现 document / 原生 DOM 增改 API', () => {
  // 注释里会提到这些词（说明红线），只扫真实代码。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const forbidden = [
    /\bdocument\./, /\bappendChild\s*\(/, /\binsertBefore\s*\(/,
    /\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\s*\(/,
    /\bcreateElementNS\s*\(/, /\bsetAttribute\s*\(/, /\bremoveChild\s*\(/,
  ];
  for (const re of forbidden) {
    assert.doesNotMatch(code, re, '源码命中组件外 DOM 写：' + re);
  }
  // 允许的唯一 DOM API 是剪贴板；展开用原生 <details>，不引入任何副作用。
  assert.match(src, /navigator\.clipboard\.writeText/);
  assert.match(src, /h\('details'/);
});

test('数据新鲜度：超过 24h 标「快照」，新鲜数据不标', () => {
  const oldAt = '2026-11-18T00:00:00.000Z';
  const staleText = allText(walk(mount({ generatedAt: oldAt, now: Date.parse(FRESH) }).tree));
  assert.match(staleText, /快照/);
  const freshText = allText(walk(mount({ generatedAt: FRESH, now: Date.parse(FRESH) }).tree));
  assert.doesNotMatch(freshText, /快照/);
});

test('宿主数据接入：ctx.market.groups 覆盖内置快照，仍只取前 5 张', () => {
  const six = Array.from({ length: 6 }, (_, i) => ({
    id: 'g' + i, name: '组' + i, members: ['dsh-plugin-x'], why: 'w', verify: 'v',
  }));
  const { tree } = mount({ generatedAt: FRESH, now: Date.parse(FRESH), groups: six });
  const cards = walk(tree).filter((n) => n.props?.['data-market-card']);
  assert.deepEqual(cards.map((c) => c.props['data-market-card']), ['g0', 'g1', 'g2', 'g3', 'g4']);
});
