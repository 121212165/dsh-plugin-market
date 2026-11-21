/** Renderer tests: snapshot time visible, group detail complete, empty safe. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderGroup, renderList, renderStamp, type MarketRead, type SnapshotMeta } from '../src/core/index.ts';
import { emptyIndex, freshIndex, snapshotIndex } from './helpers.ts';

function read(index = freshIndex(), meta?: Partial<SnapshotMeta>): MarketRead {
  const full: SnapshotMeta = {
    generatedAt: index.generatedAt,
    layer: 'remote',
    stale: false,
    ageHours: 0.2,
    origin: 'https://raw.githubusercontent.com/.../index.json',
    ...meta,
  };
  return { index, meta: full, notices: [] };
}

test('renderList shows snapshot time and all 6 groups', () => {
  const text = renderList(read());
  assert.ok(text.includes('数据 实时'), text);
  assert.ok(text.includes('2026-') || /\d{4}-\d{2}-\d{2}/.test(text));
  assert.equal((text.match(/• /g) ?? []).length, 6);
  assert.ok(text.includes('开局三件套'));
  assert.ok(text.includes('编辑精选'));
  assert.ok(text.includes('/market group <id>'));
});

test('renderList marks a stale snapshot explicitly', () => {
  const text = renderList(read(freshIndex(), { layer: 'snapshot', stale: true, ageHours: 72, origin: 'built-in snapshot.json' }));
  assert.ok(text.includes('数据 快照'), text);
  assert.ok(text.includes('72h 前'), text);
  assert.ok(text.includes('built-in snapshot.json'), text);
});

test('renderGroup shows members, real contracts and executable verify steps', () => {
  const text = renderGroup(read(snapshotIndex()), 'starter-three');
  assert.ok(text.includes('开局三件套'));
  assert.ok(text.includes('用量仪表'));
  assert.ok(text.includes('summary.json'), 'must cite the real handshake field');
  assert.ok(text.includes('/qm 有输出'), 'must include the executable verify step');
  assert.ok(text.includes('/market install starter-three'));
});

test('renderGroup on unknown id lists available ids instead of crashing', () => {
  const text = renderGroup(read(snapshotIndex()), 'does-not-exist');
  assert.ok(text.includes('找不到组'));
  assert.ok(text.includes('starter-three'));
  assert.ok(text.includes('eco-radar'));
});

test('empty data renders a friendly message in both views', () => {
  const list = renderList(read(emptyIndex(), { layer: 'empty', stale: true, ageHours: -1, origin: 'none' }));
  assert.ok(list.includes('暂无可展示的插件组'), list);
  const detail = renderGroup(read(emptyIndex(), { layer: 'empty', stale: true, ageHours: -1, origin: 'none' }), 'x');
  assert.ok(detail.includes('暂无插件组数据'), detail);
  assert.ok(renderStamp(read(emptyIndex()).meta).includes('未知'));
});
