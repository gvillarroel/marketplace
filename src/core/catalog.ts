/** Project-controlled, read-only skill catalog configuration and terminal rendering. */

import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateGithubSkillCatalogSource } from "./github.js";
import type { GithubSkill, GithubSkillCatalogEntry, GithubSkillCatalogSource } from "./types.js";

const configDirectory = ".agent-harbor";
const configFilename = "skill-sources.json";
const maxConfigBytes = 64 * 1024;

/** Presentation selected by each native terminal surface. */
export type SkillCatalogStyle = "plain" | "ansi" | "copilot";

/** Returns the project-local file that controls the visible skill catalog. */
export function skillCatalogConfigPath(project: string): string {
  return join(resolve(project), configDirectory, configFilename);
}

/** Converts the exact built-in execution allowlist into the default visible catalog. */
export function exactCatalogSources(skills: readonly GithubSkill[]): GithubSkillCatalogSource[] {
  return skills.map(({ repo, path, track, name }) => ({ kind: "github", scope: "skill", repo, path, track, name }));
}

/**
 * Loads a closed-schema project override. A present file replaces the defaults,
 * so an empty `sources` array intentionally displays an empty catalog.
 */
export async function loadSkillCatalogSources(
  project: string,
  defaults: readonly GithubSkillCatalogSource[],
): Promise<readonly GithubSkillCatalogSource[]> {
  const path = skillCatalogConfigPath(project);
  let stat;
  try { stat = await lstat(path); }
  catch (error: any) { if (error?.code === "ENOENT") return defaults; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`skill catalog config must be a regular file: ${path}`);
  if (stat.size > maxConfigBytes) throw new Error(`skill catalog config exceeds ${maxConfigBytes} bytes: ${path}`);
  const raw = await readFile(path, "utf8");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error(`invalid JSON in skill catalog config: ${path}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid skill catalog config: ${path}`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["version", "sources"].includes(key)) || record.version !== 1 || !Array.isArray(record.sources)) {
    throw new Error(`skill catalog config requires exactly version 1 and sources: ${path}`);
  }
  if (record.sources.length > 32) throw new Error("skill catalog supports at most 32 sources");
  const sources = record.sources.map(validateGithubSkillCatalogSource);
  const identities = new Set<string>();
  for (const source of sources) {
    const identity = `${source.repo.toLowerCase()}\0${source.track}\0${source.scope}\0${source.path ?? ""}`;
    if (identities.has(identity)) throw new Error("duplicate skill catalog source");
    identities.add(identity);
  }
  return sources;
}

function visibleLength(value: string): number {
  return value.replace(/\x1b\[[0-9;]*m/gu, "").length;
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleLength(value)));
}

/** Renders repository, path, skill name, and an opt-in description in the selected terminal style. */
export function formatSkillCatalog(entries: readonly GithubSkillCatalogEntry[], style: SkillCatalogStyle = "plain", descriptions = false): string {
  const rows = entries.map(({ repo, path, name, description }) => descriptions
    ? [repo, path, name, description ?? ""] : [repo, path, name]);
  const headers = descriptions ? ["REPOSITORY", "PATH", "SKILL", "DESCRIPTION"] : ["REPOSITORY", "PATH", "SKILL"];
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index].length)));
  const useColor = style !== "plain" && !process.env.NO_COLOR && process.env.TERM !== "dumb";
  const paint = (code: number, value: string): string => useColor ? `\x1b[${code}m${value}\x1b[0m` : value;
  if (style === "copilot") {
    const border = (left: string, middle: string, right: string): string => paint(90,
      left + widths.map((width) => "─".repeat(width + 2)).join(middle) + right);
    const boxedRow = (values: readonly string[], header = false): string => [
      paint(90, "│"),
      ...values.flatMap((value, index) => [
        ` ${paint(header ? 1 : [36, 90, 32, 33][index], pad(value, widths[index]))} `,
        paint(90, "│"),
      ]),
    ].join("");
    return [
      border("╭", "┬", "╮"),
      boxedRow(headers, true),
      border("├", "┼", "┤"),
      ...rows.map((values) => boxedRow(values)),
      border("╰", "┴", "╯"),
    ].join("\n");
  }
  const line = (row: readonly string[], header = false): string => row.map((cell, index) => {
    const padded = index === row.length - 1 ? cell : pad(cell, widths[index]);
    return paint(header ? 1 : [36, 90, 32, 33][index], padded);
  }).join("  ");
  return [line(headers, true), ...rows.map((row) => line(row))].join("\n");
}
