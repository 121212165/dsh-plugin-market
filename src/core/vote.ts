/**
 * F2 plugin-side voting (`/market vote <plugin-id>` + `market_vote` tool).
 *
 * Rules inherited from DSH-MARKET-PLAN.md §5.1 / TASK-F2:
 *   - Check GitHub identity before any write. When not logged in, show only
 *     the snapshot vote count plus an explicit `gh auth login` instruction.
 *     Never fabricate a local vote.
 *   - A real vote is a 👍 reaction on the matching Discussion
 *     (`Vote: <plugin-id>` with the stable `<!-- dsh-market-plugin-id: ... -->`
 *     marker). One person / one vote and the 30-day account-age threshold are
 *     enforced by the data-repo snapshot, not by this command.
 *
 * Every external effect is behind an injectable seam so tests are deterministic
 * and never touch GitHub or the host's `gh` configuration.
 */
import { spawnSync } from 'node:child_process';

export const DEFAULT_VOTE_REPO = '121212165/dsh-market-data';
export const DEFAULT_VOTE_CATEGORY = 'Plugin Votes';
export const VOTE_MARKER_PREFIX = '<!-- dsh-market-plugin-id: ';

export interface GhAuthStatus {
  authenticated: boolean;
  /** GitHub login when known. */
  login?: string;
  /** Human-readable reason, always safe to display. */
  note: string;
}

export interface VoteDiscussion {
  id: string;
  title: string;
  url: string;
  body: string;
}

export interface VoteCastResult {
  ok: boolean;
  message: string;
  discussionUrl?: string;
}

export interface VoteDeps {
  authProbe?: () => Promise<GhAuthStatus> | GhAuthStatus;
  findDiscussion?: (pluginId: string) => Promise<VoteDiscussion | null>;
  addReaction?: (discussionId: string, pluginId: string) => Promise<VoteCastResult>;
}

const AUTH_QUERY_TIMEOUT_MS = 5000;
const API_TIMEOUT_MS = 8000;

/** Read-only `gh auth status` probe. Never writes credentials. */
export function defaultAuthProbe(): GhAuthStatus {
  const result = spawnSync('gh', ['auth', 'status', '--hostname', 'github.com'], {
    encoding: 'utf8',
    timeout: AUTH_QUERY_TIMEOUT_MS,
    windowsHide: true,
  });
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0) {
    const login = combined.match(/Logged in as\s+([A-Za-z0-9-]+)/i)?.[1];
    return {
      authenticated: true,
      ...(login ? { login } : {}),
      note: login ? `已以 ${login} 身份登录 GitHub` : '已登录 GitHub',
    };
  }
  return {
    authenticated: false,
    note: '未检测到可用的 GitHub 身份；运行 `gh auth login` 登录后重试。当前只显示快照票数，不会在本地记假票。',
  };
}

const SEARCH_QUERY = `query($q: String!) {
  search(query: $q, type: DISCUSSION, first: 10) {
    nodes {
      ... on Discussion { id title body url }
    }
  }
}`;

const REACTION_MUTATION = `mutation($id: ID!) {
  addReaction(input: { subjectId: $id, content: THUMBS_UP }) {
    reaction { content }
    subject { id }
  }
}`;

function ghApi(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('gh', ['api', 'graphql', ...args], {
    encoding: 'utf8',
    timeout: API_TIMEOUT_MS,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Locate the canonical Discussion for a plugin using its stable marker. */
export function defaultFindDiscussion(
  pluginId: string,
  repo: string = DEFAULT_VOTE_REPO,
  category: string = DEFAULT_VOTE_CATEGORY,
): VoteDiscussion | null {
  const q = `repo:${repo} category:"${category}" "Vote: ${pluginId}" in:title`;
  const response = ghApi(['-f', `query=${SEARCH_QUERY}`, '-f', `q=${q}`]);
  const raw = response.stdout;
  let nodes: unknown[] = [];
  try {
    nodes = JSON.parse(raw)?.data?.search?.nodes ?? [];
  } catch {
    return null;
  }
  const marker = `${VOTE_MARKER_PREFIX}${pluginId} -->`;
  for (const node of nodes) {
    const candidate = node as Partial<VoteDiscussion>;
    if (typeof candidate?.id === 'string' && typeof candidate.body === 'string' && candidate.body.includes(marker)) {
      return {
        id: candidate.id,
        title: String(candidate.title ?? ''),
        url: String(candidate.url ?? ''),
        body: candidate.body,
      };
    }
  }
  return null;
}

/** Cast the real 👍 reaction through `gh`. */
export function defaultAddReaction(discussionId: string, _pluginId: string): VoteCastResult {
  const response = ghApi(['-f', `query=${REACTION_MUTATION}`, '-F', `id=${discussionId}`]);
  if (response.status !== 0) {
    return { ok: false, message: `gh api graphql 失败：${(response.stderr || response.stdout).trim().slice(0, 400)}` };
  }
  try {
    const parsed = JSON.parse(response.stdout);
    if (parsed?.errors?.length) return { ok: false, message: `GitHub 返回错误：${JSON.stringify(parsed.errors).slice(0, 400)}` };
    return { ok: true, message: '已写入 👍 reaction（一人一票由数据仓快照去重）' };
  } catch {
    return { ok: false, message: `无法解析 gh 输出：${response.stdout.trim().slice(0, 400)}` };
  }
}

export function defaultVoteDeps(): Required<VoteDeps> {
  return {
    authProbe: defaultAuthProbe,
    findDiscussion: (pluginId) => Promise.resolve(defaultFindDiscussion(pluginId)),
    addReaction: (discussionId, pluginId) => Promise.resolve(defaultAddReaction(discussionId, pluginId)),
  };
}

/** Text shown when GitHub identity is missing: votes are read-only, with guidance. */
export function renderVoteReadOnly(
  pluginId: string,
  votes: number | undefined,
  authNote: string,
  stamp: string,
): string {
  return [
    stamp,
    `插件 ${pluginId} 当前有效票：${votes ?? 0}`,
    '',
    authNote,
    '登录后可重新执行 /market vote <id> 写入 Discussion 👍 reaction。',
  ].join('\n');
}

/** Text shown after a real vote attempt. */
export function renderVoteResult(
  pluginId: string,
  votes: number | undefined,
  result: VoteCastResult,
  stamp: string,
): string {
  return [
    stamp,
    `插件 ${pluginId} 快照有效票：${votes ?? 0}（本次写入后快照需等定时任务刷新）`,
    '',
    result.message,
    ...(result.discussionUrl ? [`Discussion：${result.discussionUrl}`] : []),
  ].join('\n');
}
