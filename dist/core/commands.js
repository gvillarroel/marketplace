/**
 * Command parsing and dispatch for deterministic roster operations and one-shot contracts.
 * This layer contains no harness-specific rendering or lifecycle mutation logic.
 */
import { validatePlayer, } from "./lifecycle.js";
import { exactCatalogSources, formatSkillCatalog } from "./catalog.js";
// Description lookup may require one authenticated GitHub request per row. Keep
// the work bounded, while still allowing large catalogs to be narrowed using
// metadata that was already returned by catalog enumeration.
const maximumDescribedCatalogEntries = 64;
const catalogPageSize = 8;
function parseCatalogQuery(args) {
    const tokens = args.trim() ? args.trim().split(/\s+/u) : [];
    let descriptions = false;
    let page = 1;
    let pageSeen = false;
    const filter = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === "--descriptions" || token === "-d") {
            if (descriptions)
                throw new Error("usage: /list-skills [--descriptions|-d] [filter] [--page N]");
            descriptions = true;
            continue;
        }
        if (token === "--page") {
            if (pageSeen || !/^\d{1,6}$/u.test(tokens[index + 1] ?? "")) {
                throw new Error("usage: /list-skills [--descriptions|-d] [filter] [--page N]");
            }
            page = Number(tokens[index + 1]);
            if (!Number.isSafeInteger(page) || page < 1) {
                throw new Error("usage: /list-skills [--descriptions|-d] [filter] [--page N]");
            }
            pageSeen = true;
            index += 1;
            continue;
        }
        if (token.startsWith("-"))
            throw new Error("usage: /list-skills [--descriptions|-d] [filter] [--page N]");
        filter.push(token);
    }
    return { descriptions, filter: filter.join(" ").toLowerCase(), page };
}
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
export async function executeCommandResult(name, args, context, signal) {
    switch (name) {
        case "bench": {
            const result = await context.roster.benchResult(args, context.bundled, signal);
            return result.kind === "list"
                ? { text: result.text }
                : { text: result.text, lifecycle: { command: "bench", status: result.status, rows: result.rows } };
        }
        case "join": {
            const result = await context.roster.joinResult(JSON.parse(args), signal);
            return {
                text: result.text,
                lifecycle: { command: "join", player: result.player, status: result.status },
            };
        }
        case "retire": {
            const result = await context.roster.retireResult(args.trim(), signal);
            return {
                text: result.text,
                lifecycle: { command: "retire", player: result.player, status: result.status },
            };
        }
        case "contract": return { text: await context.orchestrator.run(parseContractDefinition(args), signal) };
        case "list-skills": {
            const { descriptions, filter, page } = parseCatalogQuery(args);
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
            const total = entries.length;
            const pages = Math.max(1, Math.ceil(total / catalogPageSize));
            if (page > pages)
                throw new Error(`catalog page ${page} is out of range; choose 1..${pages}`);
            const start = (page - 1) * catalogPageSize;
            const visible = entries.slice(start, start + catalogPageSize);
            const range = total ? `${start + 1}–${start + visible.length}` : "0";
            const query = [descriptions ? "--descriptions" : "", filter].filter(Boolean).join(" ");
            return { text: [
                    `Skill catalog · page ${page}/${pages} · showing ${range} of ${total}`,
                    formatSkillCatalog(visible, context.catalogStyle, descriptions),
                    ...(page < pages ? [`Next: /list-skills ${query ? `${query} ` : ""}--page ${page + 1}`] : []),
                    ...(page > 1 ? [`Previous: /list-skills ${query ? `${query} ` : ""}--page ${page - 1}`] : []),
                ].join("\n") };
        }
    }
}
/** Backwards-compatible text command API. */
export async function executeCommand(name, args, context, signal) {
    return (await executeCommandResult(name, args, context, signal)).text;
}
