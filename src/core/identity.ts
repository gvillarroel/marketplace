/** Shared syntax for player and skill identifiers accepted across every surface. */

const harborIdPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Returns whether a value is a canonical, traversal-safe Agent Harbor identifier. */
export function isHarborId(value: unknown): value is string {
  return typeof value === "string" && harborIdPattern.test(value);
}
