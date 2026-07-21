/** Process-local bridge from the OpenCode config hook to the TUI roster view. */
import { resolve } from "node:path";
import { isHarborId } from "../core/identity.js";

const maximumProjects = 64;
// 200 personal roster entries plus every fixed/bundled/utility ID fit without
// truncating any alias that `/team` can display.
const maximumConflictsPerProject = 256;
const conflictsByProject = new Map<string, ReadonlySet<string>>();

function projectKey(project: string): string {
  const absolute = resolve(project);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** Replaces the bounded conflict snapshot for one loaded OpenCode project. */
export function recordOpenCodeAgentConflicts(project: string, ids: readonly string[]): void {
  const key = projectKey(project);
  conflictsByProject.delete(key);
  const bounded = new Set(ids.filter(isHarborId).slice(0, maximumConflictsPerProject));
  if (bounded.size) conflictsByProject.set(key, bounded);
  while (conflictsByProject.size > maximumProjects) {
    const oldest = conflictsByProject.keys().next().value;
    if (oldest === undefined) break;
    conflictsByProject.delete(oldest);
  }
}

/** Returns a defensive copy so TUI callers cannot mutate config-hook state. */
export function readOpenCodeAgentConflicts(project: string): ReadonlySet<string> {
  return new Set(conflictsByProject.get(projectKey(project)) ?? []);
}
