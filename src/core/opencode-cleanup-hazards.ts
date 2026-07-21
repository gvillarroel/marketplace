/** Fail-closed process-local record of unreconciled disposable OpenCode children. */
import { resolve } from "node:path";

const maximumTrackedProjects = 64;
const hazardousProjects = new Set<string>();
let overflowed = false;

export const openCodeCleanupHazardRecovery =
  "disposable child cleanup is unreconciled; inspect and delete the native session titled " +
  "“Agent Harbor child · provenance pending” or the signed Harbor child left behind, then reload OpenCode. " +
  "Reload only releases this safety guard; it does not delete the orphan";

function key(project: string): string {
  const absolute = resolve(project);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** Hazards intentionally persist until the OpenCode process reloads. */
export function recordOpenCodeCleanupHazard(project: string): void {
  if (overflowed) return;
  hazardousProjects.add(key(project));
  if (hazardousProjects.size > maximumTrackedProjects) {
    hazardousProjects.clear();
    overflowed = true;
  }
}

export function hasOpenCodeCleanupHazard(project: string): boolean {
  return overflowed || hazardousProjects.has(key(project));
}
