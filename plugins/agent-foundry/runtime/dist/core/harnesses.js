/** Canonical project profile layout shared by rendering and active discovery. */
const profileLayouts = {
    copilot: { activeDir: ".github/agents", extension: ".agent.md" },
    opencode: { activeDir: ".opencode/agents", extension: ".md" },
    pi: { activeDir: ".pi/agents", extension: ".md" },
};
/** Returns the canonical active-profile directory and extension for a harness. */
export function harnessProfileLayout(harness) {
    const layout = profileLayouts[harness];
    if (!layout)
        throw new Error(`unsupported harness: ${String(harness)}`);
    return layout;
}
