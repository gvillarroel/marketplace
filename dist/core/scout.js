/** Deterministic, execution-allowlist-only skill discovery for the talent scout. */
import { InvalidSkillDocumentError } from "./github.js";
const stopWords = new Set([
    "a", "al", "algo", "alguien", "con", "de", "del", "el", "en", "la", "las", "lo", "los", "para", "por", "que", "se", "un", "una", "usar", "usando",
    "a", "an", "and", "for", "in", "of", "on", "someone", "that", "the", "to", "using", "with",
]);
function normalized(value) {
    return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase();
}
function tokens(value) {
    return [...new Set(normalized(value).split(/[^a-z0-9+#.-]+/u)
            .filter((token) => token.length > 1 && !stopWords.has(token)))];
}
/**
 * Searches exact execution-trusted references plus skills discovered in trusted
 * repositories. It loads bounded frontmatter descriptions, never instruction bodies
 * or project-configured visible sources.
 */
export async function filterTrustedSkills(query, trusted, resolver, signal) {
    const clean = query.trim();
    if (!clean || clean.length > 500)
        throw new Error("skill filter query must contain 1..500 characters");
    if (!resolver.describe)
        throw new Error("GitHub resolver cannot describe trusted skills");
    const wanted = tokens(clean);
    if (!wanted.length)
        return [];
    const references = new Map();
    for (const skill of trusted)
        references.set(`${skill.repo.toLowerCase()}\0${skill.path}\0${skill.track}`, skill);
    const described = await Promise.all([...references.values()].map(async (skill) => ({
        skill,
        description: (await resolver.describe(skill, signal)).description,
    })));
    if ((trusted.repositories?.length ?? 0) > 0) {
        if (!resolver.listCatalog)
            throw new Error("GitHub resolver cannot enumerate trusted repositories");
        const groups = await Promise.all(trusted.repositories.map((source) => resolver.listCatalog(source, signal)));
        const discovered = await Promise.all(groups.flat().map(async (entry) => {
            const track = entry.track;
            if (!track)
                throw new Error("trusted repository row lacks branch metadata");
            const identity = `${entry.repo.toLowerCase()}\0${entry.path}\0${track}`;
            if (references.has(identity))
                return undefined;
            if (resolver.inspectCatalog) {
                let metadata;
                try {
                    metadata = await resolver.inspectCatalog(entry, signal);
                }
                catch (error) {
                    if (error instanceof InvalidSkillDocumentError)
                        return undefined;
                    throw error;
                }
                return {
                    skill: { kind: "github", name: metadata.name, repo: entry.repo, path: entry.path, track },
                    description: metadata.description,
                };
            }
            const skill = { kind: "github", name: entry.name, repo: entry.repo, path: entry.path, track };
            return { skill, description: (await resolver.describe(skill, signal)).description };
        }));
        described.push(...discovered.filter((value) => value !== undefined));
    }
    return described.map(({ skill, description }) => {
        const name = normalized(skill.name);
        const coordinates = normalized(`${skill.repo} ${skill.path}`);
        const detail = normalized(description);
        let score = 0;
        for (const token of wanted) {
            if (name === token)
                score += 12;
            else if (name.includes(token))
                score += 8;
            if (coordinates.includes(token))
                score += 4;
            if (detail.includes(token))
                score += 3;
        }
        return { skill, description, score };
    }).filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
        .slice(0, 12)
        .map(({ skill, description }) => ({ ...skill, description }));
}
/** Serializes the bounded public match set for model-facing recruiter tools. */
export function formatScoutSkillMatches(matches) {
    return JSON.stringify({ skills: matches });
}
