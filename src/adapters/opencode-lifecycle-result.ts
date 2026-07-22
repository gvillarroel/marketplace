/** Fail-closed verification of structured lifecycle truth before OpenCode presents mutation success. */
import type { HarborCommandResult } from "../core/commands.js";
import { bundledPlayers } from "../core/defaults.js";
import { isHarborId } from "../core/identity.js";
import { validatePlayer } from "../core/lifecycle.js";
import type { CommandName } from "../core/types.js";

function expectedBenchMutation(args: string): {
  readonly action: "on" | "off";
  readonly ids: readonly string[];
} | undefined {
  const match = /^(on|off)\s+(.+)$/u.exec(args.trim());
  if (!match) return undefined;
  const requested = match[2].split(/[\s,]+/u).filter(Boolean);
  const ids = requested.length === 1 && requested[0] === "all"
    ? [...bundledPlayers.keys()]
    : [...new Set(requested)];
  return ids.length && ids.every(isHarborId)
    ? { action: match[1] as "on" | "off", ids }
    : undefined;
}

/** Throws unless a mutating join/bench result proves the exact requested lifecycle outcome. */
export function assertOpenCodeLifecycleMutationTruth(
  command: CommandName,
  args: string,
  result: HarborCommandResult,
): void {
  if (command === "retire") {
    const player = args.trim();
    const lifecycle = result.lifecycle;
    if (!isHarborId(player) || lifecycle?.command !== "retire" || lifecycle.player !== player ||
        !["changed", "already-current"].includes(lifecycle.status)) {
      throw new Error("OpenCode retire completed without matching structured lifecycle mutation truth");
    }
    return;
  }
  if (command === "join") {
    const player = validatePlayer(JSON.parse(args));
    const lifecycle = result.lifecycle;
    if (lifecycle?.command !== "join" || lifecycle.player !== player.name ||
        !["changed", "already-current"].includes(lifecycle.status)) {
      throw new Error("OpenCode join completed without matching structured lifecycle mutation truth");
    }
    return;
  }
  if (command !== "bench") return;
  const expected = expectedBenchMutation(args);
  // `bench`, `bench list`, and `bench list <filter>` are read-only and
  // intentionally have no lifecycle outcome.
  if (!expected) {
    if (!args.trim() || args.trim() === "list" || args.trim().startsWith("list ")) return;
    throw new Error("OpenCode bench completed without a verifiable mutation request");
  }
  const lifecycle = result.lifecycle;
  if (lifecycle?.command !== "bench" || lifecycle.rows.length !== expected.ids.length ||
      lifecycle.rows.some((row, index) => row.id !== expected.ids[index] || row.action !== expected.action ||
        !["changed", "already-current"].includes(row.status))) {
    throw new Error("OpenCode bench completed without matching structured lifecycle mutation truth");
  }
  const aggregate = lifecycle.rows.some(({ status }) => status === "changed")
    ? "changed"
    : "already-current";
  if (lifecycle.status !== aggregate) {
    throw new Error("OpenCode bench returned inconsistent aggregate lifecycle mutation truth");
  }
}
