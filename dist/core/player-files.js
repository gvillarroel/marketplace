/** Closed-schema loader for fixed player definitions stored as Markdown files. */
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { isHarborId } from "./identity.js";
import { validateConfiguredSkillReferences } from "./skills.js";
const allowedKeys = new Set(["name", "description", "order", "tools", "model", "skills"]);
const allowedTools = new Set(["read", "search", "edit", "execute"]);
const maxFiles = 32;
const maxFileBytes = 32_000;
function parseJsonField(frontmatter, key) {
    const raw = frontmatter.get(key);
    if (raw === undefined)
        return undefined;
    try {
        return JSON.parse(raw);
    }
    catch {
        throw new Error(`fixed player has invalid JSON frontmatter field: ${key}`);
    }
}
function parsePlayerFile(path, trustedSkills) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`fixed player must be a regular file: ${path}`);
    if (stat.size < 1 || stat.size > maxFileBytes)
        throw new Error(`fixed player file must be 1..${maxFileBytes} bytes: ${path}`);
    const source = readFileSync(path, "utf8").replace(/\r\n/gu, "\n");
    if (!source.startsWith("---\n") || source.includes("\0"))
        throw new Error(`fixed player requires first-line frontmatter: ${path}`);
    const end = source.indexOf("\n---\n", 4);
    if (end < 0 || end > 4_096)
        throw new Error(`fixed player has invalid frontmatter: ${path}`);
    const frontmatter = new Map();
    for (const line of source.slice(4, end).split("\n")) {
        const match = /^([a-z][a-z-]*):\s*(.+)$/u.exec(line);
        if (!match || !allowedKeys.has(match[1]) || frontmatter.has(match[1]))
            throw new Error(`fixed player has invalid or duplicate frontmatter: ${path}`);
        frontmatter.set(match[1], match[2]);
    }
    const name = parseJsonField(frontmatter, "name");
    const description = parseJsonField(frontmatter, "description");
    const order = parseJsonField(frontmatter, "order");
    const tools = parseJsonField(frontmatter, "tools");
    const model = parseJsonField(frontmatter, "model");
    const skillValues = parseJsonField(frontmatter, "skills") ?? [];
    if (!isHarborId(name) || basename(path, ".md") !== name)
        throw new Error(`fixed player name must match its filename: ${path}`);
    if (typeof description !== "string" || !description.trim() || description.length > 500)
        throw new Error(`fixed player has invalid description: ${path}`);
    if (!Number.isInteger(order) || order < 0 || order > 10_000)
        throw new Error(`fixed player has invalid order: ${path}`);
    if (!Array.isArray(tools) || tools.length > allowedTools.size || tools.some((tool) => typeof tool !== "string" || !allowedTools.has(tool)) || new Set(tools).size !== tools.length) {
        throw new Error(`fixed player has invalid tools: ${path}`);
    }
    if (model !== undefined && (typeof model !== "string" || !model.trim() || model.length > 200))
        throw new Error(`fixed player has invalid model: ${path}`);
    const skills = validateConfiguredSkillReferences(skillValues, tools, trustedSkills);
    const prompt = source.slice(end + 5).trim();
    if (!prompt || prompt.length > 18_000)
        throw new Error(`fixed player has invalid prompt: ${path}`);
    return {
        order: order,
        definition: {
            name,
            description: description.trim(),
            prompt,
            tools: tools,
            ...(model === undefined ? {} : { model: model }),
            ...(skills.length ? { skills } : {}),
        },
    };
}
/** Loads all fixed players in stable frontmatter order from one bundled directory. */
export function loadFixedPlayers(directory, trustedSkills) {
    const root = fileURLToPath(directory);
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`fixed player directory must be a regular directory: ${root}`);
    const filenames = readdirSync(root).filter((name) => name.endsWith(".md")).sort();
    if (!filenames.length || filenames.length > maxFiles)
        throw new Error(`fixed player directory must contain 1..${maxFiles} Markdown files`);
    const parsed = filenames.map((filename) => parsePlayerFile(fileURLToPath(new URL(filename, directory)), trustedSkills))
        .sort((left, right) => left.order - right.order || left.definition.name.localeCompare(right.definition.name));
    const players = new Map();
    const orders = new Set();
    for (const { order, definition } of parsed) {
        if (players.has(definition.name))
            throw new Error(`duplicate fixed player: ${definition.name}`);
        if (orders.has(order))
            throw new Error(`duplicate fixed player order: ${order}`);
        orders.add(order);
        players.set(definition.name, definition);
    }
    return players;
}
