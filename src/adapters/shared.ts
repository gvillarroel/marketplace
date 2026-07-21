/** Composition helpers used by every harness adapter. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Roster } from "../core/lifecycle.js";
import { bundledPlayers, trustedSkills } from "../core/defaults.js";
import { GhResolver } from "../core/github.js";
import { harnessSpec } from "../core/profiles.js";
import type { HarborContext } from "../core/commands.js";
import type { HarnessName, Orchestrator } from "../core/types.js";

/** Resolves the harness-specific user configuration root to an absolute path. */
export function defaultHome(harness: HarnessName): string {
  if (harness === "copilot") return resolve(process.env.COPILOT_HOME || join(homedir(), ".copilot"));
  if (harness === "opencode") return resolve(process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode"));
  return resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
}

/** Builds the shared command context while keeping the SDK orchestrator injectable. */
export function harborContext(harness: HarnessName, project: string, orchestrator: Orchestrator): HarborContext {
  return {
    roster: new Roster(harnessSpec(harness, defaultHome(harness), resolve(project))),
    bundled: bundledPlayers,
    orchestrator,
    github: new GhResolver(),
    trustedSkills,
  };
}
