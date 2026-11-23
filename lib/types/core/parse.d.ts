/** Parse `/market` raw input. Pure and tolerant of empty/odd input. */
export type MarketSubcommand = 'list' | 'group' | 'install' | 'uninstall' | 'verify' | 'seams' | 'doctor' | 'vote' | 'submit' | 'fuse' | 'help';
export interface MarketArgs {
    subcommand: MarketSubcommand;
    /** For `group` this is the group id; for `list` it is an optional filter. */
    target: string;
    rest: string[];
}
export declare function parseMarketArgs(rawInput: string | undefined): MarketArgs;
