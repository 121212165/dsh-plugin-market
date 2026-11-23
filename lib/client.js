window.__ModuleLoader__.load({
  id: 'dsh-plugin-market',
  factory(require) {
    /**
     * dsh-plugin-market · M3 — `conversation.view` 插件组卡片面板
     *
     * 本文件是 client 模块「工厂体」：纯 JS（扩展名沿用计划的 .tsx，但刻意不使用
     * JSX / TS 语法），由 scripts/build.mjs 原样包进 window.__ModuleLoader__.load
     * 生成 lib/client.js。单一真源，构建可复现。
     *
     * 三条红线（对应 M3 验收证据）：
     *  1. 5 张卡窄屏不溢出：grid auto-fit + minmax(min(100%, 280px), 1fr)
     *     + 每张卡 min-width:0 / box-sizing:border-box / overflow-wrap:anywhere。
     *  2. 深浅色均用 token：所有颜色值都是 var(--dsw-alias-*)，无字面色。
     *  3. 无 DOM 写到组件外：全树由 React.createElement 产出，展开用原生
     *     <details>，复制走 clipboard API；无 document.* / appendChild / innerHTML。
     */
    const React = require('react');
    const h = React.createElement;

    /** M3 面板展示的 5 张精选卡（DSH-MARKET-PLAN §4.3 前 5 行；第 6 组生态雷达在 M1 全量列表）。 */
    const FEATURED_GROUPS = [
      {
        id: 'starter-three',
        name: '开局三件套',
        oneLiner: '先看见钱，再看见所有 IDE，最后能跨窗口派活',
        members: ['dsh-plugin-quota', 'dsh-plugin-ide-hub', 'dsh-plugin-task-forge'],
        why: 'task-forge 直接读 quota 发布的 summary.json 预算契约；ide-hub 的 /today 聚合 quota / cost-ledger / task-forge / tool-trace 四家事实。',
        verify: 'dump-config 含三个 id；/qm 有输出；/ide-hub 能列出至少 1 个 IDE；/forge 只回显不落盘。',
        conflicts: [],
        curator: 'editor',
      },
      {
        id: 'archive-chain',
        name: '归档链',
        oneLiner: '一次 /archive 走完 JSONL → Obsidian → 全文检索',
        members: ['dsh-plugin-transcript', 'dsh-plugin-obsidian-push', 'dsh-plugin-transcript-search'],
        why: 'transcript 落盘 JSONL，obsidian-push 按同一契约推送，transcript-search 读同一批 JSONL 建索引——三家用一份文件协议握手。',
        verify: '落一份 transcript；/archive 全链跑通；/find 能检索到刚归档的那条。',
        conflicts: [],
        curator: 'editor',
      },
      {
        id: 'saving-combo',
        name: '省钱组合',
        oneLiner: '拦缓存、预测超额、记台账，同读一份成本事实',
        members: ['dsh-plugin-cache-guard', 'dsh-plugin-spend-forecast', 'dsh-plugin-cost-ledger'],
        why: '三家都从 session/event 的 assistant/message usage 折出 per-call token，cost-ledger 发布台账，forecast 读 history/summary.json，cache-guard 对同一用量做拦截。',
        verify: '/health 显示缓存命中；/ledger 有本月汇总；forecast.json 与台账口径一致。',
        conflicts: [],
        curator: 'editor',
      },
      {
        id: 'handoff-duo',
        name: '交接协作',
        oneLiner: '系统提示注入 + 跨窗口事实检索，换窗口不丢上下文',
        members: ['dsh-plugin-task-forge', 'dsh-plugin-pinboard', 'dsh-plugin-fact-vault'],
        why: 'task-forge 通过 systemPrompt.section 注入待编译任务，pinboard 用同一通道注入置顶事实，fact-vault 提供可检索的事实库——共享注入面而非各写各的提示。',
        verify: '/forge 生成任务书；pinboard 条目出现在系统提示；/fact find 命中刚存的事实。',
        conflicts: [],
        curator: 'editor',
      },
      {
        id: 'plugin-dev',
        name: '插件开发',
        oneLiner: '生成骨架 → 优化提示 → 渲染工具卡，闭环过质量门',
        members: ['dsh-plugin-plugin-forge', 'dsh-plugin-prompt-optimize', 'dsh-plugin-family-cards'],
        why: 'forgeFiles() 生成 10 文件骨架，prompt-optimize 打磨工具描述，family-cards 在 tool.call.toolview 按工具名渲染卡片；产物统一过 verify-plugin。',
        verify: 'forge 产物过 verify-plugin；/opt 能改写提示；调用新工具时 family-cards 出卡。',
        conflicts: [],
        curator: 'editor',
      },
    ];

    /** 内置快照时间：无宿主数据时也要带 generatedAt，绝不冒充实时（计划 §5.1）。 */
    const FALLBACK_STAMP = '2026-11-21T00:00:00.000Z';
    const DAY_MS = 24 * 60 * 60 * 1000;

    /** 宿主可用时读 ctx.market.groups（M1 三层读兜底的产物），否则用内置快照。 */
    let runtimeCtx = null;

    function normalize(g) {
      return {
        id: String(g.id || ''),
        name: String(g.name || g.id || '未命名'),
        oneLiner: String(g.oneLiner || ''),
        members: Array.isArray(g.members) ? g.members.map(String) : [],
        why: String(g.why || ''),
        verify: Array.isArray(g.verify) ? g.verify.join('；') : String(g.verify || ''),
        conflicts: Array.isArray(g.conflicts) ? g.conflicts.map(String) : [],
        curator: String(g.curator || 'editor'),
      };
    }

    /** 宿主未必在 client 上下文注入 market；用 reflect 安全读取，未注入时回退内置快照。 */
    function readMarket(ctx) {
      try {
        if (!ctx) return null;
        if (ctx.reflect && typeof ctx.reflect.get === 'function') return ctx.reflect.get('market') || null;
        return ctx.market || null;
      } catch (_) {
        return null;
      }
    }

    function getGroups() {
      const market = readMarket(runtimeCtx);
      if (market && Array.isArray(market.groups) && market.groups.length > 0) {
        return market.groups.slice(0, 5).map(normalize);
      }
      return FEATURED_GROUPS;
    }

    function stampText(ctx) {
      const market = readMarket(ctx);
      const iso = market && market.generatedAt ? market.generatedAt : FALLBACK_STAMP;
      const at = Date.parse(iso);
      if (!Number.isFinite(at)) return '数据时间未知';
      const now = market && market.now ? market.now : Date.now();
      const stale = Number.isFinite(now) && now - at > DAY_MS;
      return '数据 ' + new Date(at).toISOString().slice(0, 10) + (stale ? ' · 快照' : '');
    }

    /** 只调浏览器 API，不碰 DOM；失败静默，不影响卡片渲染。 */
    function copyText(text) {
      return function onClick() {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            const p = navigator.clipboard.writeText(text);
            if (p && typeof p.catch === 'function') p.catch(function () {});
          }
        } catch (_) {
          /* 无剪贴板权限时保留可选中文本即可 */
        }
      };
    }

    /** 全部颜色走 --dsw-alias-* 语义 token；宿主按深浅主题各自解析。 */
    const S = {
      root: {
        boxSizing: 'border-box', width: '100%', maxWidth: '100%',
        padding: 'clamp(8px, 2vw, 16px)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit', fontSize: '13px', lineHeight: 1.55,
      },
      header: {
        display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 12px',
        minWidth: 0, marginBottom: 'clamp(8px, 1.5vw, 14px)',
      },
      title: { margin: 0, fontSize: '14px', fontWeight: 600, letterSpacing: '0.2px', color: 'var(--dsw-alias-label-primary)' },
      stamp: { marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', whiteSpace: 'nowrap' },
      grid: {
        boxSizing: 'border-box', display: 'grid', width: '100%', maxWidth: '100%',
        /* 窄屏关键：min() 让最小轨道永不宽于容器，auto-fit 自然降为单列 */
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
        gap: 'clamp(8px, 1.5vw, 14px)',
      },
      card: {
        boxSizing: 'border-box', minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere',
        display: 'flex', flexDirection: 'column', gap: '8px',
        padding: 'clamp(10px, 1.5vw, 14px)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '10px',
      },
      cardHead: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 8px', minWidth: 0 },
      name: { minWidth: 0, overflowWrap: 'anywhere', fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      badge: {
        marginLeft: 'auto', padding: '1px 7px', borderRadius: '999px', whiteSpace: 'nowrap',
        border: '1px solid var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary)', fontSize: '10px',
      },
      oneLiner: { margin: 0, overflowWrap: 'anywhere', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      chips: { display: 'flex', flexWrap: 'wrap', gap: '4px', minWidth: 0 },
      chip: {
        maxWidth: '100%', overflowWrap: 'anywhere', padding: '1px 6px', borderRadius: '5px',
        border: '1px solid var(--dsw-alias-border-l3)',
        color: 'var(--dsw-alias-label-secondary)', fontSize: '10px',
      },
      status: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, overflowWrap: 'anywhere', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      dotOk: { width: '6px', height: '6px', borderRadius: '50%', flex: '0 0 auto', background: 'var(--dsw-alias-state-success-primary)' },
      dotWarn: { width: '6px', height: '6px', borderRadius: '50%', flex: '0 0 auto', background: 'var(--dsw-alias-state-warn-primary)' },
      details: { minWidth: 0, borderTop: '1px solid var(--dsw-alias-border-l3)', paddingTop: '6px' },
      summary: { cursor: 'pointer', overflowWrap: 'anywhere', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      detailBody: { paddingTop: '4px', overflowWrap: 'anywhere', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      cmd: {
        display: 'block', minWidth: 0, padding: '6px 8px', borderRadius: '6px',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '11px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
      },
      btn: {
        alignSelf: 'flex-start', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-label-primary-foreground)', fontSize: '11px',
      },
    };

    function Card(props) {
      const g = props.group;
      const conflicted = g.conflicts.length > 0;
      const cmd = '/market install ' + g.id;
      return h('article', { 'data-market-card': g.id, style: S.card },
        h('div', { style: S.cardHead },
          h('span', { style: S.name }, g.name),
          h('span', { style: S.badge }, g.curator === 'editor' ? '编辑精选' : '社区投稿')),
        h('p', { style: S.oneLiner }, g.oneLiner),
        h('div', { style: S.chips }, ...g.members.map(function (m) {
          return h('span', { style: S.chip, key: m }, m.replace(/^dsh-plugin-/, ''));
        })),
        h('div', { style: S.status },
          h('span', { style: conflicted ? S.dotWarn : S.dotOk }),
          conflicted ? ('冲突：' + g.conflicts.join(' / ')) : '冲突预检：无'),
        h('details', { style: S.details },
          h('summary', { style: S.summary }, '真实协同点 · why'),
          h('div', { style: S.detailBody }, g.why || '（缺 why，按红线不得上首页）')),
        h('details', { style: S.details },
          h('summary', { style: S.summary }, '可执行验收 · verify'),
          h('div', { style: S.detailBody }, g.verify || '（缺 verify，按红线不得上首页）')),
        h('code', { style: S.cmd }, cmd),
        h('button', { style: S.btn, type: 'button', onClick: copyText(cmd) }, '复制安装命令'));
    }

    function MarketPanel() {
      return h('section', { 'data-market-panel': '', style: S.root },
        h('header', { style: S.header },
          h('h2', { style: S.title }, '插件市集 · 精选插件组'),
          h('span', { style: S.stamp }, stampText(runtimeCtx))),
        h('div', { style: S.grid }, ...getGroups().map(function (g) {
          return h(Card, { key: g.id, group: g });
        })));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        runtimeCtx = ctx || {};
        ctx.slots.inject('conversation.view', function () {
          return ctx.slots.register({
            name: 'conversation.view',
            id: 'dsh-market-groups',
            order: 50,
          }, MarketPanel);
        });
      },
    };

  },
});
