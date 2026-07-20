import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeCommand } from "../core/commands.js";
import { bundledPlayers, rolePlayers } from "../core/defaults.js";
import { isOwnedProfile, validatePlayer } from "../core/lifecycle.js";
import { decodePlayer } from "../core/profiles.js";
import { commandNames } from "../core/types.js";
import type { PlayerDefinition } from "../core/types.js";
import { PiOrchestrator } from "../orchestrators/pi.js";
import { harborContext } from "./shared.js";

const idPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;

function activeRoot(project: string): string { return resolve(project, ".pi", "agents"); }

function rejectSymlinkPath(project: string, target: string): void {
  const root = resolve(project); const rel = relative(root, resolve(target));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`unsafe path: ${target}`);
  let cursor = root;
  for (const segment of ["", ...rel.split(/[\\/]+/)]) {
    if (segment) cursor = join(cursor, segment);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`symlink traversal refused: ${cursor}`);
  }
}

function activePlayer(project: string, id: string): PlayerDefinition {
  if (!idPattern.test(id)) throw new Error(`invalid player: ${id}`);
  const path = join(activeRoot(project), `${id}.md`);
  rejectSymlinkPath(project, path);
  const content = readFileSync(path, "utf8");
  if (!isOwnedProfile(content, id)) throw new Error(`active managed player not found: ${id}`);
  return validatePlayer(decodePlayer(content, id), bundledPlayers.has(id));
}

function activeIds(project: string): string[] {
  const root = activeRoot(project);
  try {
    rejectSymlinkPath(project, root);
    const ids: string[] = [];
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0).slice(0, 200);
    for (const entry of entries) {
      const id = entry.name.slice(0, -3);
      if (!idPattern.test(id)) continue;
      try { activePlayer(project, id); ids.push(id); } catch { /* unmanaged or malformed profiles are not invocable */ }
    }
    return ids;
  } catch (error: any) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return [];
    throw error;
  }
}

export default function agentHarbor(pi: ExtensionAPI): void {
  const registered = new Set<string>();
  const runPlayer = async (player: PlayerDefinition, task: string, cwd: string): Promise<string> => {
    if (!task.trim()) throw new Error(`/${player.name} requires a non-empty task`);
    const additionalTools = player.name === "team-lead" ? ["harbor_contract"] : [];
    return new PiOrchestrator(cwd, undefined, additionalTools).run({ ...player, task });
  };
  const registerPlayer = (id: string, fixed?: PlayerDefinition): void => {
    if (registered.has(id)) return;
    pi.registerCommand(id, {
      description: fixed?.description ?? `Run active Agent Harbor player ${id}`,
      handler: async (args, ctx) => {
        try { ctx.ui.notify(await runPlayer(fixed ?? activePlayer(ctx.cwd, id), args, ctx.cwd), "info"); }
        catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
      },
    });
    registered.add(id);
  };
  const syncActivePlayers = (project: string): void => { for (const id of activeIds(project)) registerPlayer(id); };

  pi.registerTool({
    name: "harbor_contract",
    label: "Agent Harbor Contract",
    description: "Run exactly one invocation-scoped Agent Harbor child through the Pi SDK.",
    parameters: {
      type: "object",
      properties: { definition: { type: "string", description: "Complete /contract JSON object" } },
      required: ["definition"],
      additionalProperties: false,
    },
    execute: async (_id: string, params: { definition: string }, signal: AbortSignal, _update: unknown, ctx: { cwd: string }) => {
      const context = harborContext("pi", ctx.cwd, new PiOrchestrator(ctx.cwd));
      const text = await executeCommand("contract", params.definition, context, signal);
      return { content: [{ type: "text", text }], details: { harness: "pi" } };
    },
  });
  for (const name of commandNames) {
    pi.registerCommand(name, {
      description: `Agent Harbor ${name} control`,
      handler: async (args, ctx) => {
        const context = harborContext("pi", ctx.cwd, new PiOrchestrator(ctx.cwd));
        try {
          const result = await executeCommand(name, args, context);
          if (name === "join" || name === "bench") syncActivePlayers(ctx.cwd);
          ctx.ui.notify(result, "info");
        }
        catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
      },
    });
    registered.add(name);
  }
  for (const [id, player] of rolePlayers) registerPlayer(id, player);
  syncActivePlayers(process.cwd());
}
