/**
 * Shared domain contracts for commands, harness adapters, players, and skill sources.
 * Keeping these types transport-agnostic lets every adapter enforce the same core rules.
 */
/** Command names accepted by the public Agent Harbor command dispatcher. */
export const commandNames = ["bench", "join", "retire", "contract", "list-skills"];
/** Commands whose result is produced without asking a model to interpret the request. */
export const deterministicCommandNames = ["bench", "join", "retire", "list-skills"];
