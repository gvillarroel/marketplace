/** Conservative redaction for process-local, user-visible Agent Harbor metadata. */
/**
 * Removes common paths, URLs, credentials, and high-confidence token shapes.
 * This is deliberately heuristic: callers must not present it as a universal
 * secret detector or persist the input merely because this function was used.
 */
export declare function redactPublicMetadata(value: string): string;
/** Redacts and bounds arbitrary public metadata without scanning an unbounded input. */
export declare function publicMetadataText(value: string, maximumCodePoints?: number): string | undefined;
/** Public error text that keeps actionable Agent Harbor slash commands intact. */
export declare function publicErrorText(value: string, maximumCodePoints?: number, additionalCommands?: readonly string[]): string | undefined;
/** Produces a bounded, control-free task label for local observability views. */
export declare function publicTaskLabel(task: string, maximumCodePoints?: number): string;
