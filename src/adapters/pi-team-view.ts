/** Deterministic Pi team inventory and human-readable activity views. */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadPiActivePlayer } from "../core/active.js";
import { bundledPlayers, rolePlayers, scoutPlayer } from "../core/defaults.js";
import { isOwnedProfile, validatePlayer } from "../core/lifecycle.js";
import { decodePlayer, harnessSpec, isCanonicalPlayerProfile } from "../core/profiles.js";
import type { PlayerDefinition } from "../core/types.js";
import { wrapPlainLines } from "../core/text-layout.js";
import { runDeterministicCommand } from "./direct.js";
import { defaultHome } from "./shared.js";
import {
  formatElapsed,
  formatPiMissionDetails,
  formatPiRunDetails,
  formatModel,
  formatTokenCount,
  piPublicIdentifier,
  PiTeamRuntime,
  type PiTeamMemberKind,
  type PiTeamRunSnapshot,
} from "./pi-team-runtime.js";

export interface PiTeamMember {
  readonly id: string;
  readonly kind: Exclude<PiTeamMemberKind, "contractor">;
  readonly availability: "ready" | "bench" | "stale" | "conflict";
  readonly description: string;
  readonly capacity: string;
  readonly configuredModel?: string;
  readonly repairKind?: "bundled-profile" | "personal-active" | "personal-registration";
}

interface BenchRow {
  readonly id: string;
  readonly roster: "bundled" | "personal";
  readonly state: "on" | "bench" | "stale" | "conflict";
}

function parseBenchRows(output: string): BenchRow[] {
  const lines = output.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
  const rows = lines.flatMap((line) => {
    const match = /^([a-z0-9-]+) \| (bundled|personal) \| (on|bench|stale|conflict)$/u.exec(line.trim());
    return match ? [{ id: match[1], roster: match[2], state: match[3] } as BenchRow] : [];
  });
  if (rows.length !== lines.length) throw new Error("Agent Harbor bench inventory returned an unrecognized row; update or reload the extension");
  const bundled = new Set(rows.filter(({ roster }) => roster === "bundled").map(({ id }) => id));
  const missing = [...bundledPlayers.keys()].filter((id) => !bundled.has(id));
  if (missing.length) throw new Error(`Agent Harbor bench inventory is incomplete; missing bundled members: ${missing.join(", ")}`);
  return rows;
}

function capacity(definition: PlayerDefinition, id = definition.name): string {
  const capabilities = definition.tools.length ? [...definition.tools] : [id === "team-lead" ? "coordination" : "advisory"];
  for (const skill of definition.skills ?? []) capabilities.push(`skill:${skill.name}`);
  return capabilities.join(", ");
}

async function registeredPersonalDefinition(project: string, id: string): Promise<PlayerDefinition | undefined> {
  try {
    const root = resolve(project);
    const spec = harnessSpec("pi", defaultHome("pi"), root);
    const path = join(spec.home, spec.registrationDir, `${id}${spec.extension}`);
    const content = await readFile(path, "utf8");
    if (!isOwnedProfile(content, id, "personal")) return undefined;
    const definition = validatePlayer(decodePlayer(content, id));
    return isCanonicalPlayerProfile(content, "pi", definition, "personal", root) ? definition : undefined;
  } catch { return undefined; }
}

async function personalDefinition(project: string, row: BenchRow): Promise<PlayerDefinition | undefined> {
  if (row.state === "on") {
    try { return loadPiActivePlayer(project, row.id); } catch { /* Fall back to registration metadata. */ }
  }
  return registeredPersonalDefinition(project, row.id);
}

/** Resolves every Pi-visible roster class without creating an SDK session or model turn. */
export async function collectPiTeamMembers(project: string): Promise<PiTeamMember[]> {
  const raw = await runDeterministicCommand("pi", "bench", "list", project);
  const benchRows = parseBenchRows(raw);
  const members: PiTeamMember[] = [];
  for (const [id, definition] of rolePlayers) {
    members.push({
      id,
      kind: id === "team-lead" ? "manager" : "fixed",
      availability: "ready",
      description: definition.description,
      capacity: capacity(definition, id),
      ...(definition.model ? { configuredModel: definition.model } : {}),
    });
  }
  members.push({
    id: scoutPlayer.name,
    kind: "utility",
    availability: "ready",
    description: scoutPlayer.description,
    capacity: "skill discovery, recruitment",
    ...(scoutPlayer.model ? { configuredModel: scoutPlayer.model } : {}),
  });
  for (const row of benchRows.filter(({ roster }) => roster === "bundled")) {
    const definition = bundledPlayers.get(row.id);
    if (!definition) continue;
    members.push({
      id: row.id,
      kind: "bundled",
      availability: row.state === "on" ? "ready" : row.state,
      description: definition.description,
      capacity: capacity(definition),
      ...(definition.model ? { configuredModel: definition.model } : {}),
      ...(row.state === "stale" ? { repairKind: "bundled-profile" as const } : {}),
    });
  }
  for (const row of benchRows.filter(({ roster }) => roster === "personal").sort((a, b) => a.id.localeCompare(b.id))) {
    const definition = await personalDefinition(project, row);
    members.push({
      id: row.id,
      kind: "personal",
      availability: row.state === "on" ? "ready" : row.state,
      description: definition?.description ?? (row.state === "conflict" ? "Unmanaged collision; metadata unavailable" : "Managed profile needs repair"),
      capacity: definition ? capacity(definition) : "unavailable until repaired",
      ...(definition?.model ? { configuredModel: definition.model } : {}),
      ...(row.state === "stale" ? {
        repairKind: definition ? "personal-active" as const : "personal-registration" as const,
      } : {}),
    });
  }
  return members;
}

