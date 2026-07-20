# Requisitos normativos de Agent Harbor

Este documento define el alcance de Agent Harbor 0.11. Las palabras **DEBE**,
**NO DEBE** y **PUEDE** son normativas. Un requisito sólo se considera cumplido
cuando existe una prueba indicada en la matriz de trazabilidad.

## 1. Resultado requerido

Agent Harbor **DEBE** proporcionar el mismo lifecycle de equipos en GitHub
Copilot CLI, OpenCode y Pi, distribuido como un elemento nativo de cada
harness:

- plugin de marketplace para Copilot;
- plugin npm para OpenCode;
- extensión de paquete para Pi.

Los tres **DEBEN** ofrecer `/bench`, `/join`, `/retire`, `/contract` y
`/list-skills`, además de `team-lead`, `repo-cartographer` y `crafter` mediante
el mecanismo nativo de agentes de cada harness.

La paridad significa mismos inputs, validaciones, estados y efectos
observables. No significa frontmatter o APIs byte-idénticos: esos formatos son
responsabilidad de cada adapter.

## 2. Arquitectura mínima obligatoria

La arquitectura **DEBE** conservar sólo estas capas:

1. `src/core`: contratos compartidos, validación, perfiles, roster,
   transacciones y resolución GitHub;
2. `src/adapters`: registro y traducción nativa por harness;
3. `src/orchestrators`: creación de exactamente un child con el SDK propio;
4. `scripts/build.mjs`: compilación y copia del runtime MCP de Copilot;
5. `dist`: artefacto generado; nunca fuente editable.

Los adapters **NO DEBEN** reimplementar reglas de negocio. Copilot **DEBE**
incluir una copia generada de `src/core` dentro del plugin; OpenCode y Pi
**DEBEN** importar el mismo `dist/core`. No se mantienen generadores Python ni
paquetes runtime paralelos.

Los prompts de roles **PUEDEN** ser específicos por harness, pero **DEBEN** mantener
la misma responsabilidad y el mismo límite de herramientas. Los comandos de
lifecycle no pueden depender de decisiones del modelo.

Pi **NO DEBE** representar un player únicamente como prompt estático: su
extensión registra los tres roles fijos y cada perfil activo con ownership
verificado como comandos nativos; invocarlos crea una sesión SDK en memoria con
la allowlist traducida. `.pi/agents` es almacenamiento privado del adapter, no
un directorio de prompts que Pi deba descubrir.

### 2.1 Eficiencia verificable

- Validación, lifecycle, GitHub y rendering **DEBEN** existir una sola vez en
  `src/core`; los runtimes Copilot son copias de build verificadas byte a byte.
- `/bench`, `/join`, `/retire` y `/list-skills` **NO DEBEN** crear sesiones SDK
  ni children. El tool MCP de Copilot ejecuta el contrato determinista en el
  proceso ya conectado; sólo `/contract` y la invocación explícita de un
  agente crean exactamente un child.
- Los lotes de mutación **DEBEN** serializarse porque comparten ownership. Las
  resoluciones remotas independientes **PUEDEN** ejecutarse en paralelo, pero
  siguen limitadas por la allowlist y el máximo de tres referencias.
- El build **DEBE** ser limpio y único; la suite **DEBE** reutilizar ese build y
  ejecutar en paralelo los smokes independientes de los tres CLIs.
- No se añade un runtime Python, un SDK duplicado, un clone Git ni una extensión
  Copilot experimental cuando el plugin puede aportar el mismo control mediante
  MCP stdio estable y sin dependencias adicionales.

## 3. Contrato del roster

### 3.1 Identidad y rutas

- Un ID **DEBE** cumplir `^[a-z0-9][a-z0-9-]{0,47}$` y no ser un comando, rol o
  miembro incluido reservado.
- Un perfil administrado **DEBE** hacer coincidir filename, `name`, `owner`,
  `roster`, `player`, `revision: "3"` y el marcador exacto de ownership.
- El registro personal **DEBE** vivir bajo el home del harness y la copia
  activa bajo el proyecto actual. Ambos se resuelven independientemente.
- Los paths **DEBEN** usar APIs portables, permanecer bajo sus padres y
  rechazar traversal y symlinks en ancestros administrados.
- Un archivo que no demuestre ownership completo **DEBE** tratarse como
  colisión: no se sobrescribe ni elimina.

### 3.2 Mutaciones

- Una operación multiarchivo **DEBE** completar todo el preflight antes de
  escribir, tomar un lock administrado exclusivo por roster, capturar los bytes
  anteriores, escribir cada archivo mediante reemplazo atómico, verificar cada
  efecto y restaurar el lote byte por byte si falla un paso. Un lock ajeno o
  ambiguo se trata como colisión y nunca se elimina.
