import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { HarborError, runtimeToolsFor } from "./commands.mjs";

const OWNER = "agent-harbor";
const REVISION = 1;
const MAX_ROSTER_SIZE = 200;
const MAX_PROFILE_TEXT = 30_000;
const MAX_TASK_TEXT = 30_000;
const MAX_MANIFEST_BYTES = 8_000_000;
const PLAYER_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

function fail(code, message, cause) {
  throw new HarborError(code, message, cause === undefined ? {} : { cause });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, required, optional = []) {
  if (!isPlainObject(value)) fail("INVALID_MANAGER_RUN", "The frozen manager run must be one JSON object.");
  const expected = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !expected.has(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    fail("INVALID_MANAGER_RUN", "The frozen manager run contains unexpected or missing fields.");
  }
}

function validateText(value, label, maximum = MAX_PROFILE_TEXT) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    fail("INVALID_MANAGER_RUN", `${label} must be non-empty text no longer than ${maximum} characters.`);
  }
  return value;
}

function validateSessionID(sessionID) {
  if (typeof sessionID !== "string" || sessionID.length === 0 || sessionID.length > 500) {
    fail("INVALID_MANAGER_RUN", "The OpenCode manager session ID is invalid.");
  }
  return sessionID;
}

function runDirectory(directory) {
  if (typeof directory !== "string" || directory.length === 0) {
    fail("INVALID_MANAGER_RUN", "The OpenCode manager directory is invalid.");
  }
  return resolve(directory);
}

function managerRunPath(directory, sessionID) {
  const key = createHash("sha256").update(validateSessionID(sessionID), "utf8").digest("hex");
  return join(runDirectory(directory), ".agent-harbor", "manager-runs", `${key}.json`);
}

function comparablePath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function safeRunParents(directory, { create = false } = {}) {
  const root = runDirectory(directory);
  const rootInformation = await lstatOrNull(root);
  if (!rootInformation?.isDirectory() || rootInformation.isSymbolicLink()) {
    fail("UNSAFE_MANAGER_RUN_PATH", "The OpenCode manager directory must be a real directory, not a link or junction.");
  }
  const canonicalRoot = await realpath(root);
  const parents = [join(root, ".agent-harbor"), join(root, ".agent-harbor", "manager-runs")];
  for (const path of parents) {
    if (create) {
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    const information = await lstatOrNull(path);
    if (information === null) return null;
    if (!information.isDirectory() || information.isSymbolicLink()) {
      fail("UNSAFE_MANAGER_RUN_PATH", "Agent Harbor refuses a manager-run path containing a link, junction, or non-directory parent.");
    }
    const relativeSuffix = path.slice(root.length).replace(/^[\\/]+/, "");
    const expected = join(canonicalRoot, relativeSuffix);
    const actual = await realpath(path);
    if (comparablePath(actual) !== comparablePath(expected)) {
      fail("UNSAFE_MANAGER_RUN_PATH", "Agent Harbor refuses a manager-run path redirected outside the project.");
    }
  }
  return parents.at(-1);
}

function freezeProfile(value) {
  requireExactKeys(value, ["id", "description", "prompt", "tools"]);
  if (typeof value.id !== "string" || !PLAYER_ID.test(value.id)) {
    fail("INVALID_MANAGER_RUN", "A frozen manager player ID is invalid.");
  }
  const tools = runtimeToolsFor("opencode", value.tools);
  return Object.freeze({
    id: value.id,
    description: validateText(value.description, `Description for ${value.id}`),
    prompt: validateText(value.prompt, `Prompt for ${value.id}`),
    tools: Object.freeze([...value.tools]),
    permissions: Object.freeze([...tools]),
  });
}

function frozenPayload(directory, sessionID, request) {
  if (!isPlainObject(request) || request.runtime !== "opencode" || !Array.isArray(request.roster)) {
    fail("INVALID_MANAGER_RUN", "OpenCode received an invalid frozen manager request.");
  }
  if (request.roster.length === 0 || request.roster.length > MAX_ROSTER_SIZE) {
    fail("INVALID_MANAGER_RUN", "The frozen manager roster must contain one to 200 players.");
  }
  if (typeof request.dynamicAgents !== "boolean" || !Array.isArray(request.activeAgentIds)) {
    fail("INVALID_MANAGER_RUN", "The frozen manager request is missing its exact roster state.");
  }

  const roster = request.roster.map(({ id, description, prompt, tools }) => freezeProfile({ id, description, prompt, tools }));
  const ids = roster.map(({ id }) => id);
  if (new Set(ids).size !== ids.length
    || request.activeAgentIds.length !== ids.length
    || ids.some((id, index) => request.activeAgentIds[index] !== id)) {
    fail("INVALID_MANAGER_RUN", "The frozen manager roster does not match its exact active player IDs.");
  }

  return {
    owner: OWNER,
    revision: REVISION,
    sessionID: validateSessionID(sessionID),
    directory: runDirectory(directory),
    dynamicAgents: request.dynamicAgents,
    activeAgentIds: ids,
    roster: roster.map(({ id, description, prompt, tools }) => ({ id, description, prompt, tools: [...tools] })),
  };
}

function digestPayload(payload) {
  // This detects torn/accidental mutation. Authority comes from the exclusive
  // 0400 file, session+directory binding, link-safe parents, and a manager that
  // has no filesystem tools; the digest is intentionally not treated as a MAC.
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function validateEnvelope(value, directory, sessionID) {
  requireExactKeys(value, [
    "owner", "revision", "sessionID", "directory", "dynamicAgents", "activeAgentIds", "roster", "digest",
  ]);
  const { digest, ...payload } = value;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) || digestPayload(payload) !== digest) {
    fail("INVALID_MANAGER_RUN", "The frozen manager run failed its integrity check.");
  }
  if (payload.owner !== OWNER || payload.revision !== REVISION
    || payload.sessionID !== validateSessionID(sessionID)
    || payload.directory !== runDirectory(directory)) {
    fail("INVALID_MANAGER_RUN", "The frozen manager run is not bound to this OpenCode session and directory.");
  }
  const request = {
    runtime: "opencode",
    dynamicAgents: payload.dynamicAgents,
    activeAgentIds: payload.activeAgentIds,
    roster: payload.roster,
  };
  const validated = frozenPayload(directory, sessionID, request);
  return Object.freeze({
    ...validated,
    activeAgentIds: Object.freeze([...validated.activeAgentIds]),
    roster: Object.freeze(validated.roster.map((profile) => freezeProfile(profile))),
  });
}

