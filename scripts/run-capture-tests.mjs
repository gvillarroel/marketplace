/** Cross-platform gate for the pure Python TUI capture hardening tests. */
import { spawnSync } from "node:child_process";

const configuredPython = process.env.AGENT_HARBOR_PYTHON?.trim();
const candidates = [
  ...(configuredPython ? [[configuredPython, []]] : []),
  ...(process.platform === "win32"
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3", []], ["python", []]]),
];

let selected;
for (const [command, prefix] of candidates) {
  const probe = spawnSync(command, [
    ...prefix,
    "-c",
    "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)",
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (probe.status === 0 && !probe.error) {
    selected = { command, prefix };
    break;
  }
}

if (!selected) {
  console.error(
    "capture tests require Python 3.10+; set AGENT_HARBOR_PYTHON to an explicit interpreter",
  );
  process.exit(1);
}

console.log(`capture tests: ${selected.command} ${selected.prefix.join(" ")}`.trim());
const result = spawnSync(selected.command, [
  ...selected.prefix,
  "-m",
  "unittest",
  "discover",
  "-s",
  "tests",
  "-p",
  "test_asciinema*.py",
  "-v",
], {
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
