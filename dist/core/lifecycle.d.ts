/**
 * Persistent roster lifecycle with ownership-aware collision handling and transactional updates.
 * Registration lives under the user's harness home while active profiles live in one project;
 * mutations coordinate both locations without overwriting or deleting unmanaged files.
 */
import type { HarnessSpec, PlayerDefinition } from "./types.js";
type BenchAction = "on" | "off";
/** Truthful filesystem outcome reported by the identity-bound lifecycle worker. */
export type LifecycleMutationStatus = "changed" | "already-current";
/** Structured join outcome for native adapters; `join()` remains the text-compatible API. */
export interface RosterJoinResult {
    readonly kind: "join";
    readonly player: string;
    readonly status: LifecycleMutationStatus;
    readonly text: string;
}
/** Structured retire outcome for native adapters; `retire()` remains the text-compatible API. */
export interface RosterRetireResult {
    readonly kind: "retire";
    readonly player: string;
    readonly status: LifecycleMutationStatus;
    readonly text: string;
}
export interface RosterBenchMutationRow {
    readonly id: string;
    readonly action: BenchAction;
    readonly status: LifecycleMutationStatus;
}
/** Structured bench outcome for native adapters; `bench()` remains the text-compatible API. */
export type RosterBenchResult = {
    readonly kind: "list";
    readonly text: string;
} | {
    readonly kind: "mutation";
    readonly status: LifecycleMutationStatus;
    readonly rows: readonly RosterBenchMutationRow[];
    readonly text: string;
};
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
    private activeTransaction?;
    private boundDirectories?;
    private bindingDirectories?;
    private lifecycleRuntime?;
    /** Binds lifecycle operations to one harness's home, project, layout, and renderer. */
    constructor(spec: HarnessSpec);
    /** Testable host boundary: packaged CLIs may not expose Node through process.execPath. */
    protected lifecycleHostExecutable(): string;
    /** Testable environment boundary; executable selection never asks a shell to resolve it. */
    protected lifecycleHostEnvironment(): NodeJS.ProcessEnv;
    /** Abortable contention wait; protected so lock/abort ordering can be tested without sleeps. */
    protected waitForMutationLock(signal?: AbortSignal): Promise<void>;
    private nodeRuntime;
    private rootFor;
    private directoryKey;
    private bindDirectory;
    private bindTarget;
    private existingBound;
    private closeBoundDirectories;
    private withMutationLock;
    /** Stages one identity-bound transaction step; protected for deterministic failure/race injection. */
    protected applyChange(change: {
        path: string;
        content?: string;
    }, _index: number): Promise<void>;
    private verifyStagedChange;
    private finalizeStagedChange;
    private rollbackStagedChange;
    private transaction;
    private paths;
    /**
     * Validates and joins a personal player by writing a portable user registration and a
     * project-bound active profile. Unmanaged collisions are never replaced. A differing owned
     * profile requires `replace: true`, and both files either verify successfully or are restored
     * to their prior exact bytes.
     */
    joinResult(input: unknown, signal?: AbortSignal): Promise<RosterJoinResult>;
    /** Text-compatible lifecycle API. Native adapters should prefer `joinResult()`. */
    join(input: unknown, signal?: AbortSignal): Promise<string>;
    private bundledBenchInventory;
    private registrationEntries;
    private personalBenchState;
    private personalBenchInventory;
    private listBench;
    private planBenchPlayer;
    /** Completes every collision/read/render preflight before returning transaction input. */
    private planBenchMutation;
    /**
     * Lists roster state or deterministically turns bundled/personal players on and off.
     * Turning a personal player off removes only its owned active copy; its registration remains the
     * source of truth. Turning it on requires a recoverable current registration.
     */
    benchResult(args: string, bundled: ReadonlyMap<string, PlayerDefinition>, signal?: AbortSignal): Promise<RosterBenchResult>;
    /** Text-compatible lifecycle API. Native adapters should prefer `benchResult()`. */
    bench(args: string, bundled: ReadonlyMap<string, PlayerDefinition>, signal?: AbortSignal): Promise<string>;
    /**
     * Removes an owned personal registration and this project's owned active copy transactionally.
     * Active copies in other projects are intentionally outside the transaction and remain untouched.
     */
    retireResult(id: string, signal?: AbortSignal): Promise<RosterRetireResult>;
    /** Text-compatible lifecycle API. Native adapters should prefer `retireResult()`. */
    retire(id: string, signal?: AbortSignal): Promise<string>;
}
export {};
