import { validatePlayer } from "./lifecycle.js";
export function parseContractDefinition(args) {
    const raw = JSON.parse(args);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("expected one JSON object");
    if ("replace" in raw)
        throw new Error("contract does not accept replace");
    const { task, ...playerInput } = raw;
    if (typeof task !== "string" || !task.trim())
        throw new Error("contract requires a non-empty task");
    return { ...validatePlayer(playerInput), task };
}
export async function executeCommand(name, args, context, signal) {
    switch (name) {
        case "bench": return context.roster.bench(args, context.bundled);
        case "join": return context.roster.join(JSON.parse(args));
        case "retire": return context.roster.retire(args.trim());
        case "contract": return context.orchestrator.run(parseContractDefinition(args), signal);
        case "list-skills": {
            const filter = args.trim().toLowerCase();
            const selected = context.trustedSkills.filter((skill) => !filter || skill.name.toLowerCase().includes(filter));
            const rows = await Promise.all(selected.map(async (skill) => {
                const snapshot = await context.github.resolve(skill, signal);
                return `${skill.name} | ${skill.repo} | ${skill.path} | ${skill.track} | ${snapshot.commit} | ${snapshot.blob}`;
            }));
            return rows.join("\n");
        }
    }
}
