/**
 * Persistent roster lifecycle with ownership-aware collision handling and transactional updates.
 * Registration lives under the user's harness home while active profiles live in one project;
 * mutations coordinate both locations without overwriting or deleting unmanaged files.
 */
import type { HarnessSpec, PlayerDefinition } from "./types.js";
/**
 * Returns whether content has a structurally valid Agent Harbor ownership marker for this player.
 * Ownership authorizes replacement or cleanup; it does not imply the profile is current or invocable.
 */
export declare function isOwnedProfile(content: string | undefined, id: string, expectedRoster?: "personal" | "sdlc"): boolean;
/**
 * Strictly validates an external player definition and returns its typed form.
 * Unknown keys, duplicate capabilities, reserved names, untrusted GitHub skills, and skill-bearing
 * definitions without read access are rejected before any filesystem mutation occurs.
 */
export declare function validatePlayer(value: unknown, allowReserved?: boolean): PlayerDefinition;
/**
 * Owns deterministic join, bench, and retire operations for one harness/project pair.
 * Every mutation is serialized by the home-scoped roster lock and committed across registration
 * and active paths as a verified transaction with best-effort full rollback.
 */
export declare class Roster {
    private readonly spec;
    /** Binds lifecycle operations to one harness's home, project, layout, and renderer. */
    constructor(spec: HarnessSpec);
    private rootFor;
    private withMutationLock;
    /** Applies one transaction step; protected to support failure injection without weakening checks. */
    protected applyChange(change: {
        path: string;
        content?: string;
    }, _index: number): Promise<void>;
    private transaction;
    private paths;
    /**
     * Validates and joins a personal player by writing identical registration and active profiles.
     * Unmanaged collisions are never replaced. A differing owned profile requires `replace: true`,
     * and both files either verify successfully or are restored to their prior exact bytes.
     */
    join(input: unknown): Promise<string>;
    /**
     * Lists roster state or deterministically turns bundled/personal players on and off.
     * Turning a personal player off removes only its owned active copy; its registration remains the
     * source of truth. Turning it on requires a recoverable revision-4 registration. Legacy bundled
     * profiles are recognized only for safe reporting and removal, never reactivation.
     */
    bench(args: string, bundled: ReadonlyMap<string, PlayerDefinition>): Promise<string>;
    /**
     * Removes an owned personal registration and this project's owned active copy transactionally.
     * Active copies in other projects are intentionally outside the transaction and remain untouched.
     */
    retire(id: string): Promise<string>;
}
