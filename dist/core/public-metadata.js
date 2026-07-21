/** Conservative redaction for process-local, user-visible Agent Harbor metadata. */
const commonRelativeRoots = "app|apps|build|config|configs|dist|docs?|home|lib|packages?|plugins?|scripts?|src|test|test-ts|tests?|tmp|users|var|workspace";
const commonFileExtensions = "cjs|conf|css|csv|env|go|html|ini|java|js|json|jsx|md|mjs|php|ps1|py|rb|rs|sh|sql|toml|ts|tsx|txt|xml|yaml|yml";
// Redaction is intentionally richer than truncation, but public labels must
// never run every regular expression over an attacker-sized prompt. This
// window is large enough to produce the longest supported label while keeping
// work and transient allocations independent of the full prompt size.
const maximumTaskRedactionCodePoints = 4_096;
function boundedPublicInput(value) {
    const points = [];
    let truncated = false;
    for (const point of value) {
        if (points.length === maximumTaskRedactionCodePoints) {
            truncated = true;
            break;
        }
        points.push(point);
    }
    return { text: points.join(""), truncated };
}
function normalizeBoundedPublicMetadata(input, maximumCodePoints) {
    const normalized = redactPublicMetadata(input.text)
        .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
        .trim();
    if (!normalized)
        return undefined;
    const points = [...normalized];
    return points.length <= maximumCodePoints && !input.truncated
        ? normalized
        : `${points.slice(0, Math.max(0, maximumCodePoints - 1)).join("")}…`;
}
const namedCredentialNames = "(?:[A-Za-z][A-Za-z0-9]*_)+(?:TOKEN|SECRET|KEY(?:_ID)?|PASSWORD)|" +
    "(?:DATABASE|DB|REDIS|MONGO(?:DB)?|POSTGRES(?:QL)?|MYSQL)_URL|" +
    "PASSWORD|PASSWD|PWD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY(?:_ID)?";
const doubleQuotedCredential = new RegExp(`\\b(${namedCredentialNames})\\b\\s*[:=]\\s*"(?:\\\\[^\\r\\n]|[^"\\r\\n])*(?:"|$)`, "gimu");
const singleQuotedCredential = new RegExp(`\\b(${namedCredentialNames})\\b\\s*[:=]\\s*'(?:\\\\[^\\r\\n]|[^'\\r\\n])*(?:'|$)`, "gimu");
const unquotedCredential = new RegExp(`\\b(${namedCredentialNames})\\b\\s*[:=]\\s*[^\\s,;]+`, "giu");
/**
 * Removes common paths, URLs, credentials, and high-confidence token shapes.
 * This is deliberately heuristic: callers must not present it as a universal
 * secret detector or persist the input merely because this function was used.
 */
