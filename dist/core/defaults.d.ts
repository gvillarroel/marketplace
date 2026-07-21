/**
 * Built-in SDLC players, fixed coordination roles, and trusted remote skill references.
 * These definitions are policy-bearing defaults consumed by every harness renderer.
 */
import type { GithubSkill, PlayerDefinition } from "./types.js";
/** Retired bundled identifiers retained solely for safe discovery and cleanup. */
export declare const legacyBundledPlayerIds: readonly ["scout", "sage", "smith", "probe", "guard", "pilot"];
/** Ordered lifecycle peers that users can deterministically place on or off the active roster. */
export declare const bundledPlayers: Map<string, PlayerDefinition>;
/** Exact GitHub skill references permitted in player definitions; branch heads are pinned when loaded. */
export declare const trustedSkills: readonly GithubSkill[];
/** Fixed, always-invocable roles supplied by Agent Harbor rather than project profile files. */
export declare const rolePlayers: Map<string, PlayerDefinition>;
