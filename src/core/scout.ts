/** Deterministic, execution-allowlist-only skill discovery for the talent scout. */

import type { GithubResolver, GithubSkill } from "./types.js";

export interface ScoutSkillMatch extends GithubSkill {
  description: string;
}

const stopWords = new Set([
  "a", "al", "algo", "alguien", "con", "de", "del", "el", "en", "la", "las", "lo", "los", "para", "por", "que", "se", "un", "una", "usar", "usando",
  "a", "an", "and", "for", "in", "of", "on", "someone", "that", "the", "to", "using", "with",
]);

function normalized(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase();
}

function tokens(value: string): string[] {
  return [...new Set(normalized(value).split(/[^a-z0-9+#.-]+/u)
    .filter((token) => token.length > 1 && !stopWords.has(token)))];
}

/**
 * Searches only exact execution-trusted references. It loads bounded frontmatter
 * descriptions, never instruction bodies or project-configured visible sources.
 */
export async function filterTrustedSkills(
  query: string,
  trusted: readonly GithubSkill[],
  resolver: GithubResolver,
  signal?: AbortSignal,
): Promise<readonly ScoutSkillMatch[]> {
  const clean = query.trim();
  if (!clean || clean.length > 500) throw new Error("skill filter query must contain 1..500 characters");
  if (!resolver.describe) throw new Error("GitHub resolver cannot describe trusted skills");
  const wanted = tokens(clean);
  if (!wanted.length) return [];
  const described = await Promise.all(trusted.map(async (skill) => ({
    skill,
    description: (await resolver.describe!(skill, signal)).description,
  })));
  return described.map(({ skill, description }) => {
    const name = normalized(skill.name);
    const coordinates = normalized(`${skill.repo} ${skill.path}`);
    const detail = normalized(description);
    let score = 0;
    for (const token of wanted) {
      if (name === token) score += 12;
      else if (name.includes(token)) score += 8;
      if (coordinates.includes(token)) score += 4;
      if (detail.includes(token)) score += 3;
    }
    return { skill, description, score };
  }).filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
    .slice(0, 12)
    .map(({ skill, description }) => ({ ...skill, description }));
}

/** Serializes the bounded public match set for model-facing recruiter tools. */
export function formatScoutSkillMatches(matches: readonly ScoutSkillMatch[]): string {
  return JSON.stringify({ skills: matches });
}