function memberMatches(member: PiTeamMember, filter: string): boolean {
  if (!filter) return true;
  return [member.id, member.kind, member.availability, member.description, member.capacity, member.configuredModel ?? ""]
    .some((value) => value.toLowerCase().includes(filter));
}

function activityMatches(run: PiTeamRunSnapshot, filter: string): boolean {
  return !filter || [run.id, run.agent, run.kind, run.state, run.task, run.thinking ?? "unknown", formatModel(run)]
    .some((value) => value.toLowerCase().includes(filter));
}

function availabilitySymbol(state: PiTeamMember["availability"]): string {
  if (state === "ready") return "●";
  if (state === "bench") return "○";
  return "!";
}

function renderActivity(runs: readonly PiTeamRunSnapshot[], hasOtherActiveWork: boolean): string[] {
  if (!runs.length) return [hasOtherActiveWork ? "No active work matches this filter." : "No one is working right now."];
  return runs.flatMap((run) => [
    `${run.parentRunId ? "↳" : "●"} ${run.agent} · run ${run.id}${run.parentRunId ? ` · parent ${run.parentRunId}` : ""} · ${run.kind} · ${run.state} · ${formatElapsed(run.elapsedMs)}`,
    "  " + `Task: “${run.task}”`,
    "  " + `${formatModel(run)} · thinking setting ${run.thinking ?? "unknown"} · model turns ${run.nativeMessages} · ${formatTokenCount(run.usage.total, run.usageLowerBounds.includes("total"))} native tokens`,
  ]);
}

function renderRoster(members: readonly PiTeamMember[], working: ReadonlySet<string>): string[] {
  return members.flatMap((member) => {
    const activity = working.has(member.id) ? "working" : member.availability;
    const repair = member.repairKind === "bundled-profile"
      ? [`  Repair: /bench on ${member.id}; then /reload.`]
      : member.repairKind === "personal-active"
        ? [`  Repair: /bench on ${member.id}; then /reload.`]
        : member.repairKind === "personal-registration"
          ? [`  Repair: re-run /join with the full definition and "replace":true; then /reload.`]
      : member.availability === "conflict"
        ? ["  Repair: inspect the unmanaged collision; Agent Harbor will not overwrite it."]
        : [];
    const description = piPublicIdentifier(member.description, 500) ?? "Description unavailable";
    const memberCapacity = piPublicIdentifier(member.capacity, 500) ?? "unavailable";
    const configuredModel = piPublicIdentifier(member.configuredModel, 200);
    return [
      `${availabilitySymbol(member.availability)} ${member.id}${member.id === scoutPlayer.name ? " (/scout)" : ""} · ${member.kind} · ${activity}`,
      `  ${description}`,
      `  Capacity: ${memberCapacity} · model: ${configuredModel ? `configured ${configuredModel}` : "inherits the Pi host when run"}`,
      ...repair,
    ];
  });
}

function renderLeadAccess(members: readonly PiTeamMember[], working: ReadonlySet<string>): string[] {
  const activeSpecialists = members.filter((member) => member.id !== "team-lead"
    && member.kind !== "manager" && member.kind !== "utility" && member.availability === "ready");
  const busy = activeSpecialists.filter((member) => working.has(member.id));
  const delegable = activeSpecialists.filter((member) => !working.has(member.id));
  const overCapacity = activeSpecialists.slice(32);
  const bundled = members.filter((member) => member.kind === "bundled");
  const benched = bundled.filter((member) => member.availability === "bench");
  const unhealthy = members.filter((member) => member.availability === "stale" || member.availability === "conflict");
  return [
    ...(overCapacity.length
      ? [
        `Lead capacity exceeded: ${activeSpecialists.length}/32 active specialists · /team-lead preflight stops at 0 model tokens.`,
        `Reduce active roster: /bench off ${overCapacity.map(({ id }) => id).join(" ")}`,
      ]
      : [
        `Lead capacity: ${activeSpecialists.length}/32`,
        `Delegable now: ${delegable.length ? delegable.map(({ id }) => id).join(", ") : "none"}`,
        ...(busy.length ? [`Busy (double-booking blocked): ${busy.map(({ id }) => id).join(", ")}`] : []),
      ]),
    `SDLC coverage: ${bundled.length - benched.length - bundled.filter((member) => member.availability === "stale" || member.availability === "conflict").length}/${bundled.length} active · ${benched.length} benched`,
    ...(benched.length ? [`Activate SDLC: /bench on ${benched.map(({ id }) => id).join(" ")}`] : []),
    ...(unhealthy.length ? [`Repair before delegation: ${unhealthy.map(({ id }) => id).join(", ")}`] : []),
  ];
}

