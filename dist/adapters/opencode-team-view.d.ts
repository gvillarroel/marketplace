import { type OpenCodeTeamSnapshot, type OpenCodeTeamStopResult } from "./opencode-team-runtime.js";
export declare const maximumOpenCodeTeamDialogLines = 30;
/** Renders roster, active hierarchy, observed telemetry, and operational limits. */
export declare function formatOpenCodeTeamView(snapshot: OpenCodeTeamSnapshot, filterInput?: string): string;
/** Static help is available even when every OpenCode RPC is unavailable. */
export declare function formatOpenCodeTeamHelp(): string;
/** Formats a bounded stop outcome without echoing native errors or hidden session content. */
export declare function formatOpenCodeStopResult(result: OpenCodeTeamStopResult): string;
