import type { GithubSkill, PlayerDefinition } from "./types.js";
export declare const legacyBundledPlayerIds: readonly ["scout", "sage", "smith", "probe", "guard", "pilot"];
export declare const bundledPlayers: Map<string, PlayerDefinition>;
export declare const trustedSkills: readonly GithubSkill[];
export declare const rolePlayers: Map<string, PlayerDefinition>;
