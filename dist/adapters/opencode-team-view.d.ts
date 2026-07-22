import { type OpenCodeDirectAliasCollision, type OpenCodeTeamSnapshot, type OpenCodeTeamStopResult } from "./opencode-team-runtime.js";
export declare const maximumOpenCodeTeamDialogLines = 30;
/** Defensive final boundary for every OpenCode alert/error surface. */
export declare function boundOpenCodeDialogText(value: string, clippingNotice?: string): string;
/** Renders roster, active hierarchy, observed telemetry, and operational limits. */
export declare function formatOpenCodeTeamView(snapshot: OpenCodeTeamSnapshot, filterInput?: string): string;
/** Renders every current sanitized warning and a recovery action through bounded pages. */
export declare function formatOpenCodeTeamDiagnostics(snapshot: OpenCodeTeamSnapshot, requestedPage?: number): string;
/** Static help is available even when every OpenCode RPC is unavailable. */
export declare function formatOpenCodeTeamHelp(directAliasCollisions?: readonly OpenCodeDirectAliasCollision[], requestedPage?: number): string;
/** Formats a bounded stop outcome without echoing native errors or hidden session content. */
export declare function formatOpenCodeStopResult(result: OpenCodeTeamStopResult, footer?: string): string;
