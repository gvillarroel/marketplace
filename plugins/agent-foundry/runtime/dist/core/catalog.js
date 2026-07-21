/** Project-controlled, read-only skill catalog configuration and terminal rendering. */
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateGithubSkillCatalogSource } from "./github.js";
import { takeTerminalColumns, terminalLineWidth, visibleTextWidth } from "./text-layout.js";
const configDirectory = ".agent-harbor";
const configFilename = "skill-sources.json";
const maxConfigBytes = 64 * 1024;
/** Returns the project-local file that controls the visible skill catalog. */
export function skillCatalogConfigPath(project) {
    return join(resolve(project), configDirectory, configFilename);
}
/** Converts the exact built-in execution allowlist into the default visible catalog. */
export function exactCatalogSources(skills) {
    return skills.map(({ repo, path, track, name }) => ({ kind: "github", scope: "skill", repo, path, track, name }));
}
/**
 * Loads a closed-schema project override. A present file replaces the defaults,
 * so an empty `sources` array intentionally displays an empty catalog.
 */
export async function loadSkillCatalogSources(project, defaults) {
    const path = skillCatalogConfigPath(project);
    let stat;
    try {
        stat = await lstat(path);
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return defaults;
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`skill catalog config must be a regular file: ${path}`);
    if (stat.size > maxConfigBytes)
        throw new Error(`skill catalog config exceeds ${maxConfigBytes} bytes: ${path}`);
    const raw = await readFile(path, "utf8");
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new Error(`invalid JSON in skill catalog config: ${path}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`invalid skill catalog config: ${path}`);
    const record = value;
    if (Object.keys(record).some((key) => !["version", "sources"].includes(key)) || record.version !== 1 || !Array.isArray(record.sources)) {
        throw new Error(`skill catalog config requires exactly version 1 and sources: ${path}`);
    }
    if (record.sources.length > 32)
        throw new Error("skill catalog supports at most 32 sources");
    const sources = record.sources.map(validateGithubSkillCatalogSource);
    const identities = new Set();
    for (const source of sources) {
        const identity = `${source.repo.toLowerCase()}\0${source.track}\0${source.scope}\0${source.path ?? ""}`;
        if (identities.has(identity))
            throw new Error("duplicate skill catalog source");
        identities.add(identity);
    }
    return sources;
}
function pad(value, width) {
    return value + " ".repeat(Math.max(0, width - visibleTextWidth(value)));
}
function publicCell(value) {
    return value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
}
function tableWidths(rows, headers) {
    // Use the stricter boxed-table overhead for every style so switching styles
    // never produces a wider line: one edge plus three characters per column.
    const contentBudget = terminalLineWidth - (headers.length * 3 + 1);
    const desired = headers.map((header, index) => Math.max(visibleTextWidth(header), ...rows.map((row) => visibleTextWidth(row[index] ?? ""))));
    const widths = headers.map((header) => visibleTextWidth(header));
    let remaining = Math.max(0, contentBudget - widths.reduce((sum, width) => sum + width, 0));
    while (remaining > 0 && widths.some((width, index) => width < desired[index])) {
        for (let index = 0; index < widths.length && remaining > 0; index += 1) {
            if (widths[index] >= desired[index])
                continue;
            widths[index] += 1;
            remaining -= 1;
        }
    }
    return widths;
}
function splitCatalogToken(token, width) {
    const [candidate, hardRemainder] = takeTerminalColumns(token, width);
    if (!hardRemainder)
        return [token, ""];
    const points = [...candidate];
    const delimiters = [candidate.lastIndexOf("/") + 1, candidate.lastIndexOf("\\") + 1, candidate.lastIndexOf("-") + 1];
    const soft = Math.max(...delimiters);
    if (soft >= Math.ceil(points.length / 2)) {
        return [points.slice(0, soft).join(""), points.slice(soft).join("") + hardRemainder];
    }
    return [candidate, hardRemainder];
}
function wrapCatalogCell(value, width) {
    if (visibleTextWidth(value) <= width)
        return [value];
    const words = value.split(/\s+/u).filter(Boolean);
    const lines = [];
    let current = "";
    for (let word of words) {
        while (word) {
            const available = width - visibleTextWidth(current) - (current ? 1 : 0);
            if (available <= 0) {
                lines.push(current);
                current = "";
                continue;
            }
            if (visibleTextWidth(word) <= available) {
                current += `${current ? " " : ""}${word}`;
                word = "";
            }
            else if (current) {
                lines.push(current);
                current = "";
            }
            else {
                const [chunk, remainder] = splitCatalogToken(word, width);
                lines.push(chunk);
                word = remainder;
            }
        }
    }
    if (current)
        lines.push(current);
    return lines.length ? lines : [""];
}
function wrappedRows(values, widths) {
    const cells = values.map((value, index) => wrapCatalogCell(value, widths[index]));
    const height = Math.max(1, ...cells.map(({ length }) => length));
    return Array.from({ length: height }, (_, line) => cells.map((cell) => cell[line] ?? ""));
}
/** Renders repository, path, skill name, and an opt-in description in the selected terminal style. */
export function formatSkillCatalog(entries, style = "plain", descriptions = false) {
    const rows = entries.map(({ repo, path, name, description }) => descriptions
        ? [repo, path, name, description ?? ""].map(publicCell) : [repo, path, name].map(publicCell));
    const headers = descriptions ? ["REPOSITORY", "PATH", "SKILL", "DESCRIPTION"] : ["REPOSITORY", "PATH", "SKILL"];
    const widths = tableWidths(rows, headers);
    const useColor = style !== "plain" && !process.env.NO_COLOR && process.env.TERM !== "dumb";
    const paint = (code, value) => useColor ? `\x1b[${code}m${value}\x1b[0m` : value;
    if (style === "copilot") {
        const border = (left, middle, right) => paint(90, left + widths.map((width) => "─".repeat(width + 2)).join(middle) + right);
        const boxedRow = (values, header = false) => [
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
            ...rows.flatMap((values) => wrappedRows(values, widths).map((line) => boxedRow(line))),
            border("╰", "┴", "╯"),
        ].join("\n");
    }
    const line = (row, header = false) => row.map((cell, index) => {
        const padded = index === row.length - 1 ? cell : pad(cell, widths[index]);
        return paint(header ? 1 : [36, 90, 32, 33][index], padded);
    }).join("  ");
    return [line(headers, true), ...rows.flatMap((row) => wrappedRows(row, widths).map((part) => line(part)))].join("\n");
}
