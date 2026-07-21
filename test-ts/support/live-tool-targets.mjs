import { isAbsolute, relative, resolve, sep } from "node:path";

export const LIVE_FIXTURE_TOOL_TARGETS = Object.freeze([
  "ACCEPTANCE.md",
  "src/score.js",
  "test/score.test.js",
]);

const targetSet = new Set(LIVE_FIXTURE_TOOL_TARGETS);
const pathKeys = ["path", "filePath", "file_path", "filename", "file", "target", "paths"];

function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return [];
}

function normalizedRelativePath(value, projectRoot) {
  let raw = String(value).trim();
  if (!raw) return null;
  if (isAbsolute(raw)) {
    if (!projectRoot) return null;
    const child = relative(resolve(projectRoot), resolve(raw));
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return null;
    raw = child;
  }
  raw = raw.replace(/\\/gu, "/");
  if (/^(?:\/|[A-Za-z]:\/|~(?:\/|$))/u.test(raw)) return null;
  const withoutDot = raw.replace(/^(?:\.\/)+/u, "").replace(/\/{2,}/gu, "/");
  if (!withoutDot || withoutDot === "." || withoutDot.split("/").includes("..")) return null;
  return withoutDot.replace(/\/$/u, "");
}

function classifyPath(value, projectRoot) {
  const normalized = normalizedRelativePath(value, projectRoot);
  return normalized && targetSet.has(normalized) ? normalized : "other";
}

function combine(classes) {
  if (!classes.length) return "none";
  if (classes.includes("multiple")) return "multiple";
  const unique = new Set(classes.filter((value) => value !== "none"));
  if (!unique.size) return "none";
  return unique.size === 1 ? [...unique][0] : "multiple";
}

function directTargets(args, projectRoot) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  return pathKeys.flatMap((key) => strings(args[key])).map((value) => classifyPath(value, projectRoot));
}

function combinedSearchPath(base, selector, projectRoot) {
  const normalizedSelector = normalizedRelativePath(selector, projectRoot);
  if (!normalizedSelector || /[*?\[\]{}]/u.test(normalizedSelector)) return "other";
  const normalizedBase = normalizedRelativePath(base ?? "", projectRoot);
  if (!base || String(base).trim() === ".") return classifyPath(normalizedSelector, projectRoot);
  if (!normalizedBase) return "other";
  return classifyPath(`${normalizedBase}/${normalizedSelector}`, projectRoot);
}

function searchTarget(toolName, args, projectRoot) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "none";
  const base = typeof args.path === "string" ? args.path : undefined;
  const selectors = toolName === "grep"
    ? [...strings(args.glob), ...strings(args.include)]
    : [...strings(args.pattern), ...strings(args.glob), ...strings(args.include)];
  if (selectors.length) return combine(selectors.map((selector) => combinedSearchPath(base, selector, projectRoot)));
  return base === undefined ? "none" : classifyPath(base, projectRoot);
}

function patchTarget(args, projectRoot) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "none";
  const patch = [args.patchText, args.patch, args.diff].find((value) => typeof value === "string");
  if (typeof patch !== "string") return combine(directTargets(args, projectRoot));
  const headers = [...patch.matchAll(/^\*\*\* (?:Add|Delete|Update) File:\s*(.+?)\s*$/gmu)].map((match) => match[1]);
  if (!headers.length) return "other";
  return combine(headers.map((value) => classifyPath(value, projectRoot)));
}

/**
 * Return a closed, non-sensitive classification. Raw arguments remain only in
 * the observer's SHA-256/byte-length fingerprint and are never persisted here.
 */
export function classifyLiveToolTarget(toolName, args, projectRoot) {
  if (["glob", "grep", "find", "search"].includes(toolName)) return searchTarget(toolName, args, projectRoot);
  if (toolName === "apply_patch") return patchTarget(args, projectRoot);
  return combine(directTargets(args, projectRoot));
}
