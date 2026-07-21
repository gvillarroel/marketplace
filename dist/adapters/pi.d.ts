import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
/**
 * Registers Agent Harbor's command and tool surface in the active Pi host.
 * Active profiles are read from private Harbor storage and invoked through a
 * real in-memory child; Pi's ambient agent/skill discovery is never trusted.
 */
export default function agentHarbor(pi: ExtensionAPI): void;
