import type { HarborContext } from "../core/commands.js";
import type { HarnessName, Orchestrator } from "../core/types.js";
export declare function defaultHome(harness: HarnessName): string;
export declare function harborContext(harness: HarnessName, project: string, orchestrator: Orchestrator): HarborContext;
