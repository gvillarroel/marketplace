/** Small terminal-layout helpers shared by deterministic human-readable views. */
export const terminalLineWidth = 96;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emojiGrapheme = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3|\ufe0f/u;
const onlyZeroWidthCharacters = /^[\p{Cc}\p{Cf}\p{Mark}\ufe00-\ufe0f\u{e0100}-\u{e01ef}]+$/u;
function isWideCodePoint(codePoint) {
    return codePoint >= 0x1100 && (codePoint <= 0x115f
        || codePoint === 0x2329
        || codePoint === 0x232a
        || (codePoint >= 0x2e80 && codePoint <= 0x303e)
        || (codePoint >= 0x3040 && codePoint <= 0xa4cf)
        || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
        || (codePoint >= 0xf900 && codePoint <= 0xfaff)
        || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
        || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
        || (codePoint >= 0xff00 && codePoint <= 0xff60)
        || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
        || (codePoint >= 0x1b000 && codePoint <= 0x1b2ff)
        || (codePoint >= 0x1f200 && codePoint <= 0x1f251)
        || (codePoint >= 0x20000 && codePoint <= 0x3fffd));
}
function graphemeWidth(value) {
    if (!value || onlyZeroWidthCharacters.test(value))
        return 0;
    if (emojiGrapheme.test(value))
        return 2;
    for (const point of value) {
        const codePoint = point.codePointAt(0);
        if (isWideCodePoint(codePoint))
            return 2;
    }
    return 1;
}
function controlStringEnd(value, start, allowBell) {
    for (let index = start; index < value.length; index += 1) {
        if (allowBell && value.charCodeAt(index) === 0x07)
            return index + 1;
        if (value.charCodeAt(index) === 0x1b && value[index + 1] === "\\")
            return index + 2;
        if (value.charCodeAt(index) === 0x9c)
            return index + 1;
    }
    return undefined;
}
function csiEnd(value, start) {
    for (let index = start; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e)
            return index + 1;
    }
    return undefined;
}
function shortEscapeEnd(value, start) {
    const first = value.charCodeAt(start);
    if (Number.isNaN(first))
        return undefined;
    if (first >= 0x20 && first <= 0x2f) {
        for (let index = start + 1; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            if (code >= 0x30 && code <= 0x7e)
                return index + 1;
        }
        return undefined;
    }
    return Math.min(value.length, start + 1);
}
/** Identifies one ANSI/ECMA-48 control sequence without accepting an unterminated introducer. */
function ansiSequence(value, index) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
        const next = value.charCodeAt(index + 1);
        if (Number.isNaN(next))
            return { incompleteIntroducerEnd: index + 1 };
        if (next === 0x5b)
            return { end: csiEnd(value, index + 2), incompleteIntroducerEnd: index + 2 }; // CSI: ESC [
        if (next === 0x5d)
            return { end: controlStringEnd(value, index + 2, true), incompleteIntroducerEnd: index + 2 }; // OSC: ESC ]
        if ([0x50, 0x58, 0x5e, 0x5f].includes(next)) {
            return { end: controlStringEnd(value, index + 2, false), incompleteIntroducerEnd: index + 2 }; // DCS/SOS/PM/APC
        }
        return { end: shortEscapeEnd(value, index + 1), incompleteIntroducerEnd: index + 1 };
    }
    if (code === 0x9b)
        return { end: csiEnd(value, index + 1), incompleteIntroducerEnd: index + 1 };
    if (code === 0x9d)
        return { end: controlStringEnd(value, index + 1, true), incompleteIntroducerEnd: index + 1 };
    if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) {
        return { end: controlStringEnd(value, index + 1, false), incompleteIntroducerEnd: index + 1 };
    }
    return undefined;
}
function terminalTokens(value) {
    const tokens = [];
    let textStart = 0;
    const pushText = (text) => {
        for (const { segment } of graphemes.segment(text))
            tokens.push({ value: segment, width: graphemeWidth(segment) });
    };
    for (let index = 0; index < value.length;) {
        const sequence = ansiSequence(value, index);
        if (!sequence) {
            index += value.codePointAt(index) > 0xffff ? 2 : 1;
            continue;
        }
        if (textStart < index)
            pushText(value.slice(textStart, index));
        if (sequence.end !== undefined)
            tokens.push({ value: value.slice(index, sequence.end), width: 0 });
        index = sequence.end ?? sequence.incompleteIntroducerEnd;
        textStart = index;
    }
    if (textStart < value.length)
        pushText(value.slice(textStart));
    return tokens;
}
/** Counts terminal columns after treating ANSI controls as zero-width units. */
export function visibleTextWidth(value) {
    return terminalTokens(value).reduce((sum, token) => sum + token.width, 0);
}
/** Splits at a terminal-column boundary without cutting a grapheme or ANSI sequence. */
export function takeTerminalColumns(value, count) {
    const tokens = terminalTokens(value);
    let prefix = "";
    let pendingControls = "";
    let used = 0;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.width === 0) {
            pendingControls += token.value;
            continue;
        }
        if (used + token.width > count) {
            return [prefix, pendingControls + tokens.slice(index).map(({ value: part }) => part).join("")];
        }
        prefix += pendingControls + token.value;
        pendingControls = "";
        used += token.width;
    }
    return [prefix + pendingControls, ""];
}
/**
 * Wraps plain text at a bounded terminal width. Existing leading indentation is
 * retained and continuation lines receive two more spaces. Long unbroken
 * identifiers are hard-wrapped so hostile/provider metadata cannot widen UI.
 */
export function wrapPlainLine(line, width = terminalLineWidth) {
    const safeWidth = Math.max(2, Math.floor(width));
    const safeLine = terminalTokens(line).map(({ value }) => value).join("");
    if (visibleTextWidth(safeLine) <= safeWidth || !safeLine)
        return [safeLine];
    const rawIndent = /^\s*/u.exec(safeLine)?.[0] ?? "";
    const indentBudget = Math.max(0, safeWidth - 2);
    const [baseIndent] = takeTerminalColumns(rawIndent, indentBudget);
    const [continuationIndent] = takeTerminalColumns(`${baseIndent}  `, indentBudget);
    const words = safeLine.trim().split(/\s+/u);
    const output = [];
    let current = baseIndent;
    const flush = () => {
        if (current.trim())
            output.push(current.trimEnd());
        current = continuationIndent;
    };
    for (let word of words) {
        while (word) {
            const separator = current.trim() ? " " : "";
            const available = safeWidth - visibleTextWidth(current) - separator.length;
            if (available <= 0) {
                flush();
                continue;
            }
            if (visibleTextWidth(word) <= available) {
                current += `${separator}${word}`;
                word = "";
                continue;
            }
            if (current.trim()) {
                flush();
                continue;
            }
            const [chunk, remainder] = takeTerminalColumns(word, available);
            current += chunk;
            word = remainder;
            flush();
        }
    }
    if (current.trim())
        output.push(current.trimEnd());
    return output.length ? output : [""];
}
export function wrapPlainLines(lines, width = terminalLineWidth) {
    return lines.flatMap((line) => wrapPlainLine(line, width));
}
export function wrapPlainText(text, width = terminalLineWidth) {
    return wrapPlainLines(text.split(/\r?\n/gu), width).join("\n");
}
