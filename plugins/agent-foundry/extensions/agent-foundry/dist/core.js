import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
/**
 * The SDK injected into an extension does not include its optional platform
 * runtime package. Resolve the already-installed Copilot CLI explicitly so a
 * contractor can start its own isolated SDK session.
 */
export function resolveCopilotCliPath(env = process.env) {
    for (const candidate of [env.AGENT_HARBOR_CLI_PATH, env.COPILOT_CLI_PATH]) {
        if (candidate && existsSync(candidate))
            return resolve(candidate);
    }
    if (env.COPILOT_CLI_DIST_DIR) {
        const bundledRuntime = resolve(env.COPILOT_CLI_DIST_DIR, "index.js");
        if (existsSync(bundledRuntime))
            return bundledRuntime;
    }
    try {
        const output = process.platform === "win32"
            ? execFileSync("where.exe", ["copilot"], { encoding: "utf8", windowsHide: true })
            : execFileSync("sh", ["-lc", "command -v copilot"], { encoding: "utf8" });
        const candidate = output.split(/\r?\n/).map((line) => line.trim()).find((line) => line && existsSync(line));
        if (candidate)
            return resolve(candidate);
    }
    catch {
        // Fall through to the actionable error below.
    }
    throw new Error("Could not locate the GitHub Copilot CLI executable. Set AGENT_HARBOR_CLI_PATH to its absolute path.");
}
const safeName = (value) => value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
export function validateDefinition(input) {
    const name = safeName(input.name ?? "");
    if (!name || name.length > 64)
        throw new Error("Agent name must be 1-64 kebab-case characters.");
    if (!input.prompt?.trim())
        throw new Error("Agent prompt is required.");
    return { ...input, name, description: input.description?.trim() || name, prompt: input.prompt.trim() };
}
export function parseDefinition(raw) {
    try {
        return validateDefinition(JSON.parse(raw));
    }
    catch (error) {
        throw new Error(`Expected a JSON agent definition: ${error instanceof Error ? error.message : String(error)}`);
    }
}
export function renderAgentMarkdown(input) {
    const agent = validateDefinition(input);
    const tools = JSON.stringify(agent.tools ?? []);
    const skills = JSON.stringify((agent.skills ?? []).map((skill) => skill.name ?? safeName(basename(skill.path))));
    return `---\nname: ${agent.name}\ndescription: ${JSON.stringify(agent.description)}\ntools: ${tools}\nskills: ${skills}\n---\n\n${agent.prompt}\n`;
}
export async function savePermanentAgent(input, cwd = process.cwd()) {
    const agent = validateDefinition(input);
    const directory = resolve(cwd, ".github", "agents");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${agent.name}.agent.md`);
    await writeFile(path, renderAgentMarkdown(agent), "utf8");
    return path;
}
export async function removePermanentAgent(name, cwd = process.cwd()) {
    await rm(resolve(cwd, ".github", "agents", `${safeName(name)}.agent.md`), { force: true });
}
export async function materializeSkills(sources, root) {
    const target = root ?? await mkdtemp(join(tmpdir(), "agent-harbor-"));
    const names = [];
    for (const source of sources) {
        const name = safeName(source.name ?? basename(source.path));
        if (!name)
            throw new Error(`Cannot infer skill name from ${source.path}`);
        const directory = join(target, name);
        await mkdir(directory, { recursive: true });
        let content;
        if (source.kind === "local")
            content = await readFile(resolve(source.path), "utf8");
        else {
            if (!/^[\w.-]+\/[\w.-]+$/.test(source.repo))
                throw new Error(`Invalid GitHub repository: ${source.repo}`);
            const url = `https://raw.githubusercontent.com/${source.repo}/${source.ref ?? "main"}/${source.path.replace(/^\/+/, "")}`;
            const response = await fetch(url);
            if (!response.ok)
                throw new Error(`Unable to fetch ${url}: ${response.status}`);
            content = await response.text();
        }
        await writeFile(join(directory, "SKILL.md"), content, "utf8");
        names.push(name);
    }
    return { root: target, names, cleanup: () => rm(target, { recursive: true, force: true }) };
}
