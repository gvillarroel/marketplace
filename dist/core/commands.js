/**
 * Command parsing and dispatch for deterministic roster operations and one-shot contracts.
 * This layer contains no harness-specific rendering or lifecycle mutation logic.
 */
import { validatePlayer } from "./lifecycle.js";
import { exactCatalogSources, formatSkillCatalog } from "./catalog.js";
// Description lookup may require one authenticated GitHub request per row. Keep
// the work bounded, while still allowing large catalogs to be narrowed using
// metadata that was already returned by catalog enumeration.
const maximumDescribedCatalogEntries = 64;
function catalogEntryMatches(entry, filter, includeDescription) {
    if (!filter)
        return true;
    const values = [entry.name, entry.repo, entry.path];
    if (includeDescription)
        values.push(entry.description ?? "");
    return values.some((value) => value.toLowerCase().includes(filter));
}
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
            const tokens = args.trim() ? args.trim().split(/\s+/u) : [];
            const descriptions = tokens.some((token) => token === "--descriptions" || token === "-d");
            if (tokens.some((token) => token.startsWith("-") && token !== "--descriptions" && token !== "-d")) {
                throw new Error("usage: /list-skills [--descriptions|-d] [filter]");
            }
            const filter = tokens.filter((token) => token !== "--descriptions" && token !== "-d").join(" ").toLowerCase();
            const loadedSources = context.catalogSources ?? await context.loadCatalogSources?.();
            const sources = loadedSources ?? exactCatalogSources(context.trustedSkills);
            const groups = await Promise.all(sources.map(async (source) => {
                if (context.github.listCatalog)
                    return context.github.listCatalog(source, signal);
                if (source.scope !== "skill" || !source.path || !source.name)
                    throw new Error("GitHub resolver cannot enumerate catalog scopes");
                await context.github.resolve({ kind: "github", name: source.name, repo: source.repo, path: source.path, track: source.track }, signal);
                return [{ name: source.name, repo: source.repo, path: source.path, track: source.track }];
            }));
            const unique = new Map();
            for (const entry of groups.flat()) {
                const identity = `${entry.repo.toLowerCase()}\0${entry.path}`;
                if (!unique.has(identity))
                    unique.set(identity, entry);
            }
            let entries = [...unique.values()];
            if (descriptions) {
                if (!context.github.describeCatalog)
                    throw new Error("GitHub resolver cannot load catalog descriptions");
                if (entries.length > maximumDescribedCatalogEntries) {
                    if (!filter) {
                        throw new Error(`description view loads at most ${maximumDescribedCatalogEntries} skills; add a filter matching skill name, repository, or path`);
                    }
                    entries = entries.filter((entry) => catalogEntryMatches(entry, filter, false));
                    if (entries.length > maximumDescribedCatalogEntries) {
                        throw new Error(`description filter still matches ${entries.length} skills; narrow it to at most ${maximumDescribedCatalogEntries} by skill name, repository, or path`);
                    }
                }
                entries = await Promise.all(entries.map(async (entry) => ({
                    ...entry,
                    description: await context.github.describeCatalog(entry, signal),
                })));
            }
            entries = entries.filter((entry) => catalogEntryMatches(entry, filter, descriptions))
                .sort((left, right) => left.repo.localeCompare(right.repo) || left.path.localeCompare(right.path) || left.name.localeCompare(right.name));
            return formatSkillCatalog(entries, context.catalogStyle, descriptions);
        }
    }
}
