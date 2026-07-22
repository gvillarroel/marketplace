import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type HarborLifecycleOutcome } from "../core/commands.js";
type BenchLifecycleOutcome = Extract<HarborLifecycleOutcome, {
    readonly command: "bench";
}>;
type JoinLifecycleOutcome = Extract<HarborLifecycleOutcome, {
    readonly command: "join";
}>;
type RetireLifecycleOutcome = Extract<HarborLifecycleOutcome, {
    readonly command: "retire";
}>;
/** Fails closed before Pi refreshes or presents an unverified join result. */
export declare function requirePiJoinLifecycleOutcome(args: string, lifecycle: HarborLifecycleOutcome | undefined): JoinLifecycleOutcome;
/** Fails closed before Pi refreshes or presents an unverified retire result. */
export declare function requirePiRetireLifecycleOutcome(args: string, lifecycle: HarborLifecycleOutcome | undefined): RetireLifecycleOutcome;
/** Fails closed before Pi refreshes or presents an unverified bench mutation. */
export declare function requirePiBenchLifecycleOutcome(args: string, lifecycle: HarborLifecycleOutcome | undefined): BenchLifecycleOutcome;
/**
 * Registers Agent Harbor's command and tool surface in the active Pi host.
 * Every run is one isolated SDK child. Persistent-player admission/activity
 * is project-shared; anonymous contractor telemetry remains process-local.
 */
export default function agentHarbor(pi: ExtensionAPI): void;
export {};