export interface PiTeamViewOptions {
  readonly filter?: string;
  readonly title?: "team" | "bench";
  readonly nextModel?: { readonly provider: string; readonly id: string; readonly maxTokens?: number };
  readonly nextThinking?: string;
}

/** Formats roster plus live runtime data. This function performs no inference. */
export async function formatPiTeamView(
  project: string,
  runtime: PiTeamRuntime,
  options: PiTeamViewOptions = {},
): Promise<string> {
  const filter = options.filter?.trim().toLowerCase() ?? "";
  const allMembers = await collectPiTeamMembers(project);
  const unorderedActive = runtime.activeProjectRuns(project);
  const rootOrder = new Map<string, number>();
  for (const run of unorderedActive) {
    const current = rootOrder.get(run.rootRunId);
    if (current === undefined || run.sequence < current) rootOrder.set(run.rootRunId, run.sequence);
  }
  const allActive = unorderedActive.sort((a, b) =>
    rootOrder.get(a.rootRunId)! - rootOrder.get(b.rootRunId)! || a.sequence - b.sequence);
  const members = allMembers.filter((member) => memberMatches(member, filter));
  const activity = allActive.filter((run) => activityMatches(run, filter));
  const latest = runtime.latestRoot(project);
  const latestMission = !allActive.length && latest ? runtime.mission(latest.rootRunId) : [];
  const historicalMatches = latestMission.filter((run) => activityMatches(run, filter));
  if (!members.length && !activity.length && !historicalMatches.length) {
    const shown = piPublicIdentifier(options.filter?.trim(), 80) || "the requested filter";
    return wrapPlainLines([
      `Agent Harbor ${(options.title ?? "team")} · 0 model tokens`,
      `No team member or tracked activity matches “${shown}”.`,
      "Try /team, /bench list, or search by member ID, role, tool, skill, model, thinking, state, task label, or run ID.",
    ]).join("\n");
  }

  const working = new Set(allActive.filter((run) => run.kind !== "contractor").map((run) => run.agent));
  const ready = allMembers.filter((member) => member.availability === "ready" && !working.has(member.id)).length;
  const benched = allMembers.filter((member) => member.availability === "bench").length;
  const unhealthy = allMembers.filter((member) => member.availability === "stale" || member.availability === "conflict").length;
  const lines = [
    `Agent Harbor ${(options.title ?? "team")} · ${piPublicIdentifier(runtime.projectName(project), 80) ?? "project"} · 0 model tokens`,
    `${filter ? "Overall Team" : "Team"}: ${ready} ready · ${allActive.length} working · ${benched} benched · ${unhealthy} unhealthy`,
    `Next default child: ${options.nextModel ? `${piPublicIdentifier(options.nextModel.provider) ?? "unknown"}/${piPublicIdentifier(options.nextModel.id) ?? "unknown"} (inherited)` : "unknown/default (unobserved)"} · thinking setting ${piPublicIdentifier(options.nextThinking) ?? "unknown"} · model max output per response ${options.nextModel?.maxTokens === undefined ? "unknown" : `${formatTokenCount(options.nextModel.maxTokens)} tokens`}`,
    "",
    filter ? "LEAD ACCESS · OVERALL" : "LEAD ACCESS",
    ...renderLeadAccess(allMembers, working),
    "",
    "ACTIVITY",
    ...renderActivity(activity, allActive.length > 0),
    "",
    "ROSTER",
    ...(members.length ? renderRoster(members, working) : ["No roster member matches this filter."]),
  ];
  if (!allActive.length && latest && historicalMatches.length) {
    lines.push("", filter ? "LAST MISSION · MATCHING MEMBERS" : "LAST MISSION",
      ...(filter
        ? [...formatPiRunDetails(historicalMatches), "Filtered history · run /team without a filter for full mission accounting."]
        : formatPiMissionDetails(runtime, latest.rootRunId)));
  }
  lines.push("", "Commands: /team [filter] · /team stop <run-id|all> · Alt+H stop (TUI) · /bench list [filter] · /bench on <id...> · /bench off <id...> · /join <json> · /retire <id> · /scout <need> · /reload");
  return wrapPlainLines(lines).join("\n");
}
