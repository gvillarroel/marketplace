/**
 * Canonical profile rendering, decoding, and runtime-specific least-privilege policies.
 * Revision-4 profiles carry a self-contained definition so active files can be validated without
 * trusting mutable registration state.
 */
import type { ContractDefinition, HarnessName, HarnessSpec, HarborTool, PlayerDefinition } from "./types.js";
type OpenCodePermissionAction = "allow" | "deny";
type OpenCodePermissionValue = OpenCodePermissionAction | Record<string, OpenCodePermissionAction>;
/** Rewrites occurrences of the delegated working directory to `.` in child task text. */
export declare function normalizeDelegatedTaskPaths(task: string, directory: string): string;
/** Builds OpenCode's deny-by-default external-directory exception for one working tree. */
export declare function scopedOpenCodeExternalDirectoryPolicy(directory: string): Record<string, OpenCodePermissionAction>;
/** Maps runtime-independent Harbor capabilities to the native tool names of one harness. */
export declare function nativeTools(harness: HarnessName, tools: readonly HarborTool[]): string[];
/** Builds OpenCode's boolean tool allowlist, explicitly disabling every known tool by default. */
export declare function openCodeToolPolicy(tools: readonly HarborTool[], additional?: readonly string[]): Record<string, boolean>;
/**
 * Builds OpenCode's permission policy from Harbor capabilities and invocation-scoped additions.
 * Delegation, network access, questions, and ambient skills remain denied unless an exact additional
 * tool is explicitly supplied; external filesystem access is limited to the delegated directory.
 */
export declare function openCodePermissionPolicy(tools: readonly HarborTool[], additional?: readonly string[], directory?: string): Record<string, OpenCodePermissionValue>;
/** Composes the stable identity, player prompt, efficiency rules, and skill bootstrap contract. */
export declare function composePlayerInstructions(player: PlayerDefinition, harness?: HarnessName): string;
/** Renders the complete one-shot task prompt while restating the contracted tool boundary. */
export declare function composeContractPrompt(definition: ContractDefinition, additionalTools?: readonly string[]): string;
/** Decodes a revision-4 embedded definition and verifies that it belongs to the requested player. */
export declare function decodePlayer(content: string, id: string): unknown;
/**
 * Renders the canonical revision-4 active/registration profile for a harness.
 * The ownership metadata, embedded definition, tool policy, and instructions form one executable
 * representation; discovery treats mutations to any of them as stale rather than silently trusting them.
 */
export declare function renderPlayer(harness: HarnessName, player: PlayerDefinition, roster: "personal" | "sdlc", project?: string): string;
/**
 * Tests whether an owned profile exactly matches its validated definition and current renderer.
 * Copilot skill profiles permit only a byte-verified relocation of the local MCP entrypoint.
 */
export declare function isCanonicalPlayerProfile(content: string, harness: HarnessName, player: PlayerDefinition, roster: "personal" | "sdlc", project?: string): boolean;
/** Creates the filesystem layout and bound canonical renderer for one harness/project pair. */
export declare function harnessSpec(name: HarnessName, home: string, project: string): HarnessSpec;
export {};