export function redactPublicMetadata(value) {
    return value
        // Private-key material is consumed before named values so a multi-line
        // block cannot be partially exposed after its assignment prefix.
        .replace(/-----BEGIN (?:[A-Z0-9]+ ){0,8}PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ ){0,8}PRIVATE KEY-----|$)/gu, "[redacted-private-key]")
        // Named credentials come first so their public key remains useful while
        // quoted values and URI-looking values never reach a later partial match.
        // Quoted forms allow escaped quotes; malformed/unclosed values consume
        // the rest of that line instead of leaking a secret suffix.
        .replace(doubleQuotedCredential, (_match, name) => `${name}=[redacted]`)
        .replace(singleQuotedCredential, (_match, name) => `${name}=[redacted]`)
        .replace(unquotedCredential, (_match, name) => `${name}=[redacted]`)
        .replace(/\b(?:authorization\s*:\s*)?(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]{8,}/giu, "[redacted]")
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted]")
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/giu, "[redacted]")
        .replace(/\bnpm_[A-Za-z0-9]{20,}\b/gu, "[redacted]")
        .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu, "[redacted]")
        .replace(/\b(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}\b/gu, "[redacted]")
        .replace(/\b(?:sk|pk|api|token|secret|key)[-_][A-Za-z0-9_-]{12,}\b/giu, "[redacted]")
        // A credentialed URI must be consumed as one unit before generic URLs.
        .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s"'`]+/gu, "[url]")
        .replace(/\bfile:(?:\/\/)?[^\s"'`]+/giu, "[path]")
        .replace(/https?:\/\/\S+/giu, "[url]")
        // Absolute paths: UNC, slash-UNC, drive paths with either separator, and
        // POSIX/home forms. Run these before relative-path heuristics.
        .replace(/(^|[\s"'`(])(?:\\\\|\/\/)[^\\/\s"'`]+(?:[\\/][^\\/\s"'`]+)+/gu, "$1[path]")
        .replace(/\b[A-Za-z]:[\\/](?:[^\s"'`<>|]+[\\/]?)+/gu, "[path]")
        .replace(/(^|[\s"'`(])\/(?:[\p{L}\p{N}\p{M}._~-]+\/)*[\p{L}\p{N}\p{M}._~-]+(?=$|[\s"'`,.;:!?)}\]])/gu, "$1[path]")
        .replace(/(^|[\s"'`(])~[\\/](?:[^\s"'`\\/()]+[\\/])*[^\s"'`()]*/gu, "$1[path]")
        .replace(/(^|[\s"'`(])\.{1,2}[\\/](?:[^\s"'`\\/()]+[\\/])*[^\s"'`()]+/gu, "$1[path]")
        // Relative paths are redacted only when they have a familiar root or a
        // file extension. This avoids destroying ordinary prose such as “and/or”.
        .replace(new RegExp(`(^|[\\s"'\\x60(])(?:${commonRelativeRoots})[\\\\/](?:[\\p{L}\\p{N}\\p{M}_.-]+[\\\\/])*[\\p{L}\\p{N}\\p{M}_.-]+(?=$|[\\s"'\\x60,.;:!?)}\\]])`, "giu"), "$1[path]")
        .replace(new RegExp(`(^|[\\s"'\\x60(])(?:[\\p{L}\\p{N}\\p{M}_.-]+[\\\\/])+(?:[\\p{L}\\p{N}\\p{M}_.-]+\\.)+(?:${commonFileExtensions})(?=$|[\\s"'\\x60,.;:!?)}\\]])`, "giu"), "$1[path]");
}
/** Redacts and bounds arbitrary public metadata without scanning an unbounded input. */
export function publicMetadataText(value, maximumCodePoints = 500) {
    if (!Number.isInteger(maximumCodePoints) || maximumCodePoints < 1 || maximumCodePoints > 1_000) {
        throw new Error("public metadata limit must be an integer between 1 and 1000");
    }
    return normalizeBoundedPublicMetadata(boundedPublicInput(value), maximumCodePoints);
}
/** Public error text that keeps actionable Agent Harbor slash commands intact. */
export function publicErrorText(value, maximumCodePoints = 600, additionalCommands = []) {
    if (!Number.isInteger(maximumCodePoints) || maximumCodePoints < 1 || maximumCodePoints > 1_000) {
        throw new Error("public metadata limit must be an integer between 1 and 1000");
    }
    const input = boundedPublicInput(value);
    const commandsToProtect = [...new Set([
            "bench", "contract", "join", "list-skills", "player", "reload", "retire", "scout", "team",
            ...additionalCommands.flatMap((command) => {
                const name = command.startsWith("/") ? command.slice(1) : command;
                return /^[a-z0-9-]{1,48}$/u.test(name) ? [name] : [];
            }),
        ])];
    if (commandsToProtect.length > 32)
        throw new Error("too many public slash commands to protect");
    const commandPattern = new RegExp(`/(?:${commandsToProtect.join("|")})(?=$|[\\s,.;:!?)}\\]])`, "gu");
    const commands = [];
    const occupiedMarkers = new Set(input.text);
    let nextMarker = 0xe000;
    const protectedValue = input.text.replace(commandPattern, (command) => {
        while (occupiedMarkers.has(String.fromCodePoint(nextMarker)))
            nextMarker += 1;
        if (nextMarker > 0xf8ff)
            throw new Error("public command marker space exhausted");
        const marker = String.fromCodePoint(nextMarker);
        nextMarker += 1;
        commands.push({ marker, command });
        return marker;
    });
    let result = normalizeBoundedPublicMetadata({ text: protectedValue, truncated: input.truncated }, maximumCodePoints);
    if (!result)
        return undefined;
    for (const { marker, command } of commands) {
        result = result.replaceAll(marker, command);
    }
    return result;
}
/** Produces a bounded, control-free task label for local observability views. */
export function publicTaskLabel(task, maximumCodePoints = 72) {
    return publicMetadataText(task, maximumCodePoints) ?? "(task not disclosed)";
}
