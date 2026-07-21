import assert from "node:assert/strict";
import test from "node:test";
import { publicErrorText, publicTaskLabel, redactPublicMetadata } from "../src/core/public-metadata.js";

test("public metadata redacts Unicode paths, credentialed URIs, and high-confidence tokens", () => {
  const source = [
    "/home/álvaro/秘密.txt",
    "C:/Users/álvaro/秘密.txt",
    "file:///C:/Users/álvaro/秘密.txt",
    String.raw`\\servidor\álvaro\秘密.txt`,
    "../álvaro/秘密.txt",
    "AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF",
    "DATABASE_URL=postgres://u:p@host/db",
    "xoxb-12345678901234567890",
    "npm_12345678901234567890",
  ].join(" ");
  const redacted = redactPublicMetadata(source);
  assert.doesNotMatch(redacted, /álvaro|秘密|AKIA|postgres|xoxb|npm_/u);
  assert.match(redacted, /AWS_ACCESS_KEY_ID=\[redacted\]/u);
  assert.match(redacted, /DATABASE_URL=\[redacted\]/u);
  assert.ok((redacted.match(/\[path\]/gu) ?? []).length >= 5);
});

test("public metadata consumes escaped quoted credentials without leaking their suffix", () => {
  const redacted = redactPublicMetadata(String.raw`token="abc\"still-secret-tail" next=visible`);
  assert.equal(redacted, "token=[redacted] next=visible");
  assert.doesNotMatch(redacted, /abc|still-secret-tail/u);
});

test("public metadata consumes complete labeled and unlabeled private-key blocks", () => {
  const labeled = redactPublicMetadata([
    "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----",
    "MII-labeled-secret",
    "-----END PRIVATE KEY-----",
    "after",
  ].join("\n"));
  assert.equal(labeled, "PRIVATE_KEY=[redacted]\nafter");

  const unlabeled = redactPublicMetadata([
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "openssh-secret-body",
    "-----END OPENSSH PRIVATE KEY-----",
    "after",
  ].join("\n"));
  assert.equal(unlabeled, "[redacted-private-key]\nafter");
  assert.doesNotMatch(`${labeled}\n${unlabeled}`, /MII|openssh-secret-body/u);
});

test("public task labels preserve ordinary slash prose while remaining bounded", () => {
  assert.equal(
    publicTaskLabel("Coordinate CI/CD and input/output reviews"),
    "Coordinate CI/CD and input/output reviews",
  );
  assert.ok([...publicTaskLabel("😀".repeat(500))].length <= 72);
});

test("public task labels pre-bound multi-megabyte prompts before redaction", () => {
  const privateSuffix = "suffix-secret-that-must-never-be-scanned-or-shown";
  const huge = `${"ordinary planning text ".repeat(200_000)}${privateSuffix}`;
  const started = performance.now();
  const label = publicTaskLabel(huge);
  const elapsed = performance.now() - started;

  assert.ok([...label].length <= 72);
  assert.ok(label.endsWith("…"));
  assert.doesNotMatch(label, /suffix-secret|never-be-scanned/u);
  assert.ok(elapsed < 1_000, `bounded task labeling took ${elapsed.toFixed(1)}ms`);
});

test("public errors pre-bound multi-megabyte input while preserving useful commands", () => {
  const huge = `${"ordinary provider failure ".repeat(200_000)}/team suffix-never-scanned`;
  const started = performance.now();
  const error = publicErrorText(huge)!;
  const elapsed = performance.now() - started;

  assert.ok([...error].length <= 600);
  assert.ok(error.endsWith("…"));
  assert.doesNotMatch(error, /suffix-never-scanned/u);
  assert.ok(elapsed < 1_000, `bounded public error formatting took ${elapsed.toFixed(1)}ms`);

  assert.equal(publicErrorText("Run /team, then /bench."), "Run /team, then /bench.");
});

test("public error command restoration cannot be forged with predictable sentinel text", () => {
  const injected = `${String.fromCodePoint(0xe000)} AgentHarborSlashCommand0Marker stays literal; run /team.`;
  assert.equal(publicErrorText(injected), injected);
});

test("public errors preserve a bounded personal alias without scanning or trusting sentinels", () => {
  const sentinel = "AgentHarborCurrentSlashCommandMarker";
  const huge = `${sentinel}; retry /personal-reviewer. ${"x".repeat(2_000_000)}private-tail`;
  const started = performance.now();
  const error = publicErrorText(huge, 600, ["/personal-reviewer"])!;

  assert.match(error, /AgentHarborCurrentSlashCommandMarker; retry \/personal-reviewer\./u);
  assert.doesNotMatch(error, /private-tail/u);
  assert.ok(error.endsWith("…"));
  assert.ok(performance.now() - started < 1_000, "dynamic command protection scanned an unbounded error");
});
