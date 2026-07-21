/**
 * Transport-neutral Agent Harbor custom-tool contracts.
 *
 * Harness adapters own registration and result rendering. This module owns the
 * names, closed schemas, argument validation, principal policy, and dispatch
 * shape so Copilot, Pi, and OpenCode cannot silently diverge.
 */
import { Buffer } from "node:buffer";
import { createHmac, randomBytes } from "node:crypto";
import { isHarborId } from "./identity.js";
import { publicMetadataText } from "./public-metadata.js";
export const harborCustomToolNames = Object.freeze({
    contractPreflight: "harbor_contract",
    filterSkills: "harbor_filter_skills",
    joinPlayer: "harbor_join_player",
    delegate: "harbor_delegate",
    teamRoster: "harbor_team_roster",
});
const playerSkillPrefix = "harbor_skill_";
const maximumDefinitionBytes = 30_000;
const maximumTaskBytes = 30_000;
const maximumInvocationIdentityBytes = 4_096;
const maximumScoutRosterMembers = 32;
const maximumScoutRosterBytes = 16_384;
const rosterSearchStopWords = new Set([
    "a", "al", "and", "con", "de", "del", "el", "en", "for", "la", "las", "los", "of", "para", "por", "the", "to", "un", "una", "with", "y",
]);
function compactPublicField(value, maximumCharacters, _ambiguousRelativePaths = true) {
    return publicMetadataText(value, maximumCharacters) ?? "";
}
function normalizedRosterSearch(value) {
    return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase();
}
function rosterQueryTokens(query) {
    return [...new Set(normalizedRosterSearch(query).split(/[^\p{L}\p{N}+#._-]+/u)
            .filter((token) => token.length > 0 && !rosterSearchStopWords.has(token)))];
}
function rosterMatchScore(fields, queryTokens) {
    let score = 0;
    for (const token of queryTokens) {
        let tokenScore = 0;
        for (const field of fields) {
            const value = normalizedRosterSearch(field.value);
            if (value === token)
                tokenScore = Math.max(tokenScore, field.weight * 2);
            else if (value.includes(token))
                tokenScore = Math.max(tokenScore, field.weight);
        }
        if (tokenScore === 0)
            return -1;
        score += tokenScore;
    }
    return score;
}
/**
 * Produces the same complete, compact model-facing roster in every adapter.
 * A query ranks likely matches first but never hides other enabled members.
 */
export function formatHarborTeamRosterSnapshot(entries, query = "") {
    const total = entries.length;
    if (total > maximumScoutRosterMembers) {
        return {
            text: `Complete roster unavailable: ${total} enabled specialists exceeds the ${maximumScoutRosterMembers}-member model-facing limit. Disable unneeded members with /bench off, then start a new run. No partial roster was disclosed and recruitment is blocked.`,
            complete: false,
            total,
        };
    }
    const normalizedQuery = compactPublicField(query, 80);
    const queryTokens = rosterQueryTokens(normalizedQuery);
    const rows = entries.map((entry, index) => {
        const role = compactPublicField(entry.role, 72);
        const tools = entry.tools.slice(0, 4).map((tool) => compactPublicField(tool, 32));
        const skills = (entry.skills ?? []).slice(0, 12).map((skill) => compactPublicField(skill, 64));
        const model = entry.configuredModel
            ? `configured ${compactPublicField(entry.configuredModel, 120, false)}`
            : "inherits host";
        const matchScore = rosterMatchScore([
            { value: entry.id, weight: 10 },
            { value: role, weight: 8 },
            ...tools.map((value) => ({ value, weight: 6 })),
            ...skills.map((value) => ({ value, weight: 6 })),
            { value: model, weight: 3 },
        ], queryTokens);
        const matches = queryTokens.length === 0 || matchScore >= 0;
        return {
            index,
            matches,
            matchScore,
            value: JSON.stringify({
                id: entry.id,
                availability: entry.availability,
                role,
                tools,
                skills,
                model,
                ...(queryTokens.length ? { queryMatch: matches } : {}),
            }),
        };
    }).sort((left, right) => Number(right.matches) - Number(left.matches)
        || right.matchScore - left.matchScore || left.index - right.index);
    const text = [
        `Complete enabled roster snapshot · ${total}/${total}${queryTokens.length ? " · query matches ranked first" : ""}`,
        ...rows.map(({ value }) => value),
        "Model selection policy: reuse one sufficient ready member; a busy member is existing capacity, not permission to recruit a duplicate.",
    ].join("\n");
    if (Buffer.byteLength(text, "utf8") > maximumScoutRosterBytes) {
        return {
            text: `Complete roster unavailable within the ${maximumScoutRosterBytes}-byte model-facing limit. Shorten public role/model metadata or disable unneeded members, then start a new run. No partial roster was disclosed and recruitment is blocked.`,
            complete: false,
            total,
        };
    }
    return { text, complete: true, total };
}
/**
 * Shared invocation-local roster -> filter -> optional join state machine.
 * It enforces completeness, ordering, call budgets, serialization, and terminal
 * state. Semantic capacity/sufficiency remains an explicit recruiter policy:
 * the guard intentionally receives no roster rows and cannot infer it.
 */
export class HarborScoutTurnGuard {
    rosterCalls = 0;
    rosterSucceeded = false;
    rosterComplete = false;
    filterCalls = 0;
    filterSucceeded = false;
    joinCalls = 0;
    nextNonce = 0;
    inFlight;
    terminalReason;
    get terminal() { return this.terminalReason !== undefined; }
    begin(name, signal) {
        if (signal?.aborted) {
            this.terminate("aborted");
            signal.throwIfAborted();
        }
        if (this.terminalReason)
            throw new Error(`Agent Harbor talent-scout turn is terminal: ${this.terminalReason}`);
        if (this.inFlight)
            throw new Error("Agent Harbor talent-scout tools must run sequentially");
        const policy = harborCustomToolPolicy(name);
        if (!policy || ![harborCustomToolNames.teamRoster, harborCustomToolNames.filterSkills,
            harborCustomToolNames.joinPlayer].includes(name)) {
            throw new Error(`invalid Agent Harbor talent-scout tool: ${name}`);
        }
        if (name === harborCustomToolNames.teamRoster) {
            if (this.filterCalls || this.joinCalls)
                throw new Error("harbor_team_roster must run before filtering or joining");
            if (this.rosterCalls >= 1)
                throw new Error("harbor_team_roster may run exactly once per talent-scout turn");
            this.rosterCalls += 1;
        }
        else if (name === harborCustomToolNames.filterSkills) {
            if (!this.rosterSucceeded || !this.rosterComplete) {
                throw new Error("harbor_filter_skills requires one successful complete harbor_team_roster snapshot first");
            }
            if (this.joinCalls)
                throw new Error("harbor_filter_skills must finish before harbor_join_player");
            if (this.filterCalls >= policy.maximumCalls) {
                throw new Error(`harbor_filter_skills reached its per-run limit (${policy.maximumCalls})`);
            }
            this.filterCalls += 1;
        }
        else {
            if (!this.rosterSucceeded || !this.rosterComplete) {
                throw new Error("harbor_join_player requires one successful complete harbor_team_roster snapshot first");
            }
            if (!this.filterSucceeded)
                throw new Error("harbor_join_player requires a successful harbor_filter_skills call first");
            if (this.joinCalls >= policy.maximumCalls) {
                throw new Error(`harbor_join_player reached its per-run limit (${policy.maximumCalls})`);
            }
            this.joinCalls += 1;
        }
        const ticket = { name, nonce: ++this.nextNonce };
        this.inFlight = ticket;
        return ticket;
    }
    succeed(ticket, outcome = {}) {
        this.requireTicket(ticket);
        this.inFlight = undefined;
        if (ticket.name === harborCustomToolNames.teamRoster) {
            this.rosterSucceeded = true;
            this.rosterComplete = outcome.rosterComplete === true;
        }
        else if (ticket.name === harborCustomToolNames.filterSkills) {
            this.filterSucceeded = true;
        }
        else {
            this.terminate("join completed");
        }
    }
    fail(ticket, signal) {
        this.requireTicket(ticket);
        this.inFlight = undefined;
        if (signal?.aborted)
            this.terminate("aborted");
    }
    terminate(reason = "host turn ended") {
        this.terminalReason ??= compactPublicField(reason, 120) || "host turn ended";
    }
    requireTicket(ticket) {
        if (!this.inFlight || this.inFlight.nonce !== ticket.nonce || this.inFlight.name !== ticket.name) {
            throw new Error("invalid or already settled Agent Harbor talent-scout call ticket");
        }
    }
}
class HarborReplayTombstones {
    bits = new Uint8Array(128 * 1024);
    add(digest) {
        for (const index of this.indexes(digest))
            this.bits[index >>> 3] |= 1 << (index & 7);
    }
    has(digest) {
        return this.indexes(digest).every((index) => (this.bits[index >>> 3] & (1 << (index & 7))) !== 0);
    }
    indexes(digest) {
        const bytes = Buffer.from(digest, "base64url");
        const maximum = this.bits.length * 8;
        return [0, 4, 8, 12].map((offset) => bytes.readUInt32BE(offset) % maximum);
    }
}
/**
 * Fixed-memory HMAC-keyed host identity ledger. Terminal entries may be
 * evicted only into a non-clearing replay filter, so eviction never reopens a
 * spent call budget. Raw host IDs are never retained.
 */
export class HarborInvocationLedger {
    lifecycle;
    maximumEntries;
    key = randomBytes(32);
    entries = new Map();
    tombstones = new HarborReplayTombstones();
    constructor(lifecycle, maximumEntries = 1_024) {
        this.lifecycle = lifecycle;
        this.maximumEntries = maximumEntries;
    }
    acquire(scopeParts, invocationParts) {
        const scope = this.digest(scopeParts);
        const id = this.digest([scope, this.digest(invocationParts)]);
        const existing = this.entries.get(id);
        if (existing)
            return { id, value: existing.value };
        if (this.tombstones.has(id))
            throw new Error("Agent Harbor invocation identity is terminal or replayed");
        if (this.entries.size >= this.maximumEntries)
            this.evictOneTerminal();
        if (this.entries.size >= this.maximumEntries) {
            throw new Error("Agent Harbor invocation ledger is full of active turns; wait for host terminal events or reload");
        }
        const value = this.lifecycle.create();
        this.entries.set(id, { scope, value });
        return { id, value };
    }
    terminate(id, reason = "host turn ended") {
        const entry = this.entries.get(id);
        if (entry)
            this.lifecycle.terminate(entry.value, reason);
    }
    terminateScope(scopeParts, reason = "host session ended") {
        const scope = this.digest(scopeParts);
        for (const entry of this.entries.values()) {
            if (entry.scope === scope)
                this.lifecycle.terminate(entry.value, reason);
        }
    }
    terminateAll(reason = "adapter disposed") {
        for (const entry of this.entries.values())
            this.lifecycle.terminate(entry.value, reason);
    }
    evictOneTerminal() {
        for (const [id, entry] of this.entries) {
            if (!this.lifecycle.terminal(entry.value))
                continue;
            this.entries.delete(id);
            this.tombstones.add(id);
            return;
        }
    }
    digest(parts) {
        if (!parts.length || parts.length > 8)
            throw new Error("invalid Agent Harbor invocation identity shape");
        const hmac = createHmac("sha256", this.key);
        for (const part of parts) {
            if (typeof part !== "string" || part.length > maximumInvocationIdentityBytes ||
                Buffer.byteLength(part, "utf8") > maximumInvocationIdentityBytes) {
                throw new Error("Agent Harbor host invocation identity is invalid or oversized");
            }
            hmac.update(String(Buffer.byteLength(part, "utf8"))).update(":").update(part, "utf8").update(";");
        }
        return hmac.digest("base64url");
    }
}
/** Returns the single custom skill-loader name permanently bound to a player. */
export function harborPlayerSkillToolName(player) {
    const id = typeof player === "string" ? player : player.name;
    if (!isHarborId(id))
        throw new Error(`invalid Agent Harbor player ID for skill tool: ${id}`);
    return `${playerSkillPrefix}${id}`;
}
/** Decodes only names produced by {@link harborPlayerSkillToolName}. */
export function harborPlayerFromSkillToolName(name) {
    if (!name.startsWith(playerSkillPrefix))
        return undefined;
    const id = name.slice(playerSkillPrefix.length);
    return isHarborId(id) && harborPlayerSkillToolName(id) === name ? id : undefined;
}
const staticPolicies = Object.freeze({
    [harborCustomToolNames.contractPreflight]: {
        principal: "contract-skill", maximumCalls: 1, sequential: true, effect: "read",
    },
    [harborCustomToolNames.filterSkills]: {
        principal: "talent-scout", maximumCalls: 3, sequential: true, effect: "read",
    },
    [harborCustomToolNames.joinPlayer]: {
        principal: "talent-scout", maximumCalls: 1, sequential: true, effect: "roster-write",
    },
    [harborCustomToolNames.delegate]: {
        principal: "team-lead", maximumCalls: 6, sequential: true, effect: "child-run",
    },
    [harborCustomToolNames.teamRoster]: {
        principal: "team-lead-or-talent-scout", maximumCalls: 6, sequential: true, effect: "read",
    },
});
/** Returns policy for a static tool or one player-bound skill loader. */
export function harborCustomToolPolicy(name) {
    const player = harborPlayerFromSkillToolName(name);
    if (player)
        return { principal: "bound-player", maximumCalls: 1, sequential: true, effect: "read" };
    return staticPolicies[name];
}
const emptyObjectSchema = Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
});
export const harborStaticCustomToolSpecs = Object.freeze({
    [harborCustomToolNames.contractPreflight]: {
        name: harborCustomToolNames.contractPreflight,
        description: "Validate one literal Agent Harbor contract and prepare its exact native child descriptor.",
        parameters: {
            type: "object",
            properties: { definition: { type: "string", minLength: 1, maxLength: maximumDefinitionBytes } },
            required: ["definition"],
            additionalProperties: false,
        },
        policy: staticPolicies[harborCustomToolNames.contractPreflight],
    },
    [harborCustomToolNames.filterSkills]: {
        name: harborCustomToolNames.filterSkills,
        description: "Search only Agent Harbor's execution-trusted skill catalog by bounded public metadata.",
        parameters: {
            type: "object",
            properties: { query: { type: "string", minLength: 1, maxLength: 500 } },
            required: ["query"],
            additionalProperties: false,
        },
        policy: staticPolicies[harborCustomToolNames.filterSkills],
    },
    [harborCustomToolNames.joinPlayer]: {
        name: harborCustomToolNames.joinPlayer,
        description: "Validate, register, and activate exactly one persistent Agent Harbor player.",
        parameters: {
            type: "object",
            properties: { definition: { type: "string", minLength: 1, maxLength: maximumDefinitionBytes } },
            required: ["definition"],
            additionalProperties: false,
        },
        policy: staticPolicies[harborCustomToolNames.joinPlayer],
    },
    [harborCustomToolNames.delegate]: {
        name: harborCustomToolNames.delegate,
        description: "Run one exact active Agent Harbor specialist and return only its bounded evidence.",
        parameters: {
            type: "object",
            properties: {
                agent: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$", maxLength: 48 },
                task: { type: "string", minLength: 1, maxLength: maximumTaskBytes },
            },
            required: ["agent", "task"],
            additionalProperties: false,
        },
        policy: staticPolicies[harborCustomToolNames.delegate],
    },
    [harborCustomToolNames.teamRoster]: {
        name: harborCustomToolNames.teamRoster,
        description: "Search the invocation's bounded Agent Harbor team snapshot without creating a child.",
        parameters: {
            type: "object",
            properties: { query: { type: "string", maxLength: 80 } },
            required: ["query"],
            additionalProperties: false,
        },
        policy: staticPolicies[harborCustomToolNames.teamRoster],
    },
});
/** Builds one no-argument spec whose handler is permanently bound to `player`. */
export function harborPlayerSkillToolSpec(player) {
    const name = harborPlayerSkillToolName(player);
    return {
        name,
        description: `Load only the complete configured skill group bound to Agent Harbor player ${player.name}.`,
        parameters: emptyObjectSchema,
        policy: harborCustomToolPolicy(name),
    };
}
/** Custom tools required by one player; adapters register only the union they need. */
export function harborCustomToolsForPlayer(player) {
    if (player.name === "team-lead") {
        return [harborCustomToolNames.delegate, harborCustomToolNames.teamRoster];
    }
    if (player.name === "talent-scout") {
        return [harborCustomToolNames.teamRoster, harborCustomToolNames.filterSkills, harborCustomToolNames.joinPlayer];
    }
    return player.skills?.length ? [harborPlayerSkillToolName(player)] : [];
}
/** Enforces the transport-neutral principal boundary after the adapter authenticates it. */
export function assertHarborCustomToolAccess(name, principal) {
    const policy = harborCustomToolPolicy(name);
    if (!policy)
        throw new Error(`unknown Agent Harbor custom tool: ${name}`);
    const boundPlayer = harborPlayerFromSkillToolName(name);
    const allowed = policy.principal === "contract-skill"
        ? principal.skill === "contract"
        : policy.principal === "bound-player"
            ? principal.agent === boundPlayer
            : policy.principal === "talent-scout"
                ? principal.agent === "talent-scout"
                : policy.principal === "team-lead-or-talent-scout"
                    ? principal.agent === "team-lead" || principal.agent === "talent-scout"
                    : principal.agent === "team-lead";
    if (!allowed)
        throw new Error(`Agent Harbor custom tool ${name} is not available to this principal`);
}
function record(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Agent Harbor custom-tool arguments must be one object");
    }
    return value;
}
function exactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new Error("Agent Harbor custom-tool arguments do not match the closed schema");
    }
}
function jsonObjectLiteral(value, label) {
    if (typeof value !== "string" || value.length > maximumDefinitionBytes ||
        !value.trim() || Buffer.byteLength(value, "utf8") > maximumDefinitionBytes) {
        throw new Error(`${label} must be a non-empty JSON object string of at most ${maximumDefinitionBytes} bytes`);
    }
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch {
        throw new Error(`${label} must be valid JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(`${label} must encode one JSON object`);
    return value;
}
/** Validates runtime arguments independently of the host's JSON-schema implementation. */
export function validateHarborCustomToolArguments(name, value) {
    const args = record(value);
    const boundPlayer = harborPlayerFromSkillToolName(name);
    if (boundPlayer) {
        exactKeys(args, []);
        return { kind: "player-skills", player: boundPlayer };
    }
    if (name === harborCustomToolNames.contractPreflight) {
        exactKeys(args, ["definition"]);
        return { kind: "contract-preflight", definition: jsonObjectLiteral(args.definition, "contract definition") };
    }
    if (name === harborCustomToolNames.filterSkills) {
        exactKeys(args, ["query"]);
        if (typeof args.query !== "string" || args.query.length > 1_000 ||
            !args.query.trim() || [...args.query].length > 500) {
            throw new Error("skill filter query must contain 1-500 characters");
        }
        return { kind: "filter-skills", query: args.query };
    }
    if (name === harborCustomToolNames.joinPlayer) {
        exactKeys(args, ["definition"]);
        return { kind: "join-player", definition: jsonObjectLiteral(args.definition, "player definition") };
    }
    if (name === harborCustomToolNames.delegate) {
        exactKeys(args, ["agent", "task"]);
        if (!isHarborId(args.agent) || args.agent === "team-lead")
            throw new Error("invalid or recursive delegation target");
        if (typeof args.task !== "string" || args.task.length > maximumTaskBytes ||
            !args.task.trim() || Buffer.byteLength(args.task, "utf8") > maximumTaskBytes) {
            throw new Error(`delegation task must be non-empty and at most ${maximumTaskBytes} bytes`);
        }
        return { kind: "delegate", agent: args.agent, task: args.task };
    }
    if (name === harborCustomToolNames.teamRoster) {
        exactKeys(args, ["query"]);
        if (typeof args.query !== "string" || args.query.length > 160 || [...args.query].length > 80) {
            throw new Error("team roster query must be at most 80 characters");
        }
        return { kind: "team-roster", query: args.query };
    }
    throw new Error(`unknown Agent Harbor custom tool: ${name}`);
}
/** Shared closed-schema/access dispatcher; adapters inject only the side effects. */
export function dispatchHarborCustomTool(name, args, context, handlers) {
    assertHarborCustomToolAccess(name, context);
    const call = validateHarborCustomToolArguments(name, args);
    switch (call.kind) {
        case "contract-preflight": return handlers.contractPreflight(call, context);
        case "player-skills": return handlers.playerSkills(call, context);
        case "filter-skills": return handlers.filterSkills(call, context);
        case "join-player": return handlers.joinPlayer(call, context);
        case "delegate": return handlers.delegate(call, context);
        case "team-roster": return handlers.teamRoster(call, context);
    }
}
