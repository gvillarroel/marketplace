/** Small terminal-layout helpers shared by deterministic human-readable views. */
export declare const terminalLineWidth = 96;
/** Counts terminal columns after treating ANSI controls as zero-width units. */
export declare function visibleTextWidth(value: string): number;
/** Splits at a terminal-column boundary without cutting a grapheme or ANSI sequence. */
export declare function takeTerminalColumns(value: string, count: number): [string, string];
/**
 * Wraps plain text at a bounded terminal width. Existing leading indentation is
 * retained and continuation lines receive two more spaces. Long unbroken
 * identifiers are hard-wrapped so hostile/provider metadata cannot widen UI.
 */
export declare function wrapPlainLine(line: string, width?: number): string[];
export declare function wrapPlainLines(lines: readonly string[], width?: number): string[];
export declare function wrapPlainText(text: string, width?: number): string;
