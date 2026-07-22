/** Zero-model adapter shared by CLI and native deterministic controls. */
import { type HarborCommandResult } from "../core/commands.js";
import type { SkillCatalogStyle } from "../core/catalog.js";
import type { DeterministicCommandName, HarnessName } from "../core/types.js";
/**
 * Executes a lifecycle control without creating a model session or child.
 * The injected orchestrator is a tripwire: deterministic commands must never
 * cross the inference boundary, even if command routing regresses.
 */
export declare function runDeterministicCommand(harness: HarnessName, command: DeterministicCommandName, args: string, project?: string, signal?: AbortSignal, catalogStyle?: SkillCatalogStyle): Promise<string>;
/** Executes a deterministic control while preserving structured lifecycle mutation truth. */
export declare function runDeterministicCommandResult(harness: HarnessName, command: DeterministicCommandName, args: string, project?: string, signal?: AbortSignal, catalogStyle?: SkillCatalogStyle): Promise<HarborCommandResult>;
