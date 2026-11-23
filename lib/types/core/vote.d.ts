export declare const DEFAULT_VOTE_REPO = "121212165/dsh-market-data";
export declare const DEFAULT_VOTE_CATEGORY = "Plugin Votes";
export declare const VOTE_MARKER_PREFIX = "<!-- dsh-market-plugin-id: ";
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
/** Read-only `gh auth status` probe. Never writes credentials. */
export declare function defaultAuthProbe(): GhAuthStatus;
/** Locate the canonical Discussion for a plugin using its stable marker. */
export declare function defaultFindDiscussion(pluginId: string, repo?: string, category?: string): VoteDiscussion | null;
/** Cast the real 👍 reaction through `gh`. */
export declare function defaultAddReaction(discussionId: string, _pluginId: string): VoteCastResult;
export declare function defaultVoteDeps(): Required<VoteDeps>;
/** Text shown when GitHub identity is missing: votes are read-only, with guidance. */
export declare function renderVoteReadOnly(pluginId: string, votes: number | undefined, authNote: string, stamp: string): string;
/** Text shown after a real vote attempt. */
export declare function renderVoteResult(pluginId: string, votes: number | undefined, result: VoteCastResult, stamp: string): string;
