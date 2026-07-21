import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
/**
 * Registers Agent Harbor's command and tool surface in the active Pi host.
 * Every run is one isolated SDK child; team inspection is process-local and
 * deterministic, and never sends a prompt to a model.
 */
export default function agentHarbor(pi: ExtensionAPI): void;