- Repetir una operación con el mismo estado **DEBE** ser idempotente.
- Nunca se elimina un directorio.
- Un perfil administrado diferente sólo se reemplaza con `replace: true`.
- La revisión canónica sigue siendo `3`; esto evita una migración artificial
  al adoptar TypeScript. Revisiones 1/2 no se migran implícitamente: requieren
  re-registro explícito y nunca justifican borrar una colisión no verificable.

## 4. Comandos

### `/bench`

- Acepta vacío, `list [filter]`, `on <ids|all>` u `off <ids|all>`; no existe
  `toggle`.
- `all` significa, en orden: `scout`, `sage`, `smith`, `probe`, `guard`,
  `pilot`.
- `on` escribe sólo la copia activa; `off` elimina sólo una copia activa con
  ownership probado y conserva el registro personal recuperable.
- Los lotes son atómicos. El listado no muta ni usa red y distingue `on`,
  `bench`, `stale` y `conflict`.

### `/join`

- Recibe exactamente un objeto JSON con `name`, `description`, `prompt` y una
  lista no vacía de `tools`; sólo admite además `model`, `replace` y `skills`.
- Rechaza claves desconocidas, valores inseguros, tools desconocidas o
  duplicadas, descripción multilínea y perfiles mayores de 30.000 caracteres.
- Escribe registro y copia activa byte-idénticos y los verifica.
- `skills` admite como máximo tres referencias GitHub únicas y validadas. Una
  referencia requiere `execute`; no descarga el cuerpo durante `join`.

### `/retire`

- Recibe un único ID personal.
- Elimina registro y copia activa del proyecto actual en una transacción.
- No toca otros proyectos y rechaza miembros incluidos o colisiones.

### `/contract`

- Valida la misma definición que `/join`, salvo `replace`, más `task` no vacío
  antes de crear un child.
- Crea exactamente un child síncrono, en memoria y limitado a la invocación;
  nunca registra un perfil.
- El plugin Copilot ejecuta primero el preflight TypeScript compartido y después
  usa su `task` nativo exactamente una vez; el entrypoint programático usa
  `@github/copilot-sdk`. OpenCode usa el cliente recibido de
  `@opencode-ai/plugin` y Pi usa `createAgentSession` de
  `@earendil-works/pi-coding-agent`.
- Cualquier skill GitHub se materializa y valida antes de crear el child; un
  fallo remoto produce cero children.
- El child recibe la traducción least-privilege disponible en su SDK. Ninguna
  allowlist de prompt se presenta como sandbox del sistema operativo.

### `/list-skills`

- Filtra la allowlist explícita y resuelve cada rama mediante el `gh`
  autenticado del usuario.
- Reporta nombre, repo, path, tracking ref, commit SHA y blob SHA.
- No clona, instala, cachea, escribe, ejecuta ni muestra el cuerpo remoto.

## 5. GitHub y skills privadas

Una referencia GitHub **DEBE** contener exactamente `kind: github`, `name`,
`repo`, `path` y `track`, usar una rama `refs/heads/*`, terminar en
`SKILL.md` y estar cubierta por la allowlist activa.

Antes de usar el cuerpo, el loader compartido **DEBE** resolver nuevamente la
rama a un commit SHA, descargar sólo el path exacto con `gh`, exigir 1..18.000
bytes UTF-8, frontmatter de primera línea y un único `name` coincidente, y
aplicar el body sin frontmatter sólo durante esa invocación. El contenido
remoto no puede ampliar tools, persistencia, fuentes ni alcance. Credenciales
privadas son las del `gh` del usuario; Agent Harbor no almacena tokens.
Cada proceso `gh` **DEBE** tener un timeout de 20 segundos y recibir la señal de
cancelación del host cuando exista; el servidor MCP **DEBE** atender
`notifications/cancelled` para sus requests activos.

Los agentes persistentes **DEBEN** usar ese loader nativo antes del trabajo:
`agent-harbor/skill` proviene del servidor MCP incluido en el plugin Copilot y
`agent_harbor_skill` de un tool dedicado OpenCode; Pi materializa el body en
código antes de crear su sesión. `/contract` materializa en cada orquestador
antes de crear el child. Ningún adapter reimplementa descarga o validación.

## 6. Portabilidad e instalación

- Node.js `>=22.19.0` es el único runtime de implementación y pruebas requerido.
- El código **NO DEBE** asumir shell, separador de paths ni sufijo ejecutable.
- `npm run build` **DEBE** eliminar artefactos previos y producir `dist` y el
  runtime Copilot desde la misma fuente sin red ni credenciales; un error de
  tipos no puede dejar un `dist` parcialmente actualizado.
- `package.json` **DEBE** declarar el main OpenCode, la extensión Pi y el bin
  Copilot SDK. El plugin Copilot **DEBE** contener su configuración y runtime
  MCP compilado, sin depender de extensiones experimentales.
- Los SDKs se fijan a versiones exactas: `@github/copilot-sdk@1.0.6`,
  `@opencode-ai/plugin@1.17.13` (que fija su SDK) y el peer provisto por Pi
  `@earendil-works/pi-coding-agent@0.80.10`. Pi permanece como peer opcional
  para no duplicar el runtime del host.

