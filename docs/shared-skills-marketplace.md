# Shared skills in Codex and Copilot

The `agent-harbor` marketplace includes two small plugins that select overlapping skills from one canonical library:

- `shared-example-a`: skills 1 and 2.
- `shared-example-b`: skills 2 and 3.

The example contains exactly three `SKILL.md` files, with one source copy of skill 2. Both plugins install directly from Git. No build, generated skill copies, symlinks, or Agent Harbor runtime are required to use these two instruction-only plugins. The existing `agent-foundry` plugin remains available through the Copilot catalog.

## Install from GitHub

With a signed-in Copilot CLI:

```sh
copilot plugin marketplace add https://github.com/gvillarroel/marketplace.git
copilot plugin install shared-example-a@agent-harbor
copilot plugin install shared-example-b@agent-harbor
copilot skill list --json
```

With a signed-in Codex CLI:

```sh
codex plugin marketplace add https://github.com/gvillarroel/marketplace.git
codex plugin add shared-example-a@agent-harbor
codex plugin add shared-example-b@agent-harbor
codex plugin list --json
```

The Codex catalog registers these two verified skill plugins. It does not claim support for Agent Harbor's Copilot runtime extension in Codex.

With both plugins enabled, Copilot exposes `/shared-example-1`, `/shared-example-a:shared-example-2`, `/shared-example-b:shared-example-2`, and `/shared-example-3`. In Codex, ask for the installed plugin's skill explicitly, for example: `Use shared-example-b:shared-example-2 and follow its instructions.` Each skill reads its bundled `references/proof.txt` and returns a demonstration token.

## Layout and selection

```text
.agents/plugins/marketplace.json           # Codex catalog
.github/plugin/marketplace.json            # Copilot catalog
plugins/shared-skills-example/             # Root of A
  .codex-plugin/plugin.json
  .claude-plugin/plugin.json
  library/                                # Root of B
    .codex-plugin/plugin.json
    .claude-plugin/plugin.json
    shared-example-1/SKILL.md
    shared-example-2/SKILL.md
    shared-example-3/SKILL.md
```

Each skill also has its reference file. The `.claude-plugin/plugin.json` location is a compatibility format recognized by Copilot; Claude is not required. The `.codex-plugin/plugin.json` location provides the explicit selection for Codex.

A declares `./library/shared-example-1` and `./library/shared-example-2`. B declares `./shared-example-2` and `./shared-example-3`, relative to its own root. All paths remain inside the corresponding plugin root. The catalogs point A to `./plugins/shared-skills-example` and B to `./plugins/shared-skills-example/library`.

The plugin roots are nested. Sibling roots referencing `../../skills/...` did not load the shared skills in the tested CLI versions. `library/` avoids automatic discovery of all three skills in a conventional root `skills/` directory. The selection uses the compatibility manifests; adding a portable root `plugin.json` changes component discovery.

Manifest directories contain JSON only. Root directory names can be organized to suit the package, while the recognized manifest basename stays `plugin.json`. Native installation copies each selected root's tree into a client cache; the manifest selects which skills are registered and shown, rather than physically filtering every downloaded file. The single-copy guarantee applies to the example's Git sources.

## Nexus ZIP distribution

The [Nexus ZIP guide](nexus-zip-marketplace.md) describes the verified archive
workflow. It requires download/extraction before native local registration and
materializes each plugin's selected files in the generated release artifacts.
Direct Git installation above continues to use the three canonical sources.

## Validation

The native test harness requires Windows, Git, Node.js, installed Copilot/Codex CLIs, and existing signed-in accounts. It uses isolated client profiles and invokes models. It adds no npm dependencies. `CODEX_EXAMPLE_BIN` can select a native Codex binary outside the Windows npm installation; Copilot uses its latest already-cached Windows package.

```sh
npm run check:shared-skills
npm run test:shared-skills
npm run report:shared-skills
```

The live command installs from the exact GitHub URL above. Use `npm run test:shared-skills -- --client codex` or `--client copilot` to select one client. Commit plugin and catalog changes before testing a Git snapshot. `node scripts/shared-skills/test.mjs` is the local smart-HTTP preflight; its output stays under ignored `work/`.

The suite checks A alone, A+B, all four native invocations, B after removing/disabling A, and a fresh B-to-A installation order. Each invocation must load the correct plugin's skill, successfully read its bundled proof, and return exactly the expected token. Raw local state is ignored; published evidence redacts home and repository paths.

The repository's normal compatibility tests also check the three canonical sources and the two catalog selections without invoking models.

## Verified GitHub acceptance — 2026-10-27

Both clients installed the marketplace from the exact GitHub URL above in fresh isolated profiles. The tested source commit was [`babe975`](https://github.com/gvillarroel/marketplace/commit/babe975c7b917b062143ee23c2613e6432dc19e9).

| Client | A alone | A+B | Native invocations | B without A | Fresh B→A order |
| --- | --- | --- | --- | --- | --- |
| Copilot CLI 1.0.103 | 1,2 | 1,A:2,B:2,3 | 4/4 | 2,3 | Passed |
| Codex CLI 0.145.0 | 1,2 | 1,A:2,B:2,3 | 4/4 | 2,3 | Passed |

Every invocation loaded the correct plugin's skill, successfully read its bundled proof file from the installation cache, and returned exactly the expected token. The records include successful `plugin marketplace add https://github.com/gvillarroel/marketplace.git` operations and both plugin installs. GitHub HEAD remained at the tested commit for the entire acceptance run.

See the [native report](validation/shared-skills/report.md), [combined JSON results](validation/shared-skills/results.json), [Copilot trace](validation/shared-skills/copilot.json), and [Codex trace](validation/shared-skills/codex.json).

These checks cover Copilot CLI and Codex CLI. They do not establish a manual test of the VS Code Copilot extension or the Codex desktop installation UI.

## References

- [Copilot CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference).
- [OpenAI plugin packaging and compatibility manifests](https://developers.openai.com/plugins/build/plugins).

[Documentation index](README.md).
