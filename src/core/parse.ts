/** Parse `/market` raw input. Pure and tolerant of empty/odd input. */
export type MarketSubcommand = 'list' | 'group' | 'install' | 'uninstall' | 'verify' | 'seams' | 'doctor' | 'vote' | 'submit' | 'fuse' | 'help';

export interface MarketArgs {
  subcommand: MarketSubcommand;
  /** For `group` this is the group id; for `list` it is an optional filter. */
  target: string;
  rest: string[];
}

const KNOWN = new Set<MarketSubcommand>(['list', 'group', 'install', 'uninstall', 'verify', 'seams', 'doctor', 'vote', 'submit', 'fuse', 'help']);

export function parseMarketArgs(rawInput: string | undefined): MarketArgs {
  const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { subcommand: 'list', target: '', rest: [] };
  const [head, ...tail] = tokens as [string, ...string[]];
  if (KNOWN.has(head as MarketSubcommand)) {
    return { subcommand: head as MarketSubcommand, target: tail[0] ?? '', rest: tail.slice(1) };
  }
  // Unknown first token: treat it as a shortcut/filter on the list view.
  return { subcommand: 'list', target: head, rest: tail };
}