## 7. Límites deliberados para mantener simplicidad

- No se implementa un framework de plugins propio encima de los tres SDKs.
- No se duplican comandos como `toggle`, `lineup` o `leave`.
- No se soportan skills instaladas/locales en definiciones de roster 0.11;
  sólo referencias GitHub verificables.
- No se promete aislamiento de sistema operativo.
- La limitación de Copilot CLI 1.0.71 sobre slash skills deterministas obliga a
  wrappers Markdown mínimos. Los cinco llaman una sola vez al tool estructurado
  `control` del servidor MCP `agent-harbor`; no interpolan argumentos en un shell.
  Sólo `/contract` llama después al `task` nativo con la salida canónica.
- El MCP Copilot hereda el working directory al iniciar la sesión. Cambiar de
  proyecto requiere iniciar una sesión nueva desde el directorio objetivo; no
  se acepta un path elegido por el modelo como argumento del tool.
- Una cadena SDLC completa es opt-in; `team-lead` elige el child mínimo.

## 8. Matriz de trazabilidad

| ID | Requisito esencial | Evidencia obligatoria |
| --- | --- | --- |
| NAT-01 | Entrypoints, roles y loader nativos | `distribution declares native TypeScript entrypoints`, `Copilot plugins expose canonical commands and one plugin-provided MCP server` y `installed CLIs discover the native packages` |
| EFF-01 | Core único, un build y mínimo trabajo por comando | `Copilot runtime is generated byte-for-byte from shared core`, matriz de cinco comandos, smokes concurrentes y contenido de `npm pack --dry-run --json` |
| CMD-01 | Cinco comandos con semántica común | matriz `*: all five commands share the executable contract` para los tres harnesses |
| VAL-01 | Schema cerrado, límites y cero children ante error | `validation rejects every non-canonical player shape`, `join rejects an oversized rendered profile` y `contract rejects invalid input before creating any child` |
| OWN-01 | Ownership completo, colisiones, traversal y symlinks | `ownership metadata must remain complete`, `ownership rejects duplicate metadata and the wrong roster class`, `all harnesses reject unknown fields and unmanaged collisions`, `leaf symlinks are rejected` y `ancestor symlinks and traversal-shaped IDs are rejected` |
| TXN-01 | Lock, preflight, reemplazo atómico y rollback byte-idéntico | `concurrent roster mutations are serialized`, `bench preflights a whole batch` y `a failed multi-file mutation restores the complete prior state` |
| CON-01 | Un child, allowlist nativa y cleanup | pruebas de los tres orquestadores y `SDK orchestrators clean up child sessions when prompting fails` |
| COP-01 | MCP estructurado, preflight compartido y runtime generado | `Copilot native control performs deterministic shared contract preflight`, `compiled Copilot MCP server is bounded, fails closed, and inherits its invocation paths`, `Copilot runtime is generated byte-for-byte from shared core`, `generated native runtime retains gh timeout and MCP cancellation guards` y smoke ACP `agent-harbor (connected, plugin)` |
| GH-01 | Referencias canónicas, snapshot read-only y body invocation-local | `GitHub references are bounded...`, `GitHub resolver pins one branch and one exact blob with two read-only cancellable gh calls`, `default gh runner enforces its process timeout`, `GitHub skill bodies are snapshot-loaded...` y `contract skills are validated and materialized before any SDK child...`; POC manual autenticado con `gh` |
| PI-01 | API real de Pi, comandos de roles y sesión en memoria | smoke de `createAgentSession`, RPC `get_commands` y `Pi extension turns an active managed profile into a native SDK-backed command` |
| PKG-01 | Paquete publicable | `npm pack --dry-run --json` |
| DEP-01 | Dependencias seguras | `npm audit --audit-level=high` sin hallazgos |

## 9. Gate de entrega

Antes de publicar **DEBEN** pasar, en este orden:

```text
npm test
npm audit --audit-level=high
npm pack --dry-run --json
git diff --check
```

`npm test` comienza con un build limpio; no se ejecuta un `typecheck` ni un
build adicional antes de la suite. `prepack` conserva su build independiente
para que empaquetar fuera del gate nunca publique artefactos antiguos.

La ausencia de un CLI sólo PUEDE omitir su test de descubrimiento. El contrato
base no requiere modelo, API key, Docker ni red. Una modificación de lifecycle,
ownership, adapter u orquestador **DEBE** incluir una regresión proporcional.

## 10. Decisiones OSS ya cerradas

Las alternativas enumeradas en `AGENTS.md` no reemplazan el core porque no
reúnen simultáneamente roster persistente, ownership transaccional, child
desechable, snapshots privados y paridad nativa. Sólo se reabre esa decisión
ante un cambio material upstream y un POC que cubra colisiones, actualización,
cleanup y descubrimiento real en los tres harnesses.
