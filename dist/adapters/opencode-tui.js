import { parseContractDefinition } from "../core/commands.js";
import { publicErrorText } from "../core/public-metadata.js";
import { validatePlayer } from "../core/lifecycle.js";
import { stripTerminalControls, wrapPlainLines } from "../core/text-layout.js";
import { OpenCodeOrchestrator, } from "../orchestrators/opencode.js";
import { runDeterministicCommandResult } from "./direct.js";
import { runOpenCodeRosterMutationGate } from "./opencode-agent-activity.js";
import { assertOpenCodeLifecycleMutationTruth } from "./opencode-lifecycle-result.js";
import { collectOpenCodeTeamSnapshot, isOpenCodeAgentConfigured, isOpenCodeAgentLoaded, openCodePublicLabel, readOpenCodeDirectAliasCollisions, stopOpenCodeTeamRuns, } from "./opencode-team-runtime.js";
import { formatOpenCodeStopResult, formatOpenCodeTeamDiagnostics, formatOpenCodeTeamHelp, formatOpenCodeTeamView, maximumOpenCodeTeamDialogLines, } from "./opencode-team-view.js";
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
function boundedTeamActionError(error, fallback) {
    const safe = publicErrorText(message(error), 600) ?? fallback;
    const wrapped = wrapPlainLines([safe]);
    if (wrapped.length <= maximumOpenCodeTeamDialogLines)
        return wrapped.join("\n");
    return [
        ...wrapped.slice(0, maximumOpenCodeTeamDialogLines - 1),
        "… error text omitted by the 30-line dialog budget; retry with a shorter selector.",
    ].join("\n");
}
const displayEpoch = new WeakMap();
const disposedApis = new WeakSet();
const harborDialogState = new WeakMap();
const mutationTails = new WeakMap();
const snapshotReads = new WeakMap();
function v2TextParts(value) {
    if (!Array.isArray(value) || value.length !== 1) {
        throw new Error("OpenCode TUI contracts require exactly one text prompt part");
    }
    const part = value[0];
    if (!part || part.type !== "text" || typeof part.text !== "string") {
        throw new Error("OpenCode TUI contracts require one bounded text prompt part");
    }
    return [{ type: "text", text: part.text }];
}
/** Bridges the TUI's v2 SDK request shape to the narrow legacy-shaped child API. */
export function openCodeTuiOrchestratorClient(client) {
    return {
        session: {
            async create(input) {
                const result = await client.session.create({
                    directory: input.query?.directory,
                    title: input.body?.title,
                }, { signal: input.signal, throwOnError: true });
                return { data: result.data === undefined ? undefined : { id: result.data.id } };
            },
            async delete(input) {
                const result = await client.session.delete({
                    sessionID: input.path.id,
                    directory: input.query?.directory,
                }, { signal: input.signal, throwOnError: true });
                return { data: result.data };
            },
            async update(input) {
                const result = await client.session.update({
                    sessionID: input.path.id,
                    directory: input.query?.directory,
                    title: input.body?.title,
                }, { signal: input.signal, throwOnError: true });
                return {
                    data: result.data === undefined ? undefined : {
                        id: result.data.id,
                        title: result.data.title,
                    },
                };
            },
            async prompt(input) {
                const body = input.body;
                const result = await client.session.prompt({
                    sessionID: input.path.id,
                    directory: input.query?.directory,
                    agent: body.agent,
                    model: body.model,
                    variant: body.variant,
                    tools: body.tools,
                    parts: v2TextParts(body.parts),
                }, { signal: input.signal, throwOnError: true });
                return {
                    data: result.data === undefined ? undefined : {
                        info: result.data.info,
                        parts: result.data.parts,
                    },
                };
            },
        },
    };
}
function formatContractTelemetry(telemetry) {
    const count = (value) => Math.floor(value).toLocaleString("en-US");
    const model = telemetry.model
        ? `provider="${openCodePublicLabel(telemetry.model.providerID, 32) ?? "unknown"}" · model="${openCodePublicLabel(telemetry.model.modelID, 48) ?? "unknown"}"${telemetry.model.variant ? ` · variant="${openCodePublicLabel(telemetry.model.variant, 24) ?? "unknown"}"` : ""} (observed)`
        : "unobserved";
    const components = [
        telemetry.input === undefined ? undefined : `input ${count(telemetry.input)}`,
        telemetry.output === undefined ? undefined : `output ${count(telemetry.output)}`,
        telemetry.reasoning === undefined ? undefined : `reasoning ${count(telemetry.reasoning)}`,
        telemetry.cacheRead === undefined ? undefined : `cache read ${count(telemetry.cacheRead)}`,
        telemetry.cacheWrite === undefined ? undefined : `cache write ${count(telemetry.cacheWrite)}`,
        telemetry.total === undefined ? undefined : telemetry.totalSource === "native"
            ? `native total ${count(telemetry.total)}${telemetry.totalConflict ? " (component conflict)" : ""}`
            : `observed component sum ${telemetry.totalLowerBound ? "≥" : ""}${count(telemetry.total)}${telemetry.totalLowerBound ? " (partial)" : ""}`,
    ].filter((value) => value !== undefined);
    const cost = telemetry.cost === undefined
        ? "unobserved"
        : `$${Object.is(telemetry.cost, -0) ? "0" : telemetry.cost.toString()}`;
    return wrapPlainLines([
        "Observation captured before disposable-child deletion:",
        `Model: ${model}`,
        `Tokens: ${components.length ? components.join(" · ") : "unobserved"}`,
        `Cost: ${cost}`,
    ]).join("\n");
}
function beginDisplayAction(api) {
    const epoch = (displayEpoch.get(api) ?? 0) + 1;
    displayEpoch.set(api, epoch);
    return epoch;
}
function isLatestDisplayAction(api, epoch) {
    return !isDisposed(api) && displayEpoch.get(api) === epoch;
}
function isDisposed(api) {
    return disposedApis.has(api) || api.lifecycle?.signal.aborted === true;
}
function enqueueMutation(api, action) {
    if (mutationTails.has(api))
        return Promise.reject(new Error("Another Agent Harbor mutation is already running; wait for its result before retrying"));
    snapshotReads.delete(api);
    const result = Promise.resolve().then(() => {
        if (isDisposed(api))
            throw new Error("Agent Harbor TUI controls were deactivated");
        return action();
    });
    const tail = result.then(() => undefined, () => undefined);
    mutationTails.set(api, tail);
    void tail.finally(() => {
        if (mutationTails.get(api) === tail)
            mutationTails.delete(api);
    });
    return result;
}
function sharedTeamSnapshot(api, options) {
    const existing = snapshotReads.get(api);
    if (existing)
        return existing;
    const reading = collectOpenCodeTeamSnapshot(api, options);
    snapshotReads.set(api, reading);
    void reading.finally(() => {
        if (snapshotReads.get(api) === reading)
            snapshotReads.delete(api);
    }).catch(() => undefined);
    return reading;
}
function prepareHarborDialog(api) {
    const existing = harborDialogState.get(api);
    const token = {};
    const baseSize = existing?.baseSize ?? api.ui.dialog.size;
    harborDialogState.set(api, { baseSize, token });
    let restored = false;
    const restore = () => {
        if (restored)
            return;
        restored = true;
        const current = harborDialogState.get(api);
        if (current?.token !== token)
            return;
        harborDialogState.delete(api);
        api.ui.dialog.setSize(current.baseSize);
    };
    const isCurrent = () => harborDialogState.get(api)?.token === token;
    const close = () => {
        if (!isCurrent())
            return false;
        api.ui.dialog.clear();
        // Test doubles and older hosts may not invoke the registered close hook.
        if (isCurrent())
            restore();
        return true;
    };
    return { baseSize, close, isCurrent, restore };
}
function clearOwnedHarborDialog(api) {
    const owned = harborDialogState.get(api);
    if (!owned)
        return;
    api.ui.dialog.clear();
    if (harborDialogState.get(api) === owned) {
        harborDialogState.delete(api);
        api.ui.dialog.setSize(owned.baseSize);
    }
}
function showTeamDialog(api, title, contents) {
    if (isDisposed(api))
        return;
    const owner = prepareHarborDialog(api);
    api.ui.dialog.replace(() => api.ui.DialogAlert({
        title,
        message: contents,
        onConfirm: owner.close,
    }), owner.restore);
    // `replace` invokes the previous dialog's cleanup synchronously. Resize
    // afterwards so a replaced Harbor dialog cannot reset the new one to medium.
    api.ui.dialog.setSize("xlarge");
}
function showHarborPrompt(api, title, placeholder, onConfirm) {
    if (isDisposed(api))
        return;
    const owner = prepareHarborDialog(api);
    api.ui.dialog.replace(() => api.ui.DialogPrompt({
        title,
        placeholder,
        onCancel: owner.close,
        onConfirm: async (value) => {
            if (!owner.isCurrent())
                return;
            owner.close();
            if (isDisposed(api))
                return;
            await onConfirm(value);
        },
    }), owner.restore);
    // A preceding Harbor result may have enlarged the shared dialog surface.
    // Prompts deliberately return to the size that predated the Harbor flow.
    api.ui.dialog.setSize(owner.baseSize);
}
function boundedPublicMultiline(value, maximumCodePoints = 24_000) {
    const source = value.slice(0, Math.min(48_000, maximumCodePoints * 2));
    const sourceLines = source.split(/\r?\n/gu);
    let truncated = source.length < value.length || sourceLines.length > 256;
    const lines = sourceLines.slice(0, 256).map((line) => {
        if ([...line].length > 1_000)
            truncated = true;
        return publicErrorText(line, 1_000, [
            "bench-list", "bench-off", "bench-on", "harbor-filter-skills", "harbor-join", "harbor-retire",
        ]) ?? "";
    });
    const normalized = lines.join("\n").trim();
    if (!normalized)
        return undefined;
    const points = [...normalized];
    if (points.length > maximumCodePoints)
        truncated = true;
    const bounded = points.slice(0, Math.max(1, maximumCodePoints - (truncated ? 1 : 0))).join("");
    return `${bounded}${truncated ? "…" : ""}`;
}
/** Catalog rows contain validated, useful relative paths; preserve them while bounding the dialog. */
function boundedCatalogOutput(value) {
    const source = stripTerminalControls(value.slice(0, 48_000));
    const wrapped = wrapPlainLines(source.split(/\r?\n/gu));
    if (wrapped.length <= maximumOpenCodeTeamDialogLines)
        return wrapped.join("\n").trim();
    return [
        ...wrapped.slice(0, maximumOpenCodeTeamDialogLines - 2),
        `… ${wrapped.length - maximumOpenCodeTeamDialogLines + 2} display lines omitted.`,
        "Use the shown --page route or a narrower /harbor-filter-skills query.",
    ].join("\n");
}
/** Bounds requested child evidence without applying metadata path/URL redaction. */
export function boundedContractEvidence(value, maximumCodePoints = 24_000) {
    const source = value.slice(0, Math.min(48_000, maximumCodePoints * 2));
    const sourceLines = source.split(/\r?\n/gu);
    let truncated = source.length < value.length || sourceLines.length > 256;
    const safeLines = sourceLines.slice(0, 256).map((line) => {
        const safe = stripTerminalControls(line);
        const points = [...safe];
        if (points.length > 1_000)
            truncated = true;
        return points.slice(0, 1_000).join("");
    });
    const wrapped = wrapPlainLines(safeLines).filter((line, index, all) => line.trim() || all.slice(0, index).some((candidate) => candidate.trim()) || all.slice(index + 1).some((candidate) => candidate.trim()));
    if (!wrapped.some((line) => line.trim()))
        return undefined;
    const maximumEvidenceLines = 20;
    const selected = [];
    let codePoints = 0;
    for (const line of wrapped) {
        const next = [...line].length + (selected.length ? 1 : 0);
        if (selected.length >= maximumEvidenceLines || codePoints + next > maximumCodePoints) {
            truncated = true;
            break;
        }
        selected.push(line);
        codePoints += next;
    }
    if (!truncated)
        return selected.join("\n").trim();
    const notice = `… evidence bounded; ${Math.max(0, wrapped.length - selected.length)} wrapped lines omitted before telemetry.`;
    if (selected.length >= maximumEvidenceLines)
        selected.splice(maximumEvidenceLines - 1);
    selected.push(notice);
    return selected.join("\n").trim();
}
function requireBoundedDirectInput(command, args) {
    const maximumBytes = command === "join" ? 30_000 : command === "retire" ? 256 : 4_096;
    if (args.length > maximumBytes || Buffer.byteLength(args, "utf8") > maximumBytes) {
        const label = command === "list-skills" ? "/harbor-filter-skills" : `/harbor-${command}`;
        throw new Error(`${label} input exceeds the ${maximumBytes === 30_000 ? "30 KiB" : `${maximumBytes}-byte`} safety limit`);
    }
}
function isBenchListRequest(args) {
    const value = args.trim();
    return !value || value === "list" || value.startsWith("list ");
}
function unavailableDirectAlias(api, agent) {
    return readOpenCodeDirectAliasCollisions(api.state.path.directory)
        .find((collision) => collision.agent === agent)?.alias;
}
function conciseDirectResult(api, command, args, result) {
    assertOpenCodeLifecycleMutationTruth(command, args, result);
    const raw = result.text;
    if (command === "bench" && !isBenchListRequest(args)) {
        const lifecycle = result.lifecycle;
        if (lifecycle?.command !== "bench")
            throw new Error("OpenCode bench lifecycle verification was not retained");
        const rows = lifecycle.rows;
        if (rows.length > 4) {
            const changed = rows.filter(({ status }) => status === "changed").length;
            const shown = rows.slice(0, 8);
            const collisions = new Set();
            const lines = shown.map(({ id, action, status }) => {
                const unavailableAlias = unavailableDirectAlias(api, id);
                if (unavailableAlias)
                    collisions.add(unavailableAlias);
                const outcome = action === "on"
                    ? isOpenCodeAgentLoaded(api, id)
                        ? unavailableAlias
                            ? `ready now · native selection only; foreign /${unavailableAlias} preserved`
                            : `ready now · /${id} <task>`
                        : "reload required · lead blocked until reload"
                    : isOpenCodeAgentConfigured(api, id)
                        ? "invocation blocked · reload removes stale discovery"
                        : "not invocable now";
                return `${status === "changed" ? "✓" : "○"} ${id} · ${action === "on" ? "enabled" : "benched"} · ${outcome}`;
            });
            return wrapPlainLines([
                `Roster mutation verified · ${rows.length} requested · ${changed} changed · ${rows.length - changed} unchanged`,
                `Action: bench ${rows[0]?.action ?? "unknown"}${rows.length > shown.length ? ` · showing 1–${shown.length} of ${rows.length}` : ""}`,
                ...lines,
                ...(rows.length > shown.length ? [`… ${rows.length - shown.length} members omitted; inspect /team roster 1.`] : []),
                ...(rows.some(({ id, action }) => action === "on" && !isOpenCodeAgentLoaded(api, id))
                    ? ["Reload OpenCode once before delegating any row marked reload required."] : []),
                ...(collisions.size ? ["Foreign aliases shown above remain unmanaged and are never Harbor commands."] : []),
                ...(changed === 0 ? ["No roster files changed."] : []),
                "Full roster and capacity: /team roster 1",
            ]).join("\n");
        }
        return wrapPlainLines(rows.flatMap(({ id, action, status }) => {
            const unavailableAlias = unavailableDirectAlias(api, id);
            if (status === "already-current") {
                const unchanged = lifecycle.status === "already-current"
                    ? `○ ${id} is already ${action === "on" ? "enabled" : "benched"} · no roster files changed.`
                    : `○ ${id} is already ${action === "on" ? "enabled" : "benched"} · this member was unchanged.`;
                if (action === "on") {
                    return isOpenCodeAgentLoaded(api, id)
                        ? unavailableAlias
                            ? [
                                unchanged,
                                `Discovery: native ${id} is ready; /${unavailableAlias} is a preserved foreign command. Do not invoke it as Harbor.`,
                                "Team-lead can still delegate this specialist when it is not busy.",
                            ]
                            : [unchanged, `Discovery: ready now · /${id} <task>`]
                        : [
                            unchanged,
                            unavailableAlias
                                ? `Discovery: reload required for native selection and team-lead; /${unavailableAlias} stays foreign and unavailable.`
                                : `Discovery: reload required for native selection, /${id}, and team-lead delegation.`,
                        ];
                }
                return isOpenCodeAgentConfigured(api, id)
                    ? [
                        unchanged,
                        unavailableAlias
                            ? `Discovery: reload removes only the stale native Harbor agent; foreign /${unavailableAlias} remains unmanaged. Do not invoke it as Harbor.`
                            : `Discovery: reload required to remove the stale native agent and /${id} alias; invocation is blocked now.`,
                    ]
                    : [unchanged, "Discovery: this member is not invocable in the current OpenCode session."];
            }
            const loaded = isOpenCodeAgentLoaded(api, id);
            if (action === "on") {
                return loaded
                    ? unavailableAlias
                        ? [
                            `✓ ${id} enabled · ready · invocable through its native agent`,
                            `Foreign /${unavailableAlias} remains unavailable; do not invoke it as Harbor. Team-lead can delegate ${id} when it is not busy.`,
                        ]
                        : [`✓ ${id} enabled · ready · invocable in this OpenCode session`, `Run now: /${id} <task>`]
                    : [
                        `✓ ${id} enabled · reload required for native selection${unavailableAlias ? `; foreign /${unavailableAlias} remains unavailable` : ` and /${id}`}`,
                        "Team-lead delegation remains blocked until OpenCode reloads this definition.",
                        unavailableAlias
                            ? `After reload: select ${id} natively; do not invoke foreign /${unavailableAlias} as Harbor.`
                            : `After reload: /${id} <task>`,
                    ];
            }
            const configured = isOpenCodeAgentConfigured(api, id);
            return configured
                ? [
                    `✓ ${id} benched · reload required to remove stale discovery`,
                    unavailableAlias
                        ? `Invocation is blocked now; reload removes only Harbor native discovery. Foreign /${unavailableAlias} remains unmanaged; do not invoke it as Harbor.`
                        : `Invocation is blocked now; reload removes it from native selection and /${id} autocomplete.`,
                ]
                : [`✓ ${id} benched · not invocable in this OpenCode session`];
        })).join("\n");
    }
    if (command === "retire") {
        const id = args.trim();
        const lifecycle = result.lifecycle;
        if (lifecycle?.command !== "retire")
            throw new Error("OpenCode retire lifecycle verification was not retained");
        const alreadyAbsent = lifecycle.status === "already-current";
        const loaded = isOpenCodeAgentConfigured(api, id);
        const unavailableAlias = unavailableDirectAlias(api, id);
        return wrapPlainLines([
            alreadyAbsent
                ? `○ ${id} already retired · no roster files changed · other projects intentionally untouched`
                : `✓ ${id} retired here · other projects intentionally untouched`,
            ...(loaded
                ? [unavailableAlias
                        ? `Discovery: reload removes only its stale native Harbor agent. Foreign /${unavailableAlias} remains unmanaged; do not invoke it as Harbor.`
                        : `Discovery: reload required to remove its stale native agent and /${id} alias; invocation is blocked now.`]
                : ["Discovery: removed; this member is not invocable in the current OpenCode session."]),
        ]).join("\n");
    }
    if (command === "list-skills")
        return boundedCatalogOutput(raw);
    if (command !== "join")
        return boundedPublicMultiline(raw) ?? "The Agent Harbor action completed.";
    const player = validatePlayer(JSON.parse(args));
    const capacity = openCodePublicLabel([
        ...player.tools,
        ...(player.skills ?? []).map(({ name }) => `skill:${name}`),
    ].join(", "), 500) ?? "advisory";
    const role = openCodePublicLabel(player.description, 240) ?? "Personal Agent Harbor teammate";
    const model = openCodePublicLabel(player.model, 200);
    const loaded = isOpenCodeAgentLoaded(api, player.name, player);
    const unavailableAlias = unavailableDirectAlias(api, player.name);
    const lifecycle = result.lifecycle;
    if (lifecycle?.command !== "join")
        throw new Error("OpenCode join lifecycle verification was not retained");
    const alreadyCurrent = lifecycle.status === "already-current";
    return wrapPlainLines([
        alreadyCurrent
            ? `○ ${player.name} is already joined and current · no roster files changed.`
            : `✓ ${player.name} joined · personal · ${loaded ? "ready · invocable in this OpenCode session" : "enabled · reload required"}`,
        `Role: ${role}`,
        `Capacity: ${capacity}`,
        `Model: ${model ? `configured ${model}` : "inherits the OpenCode host when run"}`,
        unavailableAlias
            ? `${loaded ? "Run now" : "After reload"}: select ${player.name} natively; foreign /${unavailableAlias} is unavailable—do not invoke it as Harbor.`
            : alreadyCurrent && !loaded
                ? `After reload: /${player.name} <task>`
                : `${loaded ? "Run now" : "After reload"}: /${player.name} <task>`,
        ...(loaded ? [] : [
            "Team-lead delegation remains blocked until OpenCode reloads this definition.",
            unavailableAlias
                ? `Reload OpenCode before native selection; /${unavailableAlias} remains a foreign unavailable alias.`
                : "Reload OpenCode before native selection or the /<id> alias uses this definition.",
        ]),
    ]).join("\n");
}
/** Executes one `/team` prompt value without routing through an OpenCode model session. */
export async function runOpenCodeTeamQuery(api, input, options = {}) {
    if (isDisposed(api))
        return;
    const epoch = beginDisplayAction(api);
    const isLatest = () => isLatestDisplayAction(api, epoch);
    const runtimeOptions = { ...options, signal: options.signal ?? api.lifecycle?.signal };
    if (input.length > 4_096 || Buffer.byteLength(input, "utf8") > 4_096) {
        showTeamDialog(api, "Agent Harbor team · query rejected · 0 model tokens", "The /team query exceeds the 4 KiB safety limit.");
        return;
    }
    const query = input.trim();
    const stopQuery = /^stop(?:\s|$)/iu.test(query);
    const diagnosticsQuery = /^(?:diagnostics|warnings)(?:\s|$)/iu.test(query);
    const diagnosticsMatch = /^(?:diagnostics|warnings)(?:\s+(\d{1,6}))?$/iu.exec(query);
    if (["help", "--help", "-h", "?"].includes(query.toLowerCase())) {
        if (isLatest())
            showTeamDialog(api, "Agent Harbor team help · 0 model tokens", formatOpenCodeTeamHelp(readOpenCodeDirectAliasCollisions(api.state.path.directory)));
        return;
    }
    try {
        if (diagnosticsQuery && !diagnosticsMatch) {
            throw new Error("usage: /team diagnostics [page]");
        }
        if (stopQuery) {
            api.ui.toast({ variant: "info", title: "Agent Harbor · 0 model tokens", message: "Reading a bounded OpenCode team snapshot…", duration: 2_000 });
            const selector = query.replace(/^stop\s*/iu, "").trim();
            if (!selector)
                throw new Error("usage inside the /team prompt: stop <run-id|all>");
            if (selector.length > 256 || Buffer.byteLength(selector, "utf8") > 256)
                throw new Error("the /team prompt stop selector exceeds the 256-byte safety limit");
            const result = await enqueueMutation(api, () => stopOpenCodeTeamRuns(api, selector, runtimeOptions));
            const stopIncomplete = result.failed.length > 0 || (result.pendingChildIdentity?.length ?? 0) > 0 ||
                (result.ownedByAnotherProcess?.length ?? 0) > 0 || (result.claimIdentityUnavailable?.length ?? 0) > 0 ||
                (result.ownershipUnavailable?.length ?? 0) > 0 ||
                (result.staleOwnerHeartbeat?.length ?? 0) > 0 || (result.pendingConfirmation?.length ?? 0) > 0 ||
                (result.lifecycleTransition?.length ?? 0) > 0 || (result.nativeRunPending?.length ?? 0) > 0 ||
                (result.engineAuthorityUnavailable?.length ?? 0) > 0;
            snapshotReads.delete(api);
            let refreshMessage = "Post-stop team refresh completed. Run /team to view the current roster and activity.";
            try {
                await sharedTeamSnapshot(api, runtimeOptions);
            }
            catch (error) {
                refreshMessage = `Post-stop team refresh unavailable: ${boundedPublicMultiline(message(error), 600) ?? "unknown host error"}. ${stopIncomplete
                    ? "The recorded outcome remains valid; pending or unattempted work remains unconfirmed. Run /team to refresh."
                    : "The stop result below is still final; run /team to refresh."}`;
            }
            if (!isLatest()) {
                if (!isDisposed(api))
                    api.ui.toast({
                        variant: stopIncomplete ? "warning" : "success",
                        title: `Agent Harbor stop ${stopIncomplete ? "unresolved" : "completed"} · 0 model tokens`,
                        message: boundedPublicMultiline(formatOpenCodeStopResult(result, refreshMessage), 600) ?? "The stop action completed.",
                        duration: 10_000,
                    });
                return;
            }
            showTeamDialog(api, `Agent Harbor team · ${stopIncomplete ? "stop incomplete" : "stop complete"} · 0 model tokens`, formatOpenCodeStopResult(result, refreshMessage));
            return;
        }
        const pendingMutation = mutationTails.get(api);
        if (pendingMutation)
            await pendingMutation.catch(() => undefined);
        if (!isLatest())
            return;
        const joinedExistingRead = snapshotReads.has(api);
        const reading = sharedTeamSnapshot(api, runtimeOptions);
        if (!joinedExistingRead) {
            api.ui.toast({ variant: "info", title: "Agent Harbor · 0 model tokens", message: "Reading a bounded OpenCode team snapshot…", duration: 2_000 });
        }
        const snapshot = await reading;
        if (isLatest())
            showTeamDialog(api, diagnosticsMatch ? "Agent Harbor team diagnostics · 0 model tokens" : "Agent Harbor team · 0 model tokens", diagnosticsMatch
                ? formatOpenCodeTeamDiagnostics(snapshot, diagnosticsMatch[1] ? Number(diagnosticsMatch[1]) : 1)
                : formatOpenCodeTeamView(snapshot, query));
    }
    catch (error) {
        if (!isLatest()) {
            if (stopQuery && !isDisposed(api))
                api.ui.toast({
                    variant: "error",
                    title: "Agent Harbor stop failed · 0 model tokens",
                    message: boundedTeamActionError(error, "The stop action failed."),
                    duration: 10_000,
                });
            return;
        }
        showTeamDialog(api, "Agent Harbor team · action unavailable · 0 model tokens", boundedTeamActionError(error, "The OpenCode team action failed without a public error message."));
    }
}
/** Creates palette commands that call the deterministic backend directly. */
export function openCodeDirectCommands(api) {
    const execute = async (command, args) => {
        if (isDisposed(api))
            return;
        const epoch = beginDisplayAction(api);
        let mutating = false;
        try {
            requireBoundedDirectInput(command, args);
            mutating = command === "join" || command === "retire"
                || command === "bench" && !isBenchListRequest(args);
            const invoke = () => runOpenCodeRosterMutationGate(command, args, api.state.path.directory, () => runDeterministicCommandResult("opencode", command, args, api.state.path.directory, api.lifecycle?.signal, "plain"));
            if (!mutating) {
                const pendingMutation = mutationTails.get(api);
                if (pendingMutation)
                    await pendingMutation.catch(() => undefined);
            }
            const mutate = async () => {
                if (command === "retire") {
                    const memberID = args.trim();
                    const assertInactive = (snapshot) => {
                        if (snapshot.runs.some(({ agent }) => agent === memberID) ||
                            snapshot.reservations.some(({ agent }) => agent === memberID)) {
                            throw new Error(`Cannot retire active member ${memberID}; stop its run or wait for lifecycle cleanup first`);
                        }
                        if (!snapshot.activeAuthoritative) {
                            throw new Error("Cannot retire while authoritative team activity is unavailable; retry /team after OpenCode RPC recovers");
                        }
                    };
                    assertInactive(await sharedTeamSnapshot(api, { signal: api.lifecycle?.signal }));
                    // Re-read authoritative activity immediately before the filesystem
                    // mutation so work that appeared after the displayed preflight fails closed.
                    assertInactive(await collectOpenCodeTeamSnapshot(api, { signal: api.lifecycle?.signal }));
                }
                return invoke();
            };
            const commandResult = mutating ? await enqueueMutation(api, mutate) : await invoke();
            const result = conciseDirectResult(api, command, args, commandResult);
            const changed = commandResult.lifecycle?.status === "changed";
            if (mutating && changed)
                snapshotReads.delete(api);
            if (!isLatestDisplayAction(api, epoch)) {
                if (mutating && !isDisposed(api))
                    api.ui.toast({
                        variant: "success",
                        title: "Agent Harbor mutation completed · 0 model tokens",
                        message: openCodePublicLabel(result, 600) ?? "The mutation completed.",
                        duration: 10_000,
                    });
                return;
            }
            const persistent = mutating || result.includes("\n") || [...result].length > 240
                || command === "list-skills" || command === "bench" && isBenchListRequest(args);
            if (persistent)
                showTeamDialog(api, "Agent Harbor · 0 model tokens", result);
            else
                api.ui.toast({ variant: "success", title: "Agent Harbor · 0 model tokens", message: result, duration: 10_000 });
        }
        catch (error) {
            const publicMessage = boundedPublicMultiline(message(error), 1_000) ?? "Agent Harbor action failed";
            if (!isLatestDisplayAction(api, epoch)) {
                if (mutating && !isDisposed(api))
                    api.ui.toast({
                        variant: "error", title: "Agent Harbor mutation failed · 0 model tokens", message: publicMessage, duration: 10_000,
                    });
                return;
            }
            if (mutating || /safety limit/iu.test(publicMessage) || publicMessage.includes("\n") || [...publicMessage].length > 240) {
                showTeamDialog(api, "Agent Harbor · action failed · 0 model tokens", publicMessage);
            }
            else {
                api.ui.toast({ variant: "error", title: "Agent Harbor · 0 model tokens", message: publicMessage, duration: 10_000 });
            }
        }
    };
    const prompt = (title, placeholder, command, prefix = "") => {
        if (isDisposed(api))
            return;
        beginDisplayAction(api);
        showHarborPrompt(api, title, placeholder, (value) => execute(command, `${prefix}${value}`));
    };
    const executeContract = async (args) => {
        const epoch = displayEpoch.get(api) ?? beginDisplayAction(api);
        try {
            if (args.length > 30_000 || Buffer.byteLength(args, "utf8") > 30_000) {
                throw new Error("/contract input exceeds the 30 KiB safety limit");
            }
            const project = api.state.path.directory;
            const orchestrator = new OpenCodeOrchestrator(openCodeTuiOrchestratorClient(api.client), project);
            const result = await orchestrator.runObserved(parseContractDefinition(args), api.lifecycle?.signal);
            const evidence = boundedContractEvidence(result.text) ?? "The disposable child returned no public text.";
            const output = `${evidence}\n\n${formatContractTelemetry(result.telemetry)}`;
            if (!isLatestDisplayAction(api, epoch)) {
                if (!isDisposed(api))
                    api.ui.toast({
                        variant: "success",
                        title: "Agent Harbor contract completed · exactly 1 model child",
                        message: openCodePublicLabel(output, 600) ?? "The disposable child completed.",
                        duration: 10_000,
                    });
                return;
            }
            showTeamDialog(api, "Agent Harbor contract · exactly 1 model child", output);
        }
        catch (error) {
            const publicMessage = boundedPublicMultiline(message(error), 1_000) ?? "Agent Harbor contract failed";
            if (!isLatestDisplayAction(api, epoch)) {
                if (!isDisposed(api))
                    api.ui.toast({
                        variant: "error", title: "Agent Harbor contract failed", message: publicMessage, duration: 10_000,
                    });
                return;
            }
            showTeamDialog(api, "Agent Harbor contract · failed", publicMessage);
        }
    };
    const metadata = (name, title, desc, slashName, run) => ({
        name: `agent-harbor.${name}`, title, desc, slashName, run, category: "Agent Harbor · direct", namespace: "palette",
    });
    return [
        metadata("team", "Agent Harbor: team status", "Show roster and active work, filter it, get help, or stop verified Harbor runs without a model request.", "team", () => {
            if (isDisposed(api))
                return;
            beginDisplayAction(api);
            showHarborPrompt(api, "Agent Harbor team · 0 model tokens", "filter, help, or stop <run-id|all>; Enter shows all", (value) => runOpenCodeTeamQuery(api, value));
        }),
        metadata("bench-list", "Agent Harbor: view roster", "Show the operational roster, availability, and capacity without a model request.", "bench-list", () => runOpenCodeTeamQuery(api, "roster 1")),
        metadata("bench-on", "Agent Harbor: activate players", "Activate player IDs directly without a model request.", "bench-on", () => prompt("Activate Agent Harbor players", "portfolio-management design, or all", "bench", "on ")),
        metadata("bench-off", "Agent Harbor: deactivate players", "Deactivate player IDs directly without a model request.", "bench-off", () => prompt("Deactivate Agent Harbor players", "build, or all", "bench", "off ")),
        metadata("join", "Agent Harbor: join player", "Register JSON directly without a model request.", "harbor-join", () => prompt("Join an Agent Harbor player", "{\"name\":\"reviewer\",...}", "join")),
        metadata("retire", "Agent Harbor: retire player", "Retire an ID directly without a model request.", "harbor-retire", () => prompt("Retire an Agent Harbor player", "reviewer", "retire")),
        metadata("contract", "Agent Harbor: contract one player", "Run exactly one disposable model child without an ambient model-routed tool.", "contract", () => {
            if (isDisposed(api))
                return;
            beginDisplayAction(api);
            showHarborPrompt(api, "Agent Harbor contract · exactly 1 model child", "{\"name\":\"reviewer\",...,\"task\":\"Review src\"}", executeContract);
        }),
        metadata("skills-list", "Agent Harbor: list trusted skills", "Resolve and list trusted skills without a model request.", "harbor-list-skills", () => execute("list-skills", "")),
        metadata("skills-filter", "Agent Harbor: filter trusted skills", "Filter or page trusted skills directly without a model request.", "harbor-filter-skills", () => prompt("Filter trusted Agent Harbor skills", "zx -d --page 2", "list-skills")),
    ];
}
const plugin = {
    id: "agent-harbor.direct-controls",
    tui: async (api) => {
        disposedApis.delete(api);
        const dispose = api.keymap.registerLayer({ commands: openCodeDirectCommands(api) });
        api.lifecycle?.onDispose(() => {
            beginDisplayAction(api);
            disposedApis.add(api);
            snapshotReads.delete(api);
            clearOwnedHarborDialog(api);
            dispose();
        });
    },
};
/** OpenCode TUI plugin entrypoint. */
export default plugin;
