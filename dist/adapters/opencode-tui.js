import { validatePlayer } from "../core/lifecycle.js";
import { wrapPlainLines } from "../core/text-layout.js";
import { runDeterministicCommand } from "./direct.js";
import { collectOpenCodeTeamSnapshot, isOpenCodeAgentConfigured, isOpenCodeAgentLoaded, openCodePublicLabel, stopOpenCodeTeamRuns, } from "./opencode-team-runtime.js";
import { formatOpenCodeStopResult, formatOpenCodeTeamHelp, formatOpenCodeTeamView, } from "./opencode-team-view.js";
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
const displayEpoch = new WeakMap();
const disposedApis = new WeakSet();
const harborDialogState = new WeakMap();
const mutationTails = new WeakMap();
const snapshotReads = new WeakMap();
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
        return openCodePublicLabel(line, 1_000) ?? "";
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
function requireBoundedDirectInput(command, args) {
    const maximumBytes = command === "join" ? 30_000 : command === "retire" ? 256 : 4_096;
    if (args.length > maximumBytes || Buffer.byteLength(args, "utf8") > maximumBytes) {
        const label = command === "list-skills" ? "/harbor-filter-skills" : `/harbor-${command}`;
        throw new Error(`${label} input exceeds the ${maximumBytes === 30_000 ? "30 KiB" : `${maximumBytes}-byte`} safety limit`);
    }
}
function benchMutationRows(raw) {
    return raw.split(/\r?\n/gu).flatMap((line) => {
        const match = /^([a-z0-9-]+): turned (on|off)$/u.exec(line.trim());
        return match ? [{ id: match[1], action: match[2] }] : [];
    });
}
function conciseDirectResult(api, command, args, raw) {
    if (command === "bench" && !args.trim().startsWith("list")) {
        const rows = benchMutationRows(raw);
        if (!rows.length)
            return boundedPublicMultiline(raw) ?? "The Agent Harbor bench action completed.";
        return wrapPlainLines(rows.flatMap(({ id, action }) => {
            const loaded = isOpenCodeAgentLoaded(api, id);
            if (action === "on") {
                return loaded
                    ? [`✓ ${id} enabled · ready · invocable in this OpenCode session`, `Run now: /${id} <task>`]
                    : [
                        `✓ ${id} enabled · reload required for native selection and /${id}`,
                        "Team-lead delegation can discover it now through live preflight.",
                        `After reload: /${id} <task>`,
                    ];
            }
            const configured = isOpenCodeAgentConfigured(api, id);
            return configured
                ? [
                    `✓ ${id} benched · reload required to remove stale discovery`,
                    `Invocation is blocked now; reload removes it from native selection and /${id} autocomplete.`,
                ]
                : [`✓ ${id} benched · not invocable in this OpenCode session`];
        })).join("\n");
    }
    if (command === "retire") {
        const id = args.trim();
        const loaded = isOpenCodeAgentConfigured(api, id);
        return wrapPlainLines([
            `✓ ${id} retired here · other projects intentionally untouched`,
            ...(loaded
                ? [`Discovery: reload required to remove its stale native agent and /${id} alias; invocation is blocked now.`]
                : ["Discovery: removed; this member is not invocable in the current OpenCode session."]),
        ]).join("\n");
    }
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
    return wrapPlainLines([
        `✓ ${player.name} joined · personal · ${loaded ? "ready · invocable in this OpenCode session" : "enabled · reload required"}`,
        `Role: ${role}`,
        `Capacity: ${capacity}`,
        `Model: ${model ? `configured ${model}` : "inherits the OpenCode host when run"}`,
        `${loaded ? "Run now" : "After reload"}: /${player.name} <task>`,
        ...(loaded ? [] : [
            "Team-lead delegation can discover this enabled definition now through live preflight.",
            "Reload OpenCode before native selection or the /<id> alias uses this definition.",
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
        showTeamDialog(api, "Agent Harbor team · query rejected", "The /team query exceeds the 4 KiB safety limit.");
        return;
    }
    const query = input.trim();
    const stopQuery = /^stop(?:\s|$)/iu.test(query);
    if (["help", "--help", "-h", "?"].includes(query.toLowerCase())) {
        if (isLatest())
            showTeamDialog(api, "Agent Harbor team help · 0 model tokens", formatOpenCodeTeamHelp());
        return;
    }
    try {
        if (stopQuery) {
            api.ui.toast({ variant: "info", title: "Agent Harbor · 0 model tokens", message: "Reading a bounded OpenCode team snapshot…", duration: 2_000 });
            const selector = query.replace(/^stop\s*/iu, "").trim();
            if (!selector)
                throw new Error("usage: /team stop <run-id|all>");
            if (selector.length > 256 || Buffer.byteLength(selector, "utf8") > 256)
                throw new Error("/team stop selector exceeds the 256-byte safety limit");
            const result = await enqueueMutation(api, () => stopOpenCodeTeamRuns(api, selector, runtimeOptions));
            snapshotReads.delete(api);
            let refreshMessage = "Post-stop team refresh completed. Run /team to view the current roster and activity.";
            try {
                await sharedTeamSnapshot(api, runtimeOptions);
            }
            catch (error) {
                refreshMessage = `Post-stop team refresh unavailable: ${boundedPublicMultiline(message(error), 600) ?? "unknown host error"}. The stop result below is still final; run /team to refresh.`;
            }
            if (!isLatest()) {
                if (!isDisposed(api))
                    api.ui.toast({
                        variant: result.failed.length ? "warning" : "success",
                        title: "Agent Harbor stop completed · 0 model tokens",
                        message: boundedPublicMultiline(`${formatOpenCodeStopResult(result)}\n${refreshMessage}`, 600) ?? "The stop action completed.",
                        duration: 10_000,
                    });
                return;
            }
            showTeamDialog(api, `Agent Harbor team · ${result.failed.length ? "stop incomplete" : "stop complete"}`, `${formatOpenCodeStopResult(result)}\n\n${refreshMessage}`);
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
            showTeamDialog(api, "Agent Harbor team · 0 model tokens", formatOpenCodeTeamView(snapshot, query));
    }
    catch (error) {
        if (!isLatest()) {
            if (stopQuery && !isDisposed(api))
                api.ui.toast({
                    variant: "error",
                    title: "Agent Harbor stop failed",
                    message: openCodePublicLabel(message(error), 600) ?? "The stop action failed.",
                    duration: 10_000,
                });
            return;
        }
        showTeamDialog(api, "Agent Harbor team · action unavailable", openCodePublicLabel(message(error), 600) ?? "The OpenCode team action failed without a public error message.");
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
                || command === "bench" && !args.trim().startsWith("list");
            const invoke = () => runDeterministicCommand("opencode", command, args, api.state.path.directory, api.lifecycle?.signal, "plain");
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
            const rawResult = mutating ? await enqueueMutation(api, mutate) : await invoke();
            const result = conciseDirectResult(api, command, args, rawResult);
            if (mutating)
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
                || command === "list-skills" || command === "bench" && args.trim().startsWith("list");
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
                        variant: "error", title: "Agent Harbor mutation failed", message: publicMessage, duration: 10_000,
                    });
                return;
            }
            if (mutating || /safety limit/iu.test(publicMessage) || publicMessage.includes("\n") || [...publicMessage].length > 240) {
                showTeamDialog(api, "Agent Harbor · action failed", publicMessage);
            }
            else {
                api.ui.toast({ variant: "error", title: "Agent Harbor", message: publicMessage, duration: 10_000 });
            }
        }
    };
    const prompt = (title, placeholder, command, prefix = "") => {
        if (isDisposed(api))
            return;
        beginDisplayAction(api);
        showHarborPrompt(api, title, placeholder, (value) => execute(command, `${prefix}${value}`));
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
        metadata("bench-list", "Agent Harbor: view bench", "List the bench directly without a model request.", "bench-list", () => execute("bench", "list")),
        metadata("bench-on", "Agent Harbor: activate players", "Activate player IDs directly without a model request.", "bench-on", () => prompt("Activate Agent Harbor players", "portfolio-management design, or all", "bench", "on ")),
        metadata("bench-off", "Agent Harbor: deactivate players", "Deactivate player IDs directly without a model request.", "bench-off", () => prompt("Deactivate Agent Harbor players", "build, or all", "bench", "off ")),
        metadata("join", "Agent Harbor: join player", "Register JSON directly without a model request.", "harbor-join", () => prompt("Join an Agent Harbor player", "{\"name\":\"reviewer\",...}", "join")),
        metadata("retire", "Agent Harbor: retire player", "Retire an ID directly without a model request.", "harbor-retire", () => prompt("Retire an Agent Harbor player", "reviewer", "retire")),
        metadata("skills-list", "Agent Harbor: list trusted skills", "Resolve and list trusted skills without a model request.", "harbor-list-skills", () => execute("list-skills", "")),
        metadata("skills-filter", "Agent Harbor: filter trusted skills", "Filter trusted skills directly without a model request.", "harbor-filter-skills", () => prompt("Filter trusted Agent Harbor skills", "zx", "list-skills")),
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
