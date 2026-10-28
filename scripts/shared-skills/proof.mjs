export function verifyProof(client, invocation, expected) {
  const normalize = value => String(value || '').replaceAll('\\', '/').replace(/\/+/g, '/');
  const belongs = value => {
    const text = normalize(value);
    return text.includes(`/${invocation.plugin}/`) && text.includes(`/${invocation.skill}/`);
  };
  let skillLoaded = false, referenceRead = false;
  if (client === 'copilot') {
    skillLoaded = invocation.trace.some(event => event.type === 'tool.execution_complete'
      && event.data?.success === true
      && event.data?.toolTelemetry?.restrictedProperties?.skillName?.split(':').at(-1) === invocation.skill
      && event.data?.toolTelemetry?.restrictedProperties?.pluginName === invocation.plugin);
    referenceRead = invocation.trace.some(event => event.type === 'tool.execution_start'
      && event.data?.toolName === 'view' && belongs(event.data.arguments?.path)
      && normalize(event.data.arguments.path).endsWith('/references/proof.txt')
      && invocation.trace.some(completed => completed.type === 'tool.execution_complete'
        && completed.data?.toolCallId === event.data.toolCallId && completed.data?.success === true
        && completed.data?.result?.content?.trim() === expected));
  } else if (client === 'codex') {
    const commands = invocation.trace.filter(event => event.type === 'item.completed'
      && event.item?.type === 'command_execution' && event.item.exit_code === 0)
      .map(event => event.item.command).filter(belongs);
    skillLoaded = commands.some(command => normalize(command).includes(`/${invocation.skill}/SKILL.md`));
    referenceRead = commands.some(command => normalize(command).includes(`/${invocation.skill}/references/proof.txt`));
  }
  return { skillLoaded, referenceRead, exactToken: invocation.status === 0 && invocation.final?.trim() === expected,
    passed: skillLoaded && referenceRead && invocation.status === 0 && invocation.final?.trim() === expected };
}
