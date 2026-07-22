const agentHarborExtensionId = "plugin:agent-foundry:agent-harbor";
const agentHarborExtensionCapabilities = [
  "register hooks",
  "skip tool permission prompts",
];

function hasExactAgentHarborCapabilities(request) {
  return Array.isArray(request.capabilities) &&
    request.capabilities.length === agentHarborExtensionCapabilities.length &&
    request.capabilities.every((capability) => typeof capability === "string") &&
    [...request.capabilities].sort().every((capability, index) =>
      capability === agentHarborExtensionCapabilities[index]);
}

/** Approves exactly one known Agent Harbor extension-capability request. */
export function createAgentHarborExtensionPermissionGate(context = "model-free operation") {
  let approvals = 0;
  const unexpectedKinds = [];
  const handler = (request) => {
    const expected = approvals === 0 &&
      request?.kind === "extension-permission-access" &&
      request.extensionName === agentHarborExtensionId &&
      request.requestSandboxBypass !== true &&
      hasExactAgentHarborCapabilities(request);
    if (expected) {
      approvals += 1;
      return { kind: "approve-once" };
    }
    unexpectedKinds.push(typeof request?.kind === "string" ? request.kind : "invalid");
    return {
      kind: "reject",
      feedback: `Agent Harbor's ${context} permits only its exact startup capability request`,
    };
  };
  const assertSatisfied = () => {
    if (approvals === 1 && unexpectedKinds.length === 0) return;
    const kinds = unexpectedKinds.length ? `; rejected: ${unexpectedKinds.join(", ")}` : "";
    throw new Error(
      `expected exactly one Agent Harbor extension permission approval; observed ${approvals}${kinds}`,
    );
  };
  return { handler, assertSatisfied };
}
