# Nexus ZIP acceptance — 2026-10-28

A real local Sonatype Nexus 3.96.0-09 Community instance hosted the ZIPs in
a Raw repository. HTTP uploads returned 201 and downloads returned 200 with
identical bytes. Both CLIs reject direct ZIP marketplace/plugin URLs; both
work after external download, SHA-256 verification, and extraction.

| Client | A alone | A+B | Verified invocations | B without A | Fresh B→A |
| --- | --- | --- | --- | --- | --- |
| Codex CLI 0.145.0 | 1,2 | 1,A:2,B:2,3 | 4/4 | 2,3 | Passed |
| Copilot CLI 1.0.103 | 1,2 | 1,A:2,B:2,3 | 4/4 | 2,3 | Passed |

Each invocation loaded the expected plugin's skill, successfully read its
bundled proof reference, and returned exactly its token. Trace verification
was repeated while producing these public records. The three-archive workflow
used marketplace metadata and two plugin ZIPs downloaded from Nexus. Native
registration used the extracted local directory.

The single complete ZIP also passed native installation/listing in both
clients. Its plugin payload files are identical to those of the two component
ZIPs; model invocations above were performed on the three-archive workflow.

The extractor also passed an authenticated download against Nexus with
anonymous access disabled: unauthenticated HTTP 401, successful Basic-auth
extraction. Nine repeatable HTTP-fixture tests passed separately. PowerShell
7.6.9 was used. The repository's 499 TypeScript tests, 73 capture tests, and
typecheck also passed.

Direct HTTP ZIP and JSON marketplace URLs caused Git clone attempts. A plugin
source of type url pointing to a ZIP also attempted Git clone. Source types
archive/zip and plain URL strings did not produce installable plugins. Local
ZIP paths were not extracted automatically. See the captured rejection records.

Extracting the original nested layout with one shared skill path exposed a
Copilot collision: requesting B:2 loaded A:2. The successful release materializes
each plugin's selected files into separate payload directories. The repository
continues to have exactly three authored skill sources; generated archives
contain a copy of skill 2 for each plugin.

These results cover Codex CLI 0.145.0 and Copilot CLI 1.0.103 on Windows. They
do not establish support in desktop/VS Code installation interfaces, automatic
updates, or a Nexus npm registry. The loopback URLs identify a temporary local
test instance and are not public artifact URLs. Credentials and home/repository
paths are excluded from public evidence.

- [Combined results, hashes, and authentication/bundle checks](results.json).
- [Codex native execution trace](codex.json).
- [Copilot native execution trace](copilot.json).
- [Native ZIP/URL/schema rejection records](native-rejections.json).
- [Build, upload, download, and install instructions](../../nexus-zip-marketplace.md).
