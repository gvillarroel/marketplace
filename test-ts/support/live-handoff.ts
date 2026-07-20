export function foldMarkdownWrappedText(value: string): string {
  const unwrapped = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^(?:\s*>\s*)+/u, ""))
    .filter((line) => !/^\s*(?:`{3,}|~{3,})(?:[\w-]+)?\s*$/u.test(line))
    .join("\n");
  return unwrapped.replace(/\s+/gu, " ").trim();
}
