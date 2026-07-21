/** Composition helpers used by every harness adapter. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Roster } from "../core/lifecycle.js";
import { loadSkillCatalogSources } from "../core/catalog.js";
import { bundledPlayers, skillCatalogSources, trustedSkills } from "../core/defaults.js";
import { GhResolver } from "../core/github.js";
import { harnessSpec } from "../core/profiles.js";
/** Resolves the harness-specific user configuration root to an absolute path. */
export function defaultHome(harness) {
    if (harness === "copilot")
        return resolve(process.env.COPILOT_HOME || join(homedir(), ".copilot"));
    if (harness === "opencode")
        return resolve(process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode"));
    return resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
}
/** Builds the shared command context while keeping catalog I/O lazy and the SDK orchestrator injectable. */
export async function harborContext(harness, project, orchestrator, catalogStyle = "plain") {
    const absoluteProject = resolve(project);
    return {
        roster: new Roster(harnessSpec(harness, defaultHome(harness), absoluteProject)),
        bundled: bundledPlayers,
        orchestrator,
        github: new GhResolver(),
        trustedSkills,
        loadCatalogSources: () => loadSkillCatalogSources(absoluteProject, skillCatalogSources),
        catalogStyle,
    };
}
