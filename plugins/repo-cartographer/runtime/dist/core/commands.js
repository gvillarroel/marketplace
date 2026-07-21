/**
 * Command parsing and dispatch for deterministic roster operations and one-shot contracts.
 * This layer contains no harness-specific rendering or lifecycle mutation logic.
 */
import { validatePlayer } from "./lifecycle.js";
import { exactCatalogSources, formatSkillCatalog } from "./catalog.js";
/** Parses and validates the single JSON object accepted by `/contract`. */
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
/**
 * Routes one validated command to its deterministic service or contract orchestrator.
 * Skill listing resolves each configured branch to immutable commit and blob identities.
 */
export async function executeCommand(name, args, context, signal) {
    switch (name) {
        case "bench": return context.roster.bench(args, context.bundled);
        case "join": return context.roster.join(JSON.parse(args));
        case "retire": return context.roster.retire(args.trim());
        case "contract": return context.orchestrator.run(parseContractDefinition(args), signal);
        case "list-skills": {
            const filter = args.trim().toLowerCase();
            const sources = context.catalogSources ?? exactCatalogSources(context.trustedSkills);
            const groups = await Promise.all(sources.map(async (source) => {
                if (context.github.listCatalog)
                    return context.github.listCatalog(source, signal);
                if (source.scope !== "skill" || !source.path || !source.name)
                    throw new Error("GitHub resolver cannot enumerate catalog scopes");
                await context.github.resolve({ kind: "github", name: source.name, repo: source.repo, path: source.path, track: source.track }, signal);
                return [{ name: source.name, repo: source.repo, path: source.path }];
            }));
            const unique = new Map();
            for (const entry of groups.flat()) {
                const identity = `${entry.repo.toLowerCase()}\0${entry.path}`;
                if (!unique.has(identity))
                    unique.set(identity, entry);
            }
            const entries = [...unique.values()].filter(({ name, repo, path }) => !filter || [name, repo, path].some((value) => value.toLowerCase().includes(filter)))
                .sort((left, right) => left.repo.localeCompare(right.repo) || left.path.localeCompare(right.path) || left.name.localeCompare(right.name));
            return formatSkillCatalog(entries, context.color);
        }
    }
}
