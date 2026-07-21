/** Canonical project profile layout shared by rendering and active discovery. */

import type { HarnessName } from "./types.js";

export interface HarnessProfileLayout {
  readonly activeDir: string;
  readonly extension: string;
}

const profileLayouts: Record<HarnessName, HarnessProfileLayout> = {
  copilot: { activeDir: ".github/agents", extension: ".agent.md" },
  opencode: { activeDir: ".opencode/agents", extension: ".md" },
  pi: { activeDir: ".pi/agents", extension: ".md" },
};

/** Returns the canonical active-profile directory and extension for a harness. */
export function harnessProfileLayout(harness: HarnessName): HarnessProfileLayout {
  const layout = profileLayouts[harness];
  if (!layout) throw new Error(`unsupported harness: ${String(harness)}`);
  return layout;
}
