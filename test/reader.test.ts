/** Pure reader tests: the four fallback tiers and the empty-data guarantee. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isHostBlocked, readMarket, type ReaderDeps } from '../src/core/index.ts';
import { freshIndex, snapshotIndex } from './helpers.ts';

function makeDeps(overrides: Partial<ReaderDeps> = {}): ReaderDeps {
  const good = JSON.stringify(freshIndex());
  return {
    fetchText: async () => good,
    readCache: async () => null,
    writeCache: async () => {},
    embedded: JSON.stringify(snapshotIndex()),
    ...overrides,
  };
}

const ALL_HOSTS = ['raw.githubusercontent.com', 'api.github.com', 'cdn.jsdelivr.net'];

/** Injected fetch that refuses configured hosts — mirrors the acceptance setup. */
function blockingFetch(blocked: string[], payload: string) {
  return async (url: string): Promise<string> => {
    if (isHostBlocked(url, blocked)) throw new Error(`network blocked: ${new URL(url).hostname}`);
    return payload;
  };
}

test('tier 1: remote index.json wins and carries 6 groups', async () => {
  const read = await readMarket(makeDeps());
  assert.equal(read.meta.layer, 'remote');
  assert.equal(read.index.groups.length, 6);
  assert.equal(read.index.plugins.length, snapshotIndex().plugins.length);
  assert.equal(read.meta.stale, false);
  assert.ok(read.meta.generatedAt);
});

test('acceptance 1: raw + api blocked still lists 6 groups via mirror', async () => {
  const read = await readMarket(makeDeps({
    fetchText: blockingFetch(['raw.githubusercontent.com', 'api.github.com'], JSON.stringify(freshIndex())),
  }));
  assert.equal(read.meta.layer, 'mirror');
  assert.equal(read.index.groups.length, 6);
  assert.ok(read.notices.some((notice) => notice.includes('remote unreachable')), read.notices.join('\n'));
});

test('acceptance 2: all network blocked + cache deleted → built-in snapshot, 6 groups', async () => {
  const read = await readMarket(makeDeps({
    fetchText: blockingFetch(ALL_HOSTS, ''),
    readCache: async () => null,
    embedded: JSON.stringify(snapshotIndex()),
  }));
  assert.equal(read.meta.layer, 'snapshot');
  assert.equal(read.index.groups.length, 6);
  assert.equal(read.meta.origin, 'built-in snapshot.json');
});

test('tier 3: cache serves 6 groups when network is fully down', async () => {
  const cached = JSON.stringify(freshIndex());
  const read = await readMarket(makeDeps({
    fetchText: blockingFetch(ALL_HOSTS, ''),
    readCache: async () => cached,
  }));
  assert.equal(read.meta.layer, 'cache');
  assert.equal(read.index.groups.length, 6);
});

test('acceptance 4: empty/broken data and empty snapshot degrade to empty market, no throw', async () => {
  for (const embedded of ['', '{}', 'not json', '{"plugins":[],"groups":[]}']) {
    const read = await readMarket(makeDeps({
      fetchText: blockingFetch(ALL_HOSTS, ''),
      readCache: async () => null,
      embedded,
    }));
    assert.ok(read.index.groups.length === 0, `expected empty groups for ${embedded}`);
    // No generatedAt means it cannot be trusted as a read contract → empty tier.
    assert.equal(read.meta.layer, 'empty');
    assert.equal(read.meta.stale, true);
  }
});

test('stamp rule: data older than 24h is marked stale with its age', async () => {
  const old = snapshotIndex();
  old.generatedAt = new Date(Date.now() - 72 * 3_600_000).toISOString();
  const read = await readMarket(makeDeps({ fetchText: async () => JSON.stringify(old) }));
  assert.equal(read.meta.stale, true);
  assert.ok(read.meta.ageHours >= 71 && read.meta.ageHours <= 73, `ageHours=${read.meta.ageHours}`);
});

test('invalid remote payload falls through to the next tier and records a notice', async () => {
  const read = await readMarket(makeDeps({ fetchText: async () => 'garbage' }));
  assert.equal(read.meta.layer, 'snapshot');
  assert.ok(read.notices.some((notice) => notice.includes('invalid data')), read.notices.join('\n'));
});

test('isHostBlocked matches exact and subdomains, ignores other hosts', () => {
  assert.equal(isHostBlocked('https://raw.githubusercontent.com/x', ['raw.githubusercontent.com']), true);
  assert.equal(isHostBlocked('https://a.api.github.com/x', ['api.github.com']), true);
  assert.equal(isHostBlocked('https://cdn.jsdelivr.net/x', ['api.github.com']), false);
});