export function managerPermissions({ dynamicAgents }) {
  if (typeof dynamicAgents !== "boolean") fail("INVALID_MANAGER_RUN", "The manager dynamic-agent setting is invalid.");
  return [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "harbor_delegate", pattern: "*", action: "allow" },
    ...(dynamicAgents
      ? [
          { permission: "harbor_list_skills", pattern: "*", action: "allow" },
          { permission: "harbor_contract", pattern: "*", action: "allow" },
        ]
      : []),
  ];
}

export async function writeManagerRun(directory, sessionID, request) {
  const payload = frozenPayload(directory, sessionID, request);
  const bytes = Buffer.from(`${JSON.stringify({ ...payload, digest: digestPayload(payload) })}\n`, "utf8");
  if (bytes.length > MAX_MANIFEST_BYTES) fail("INVALID_MANAGER_RUN", "The frozen manager run is too large.");

  await safeRunParents(directory, { create: true });
  const path = managerRunPath(directory, sessionID);
  let handle;
  let created = false;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow, 0o600);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o400).catch(() => undefined);
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await unlink(path).catch(() => undefined);
    fail("MANAGER_RUN_WRITE_FAILED", "Could not persist the frozen OpenCode manager run.", error);
  }
  return path;
}

export async function readManagerRun(directory, sessionID) {
  if (await safeRunParents(directory) === null) {
    fail("MANAGER_RUN_MISSING", "No frozen manager run is bound to this OpenCode session.");
  }
  const path = managerRunPath(directory, sessionID);
  const targetInformation = await lstatOrNull(path);
  if (targetInformation === null) {
    fail("MANAGER_RUN_MISSING", "No frozen manager run is bound to this OpenCode session.");
  }
  if (!targetInformation.isFile() || targetInformation.isSymbolicLink() || targetInformation.size > MAX_MANIFEST_BYTES) {
    fail("INVALID_MANAGER_RUN", "The frozen OpenCode manager run must be a small regular file, not a link.");
  }
  let handle;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === "ENOENT") fail("MANAGER_RUN_MISSING", "No frozen manager run is bound to this OpenCode session.");
    fail("INVALID_MANAGER_RUN", "Could not inspect the frozen OpenCode manager run.", error);
  }

  let raw;
  try {
    const information = await handle.stat();
    if (!information.isFile() || information.size > MAX_MANIFEST_BYTES) {
      fail("INVALID_MANAGER_RUN", "The frozen OpenCode manager run must be a small regular file.");
    }
    raw = await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if (error instanceof HarborError) throw error;
    fail("INVALID_MANAGER_RUN", "Could not read the frozen OpenCode manager run.", error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (error) {
    fail("INVALID_MANAGER_RUN", "The frozen OpenCode manager run is not valid JSON.", error);
  }
  return validateEnvelope(envelope, directory, sessionID);
}

export async function deleteManagerRun(directory, sessionID) {
  if (await safeRunParents(directory) === null) return;
  const path = managerRunPath(directory, sessionID);
  const information = await lstatOrNull(path);
  if (information === null) return;
  if (!information.isFile() || information.isSymbolicLink()) {
    fail("UNSAFE_MANAGER_RUN_PATH", "Agent Harbor refuses to delete a linked or non-file manager run.");
  }
  await unlink(path);
}

export async function consumeManagerRun(directory, sessionID) {
  const run = await readManagerRun(directory, sessionID);
  await deleteManagerRun(directory, sessionID);
  return run;
}

function managerRunKey({ directory, sessionID }) {
  return `${validateSessionID(sessionID)}\u0000${runDirectory(directory)}`;
}

export function createManagerRunCache() {
  const cached = new Map();
  const pending = new Map();

  return Object.freeze({
    async get(context) {
      const key = managerRunKey(context);
      if (cached.has(key)) return cached.get(key);
      if (pending.has(key)) return pending.get(key).promise;

      const entry = { cancelled: false };
      entry.promise = consumeManagerRun(context.directory, context.sessionID)
        .then((run) => {
          if (entry.cancelled) {
            fail("MANAGER_SESSION_CLOSED", "The OpenCode manager session closed while its frozen run was being consumed.");
          }
          cached.set(key, run);
          return run;
        })
        .finally(() => {
          if (pending.get(key) === entry) pending.delete(key);
        });
      pending.set(key, entry);
      return entry.promise;
    },
    delete(context) {
      const key = managerRunKey(context);
      cached.delete(key);
      const entry = pending.get(key);
      if (entry) entry.cancelled = true;
    },
  });
}

function responseText(response) {
  const parts = response?.data?.parts ?? response?.parts ?? [];
  const text = parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text || response?.data?.info?.content || "Player finished without a text response.";
}

export async function runFrozenManagerDelegate(client, context, run, args) {
  requireExactKeys(args, ["agent", "task"]);
  if (typeof args.agent !== "string" || !PLAYER_ID.test(args.agent)) {
    fail("INVALID_MANAGER_DELEGATION", "The delegated player ID is invalid.");
  }
  validateText(args.task, "Delegated task", MAX_TASK_TEXT);

  if (!Object.isFrozen(run)
    || run.sessionID !== validateSessionID(context.sessionID)
    || run.directory !== runDirectory(context.directory)
    || !Object.isFrozen(run.roster)
    || run.roster.some((profile) => !Object.isFrozen(profile) || !Object.isFrozen(profile.permissions))) {
    fail("INVALID_MANAGER_CACHE", "Delegation requires the exact frozen run cached for this OpenCode manager session.");
  }
  const profile = run.roster.find(({ id }) => id === args.agent);
  if (!profile) {
    throw new HarborError("INACTIVE_PLAYER", `The manager cannot delegate to inactive player ${JSON.stringify(args.agent)}.`);
  }

  const created = await client.session.create({
    directory: run.directory,
    parentID: context.sessionID,
    title: `Agent Harbor player: ${profile.id}`,
    permission: [
      { permission: "*", pattern: "*", action: "deny" },
      ...profile.permissions.map((permission) => ({ permission, pattern: "*", action: "allow" })),
    ],
  });
  if (created?.error) throw new Error(String(created.error?.message ?? created.error));
  const sessionID = created?.data?.id ?? created?.id;
  if (!sessionID) throw new Error("OpenCode did not return a delegated player session ID.");

  try {
    const response = await client.session.prompt({
      sessionID,
      directory: run.directory,
      system: profile.prompt,
      parts: [{ type: "text", text: args.task }],
    });
    if (response?.error) throw new Error(String(response.error?.message ?? response.error));
    return responseText(response);
  } finally {
    await client.session.delete({ sessionID, directory: run.directory }).catch(() => undefined);
  }
}
