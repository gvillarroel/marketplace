import type { ContractDefinition, HarnessName, HarnessSpec, HarborTool, PlayerDefinition } from "./types.js";
export declare function nativeTools(harness: HarnessName, tools: readonly HarborTool[]): string[];
export declare function openCodeToolPolicy(tools: readonly HarborTool[], additional?: readonly string[]): Record<string, boolean>;
export declare function composePlayerInstructions(player: PlayerDefinition, harness?: HarnessName): string;
export declare function composeContractPrompt(definition: ContractDefinition, additionalTools?: readonly string[]): string;
export declare function decodePlayer(content: string, id: string): unknown;
export declare function renderPlayer(harness: HarnessName, player: PlayerDefinition, roster: "personal" | "sdlc"): string;
export declare function harnessSpec(name: HarnessName, home: string, project: string): HarnessSpec;
