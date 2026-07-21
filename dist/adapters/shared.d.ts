import { type SkillCatalogStyle } from "../core/catalog.js";
import type { HarborContext } from "../core/commands.js";
import type { HarnessName, Orchestrator } from "../core/types.js";
/** Resolves the harness-specific user configuration root to an absolute path. */
export declare function defaultHome(harness: HarnessName): string;
/** Builds the shared command context while keeping catalog I/O lazy and the SDK orchestrator injectable. */
export declare function harborContext(harness: HarnessName, project: string, orchestrator: Orchestrator, catalogStyle?: SkillCatalogStyle): Promise<HarborContext>;
