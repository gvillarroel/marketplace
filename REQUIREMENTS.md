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

Esos tres roles fijos **DEBEN** estar activos al iniciar. `scout`, `sage`,
`smith`, `probe`, `guard` y `pilot` **DEBEN** empezar en banca y sólo pasan a
ser invocables en el proyecto mediante `bench on`. La suite **DEBE** distinguir
ambos estados y probar los nueve nombres después de `bench on all`.

La paridad significa mismos inputs, validaciones, estados y efectos
observables. No significa frontmatter o APIs byte-idénticos: esos formatos son
responsabilidad de cada adapter.

## 2. Arquitectura mínima obligatoria

La arquitectura **DEBE** conservar sólo estas capas:

1. `src/core`: contratos compartidos, validación, perfiles, roster,
   transacciones y resolución GitHub;
2. `src/adapters`: registro y traducción nativa por harness;
3. `src/orchestrators`: creación de exactamente un child por llamada con el SDK
   propio y despacho nominal cuando el host lo permite;
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

### 2.1 Eficiencia y presupuesto de inferencia verificables

Una ruta es **cero modelo** o **cero tokens de modelo** sólo cuando una entrada
válida termina sin enviar un prompt a un proveedor, iniciar inferencia, crear
una sesión de modelo ni crear un child. Reutilizar el proceso o sesión
interactiva del host y realizar I/O determinista —filesystem, locks o `gh`— no
consume ese presupuesto. La ausencia de children por sí sola no demuestra una
ruta cero modelo.

- Validación, lifecycle, GitHub y rendering **DEBEN** existir una sola vez en
  `src/core`; los runtimes Copilot son copias de build verificadas byte a byte.
- Toda funcionalidad cuyo resultado pueda calcularse determinísticamente
  **DEBE** exponerse y ejecutarse primero como comando, extensión, callback del
  host o CLI directo. **NO DEBE** enviarse al modelo cuando el harness permita
  una ruta de código equivalente. Un wrapper mediante prompt sólo **PUEDE** ser
  fallback cuando la superficie directa no esté disponible y **DEBE**
  identificarse como mediada por modelo.
- `/bench`, `/join`, `/retire` y `/list-skills` **DEBEN** compartir un backend
  cero modelo que **NO DEBE** crear sesiones SDK ni children. La consulta de la
  banca (`/bench` vacío o `bench list`) además **NO DEBE** usar red y **DEBE**
  tener una entrada cero modelo en las tres distribuciones.
- El paquete **DEBE** ofrecer
  `agent-harbor <copilot|opencode|pi> <bench|join|retire|list-skills>` como ruta
  directa portable. Los adapters **DEBEN** preferir además la superficie nativa
  más eficiente disponible:

  | Harness | Superficie directa preferida | Fallback |
  | --- | --- | --- |
  | Copilot CLI | comandos de extensión `client` para `/bench`, `/join`, `/retire` y `/list-skills` | CLI directo; skills + MCP mediadas por modelo si las extensiones experimentales están desactivadas |
  | OpenCode | comandos TUI inequívocos y diálogos para los cuatro controles | CLI directo; comandos con argumentos mediados por modelo |
  | Pi | handlers `registerCommand` para los cuatro nombres canónicos | CLI directo |

- `/contract` válido **NO ES** cero modelo: su preflight **DEBE** ser
  determinista y después **DEBE** crear exactamente un child. Un fallo de
  preflight crea cero children.
- Una invocación explícita de un especialista **NO ES** cero modelo, pero
  **DEBE** apuntar directamente al agente seleccionado sin una inferencia de
  routing. Copilot y OpenCode **PUEDEN** cambiar el agente de la sesión actual;
  Pi **PUEDE** crear una sesión en memoria. Una tarea vacía, un ID desconocido,
  un bundled apagado o un perfil sin ownership **DEBEN** fallar antes de enviar
  el prompt.
- Una misión coordinada **PUEDE** usar de uno a seis especialistas nominales,
  sólo de forma secuencial y opt-in. Cada delegación **DEBE** crear exactamente
  un child aislado, validar nuevamente que el destino siga activo, bloquear la
  recursión sobre `team-lead` y devolver evidencia al coordinador antes de
  continuar. Un child creado por el adapter **DEBE** limpiarse aun si falla el
  prompt; un child `task` nativo de Copilot **DEBE** terminar bajo el lifecycle
  síncrono del host antes de permitir la siguiente delegación. `/contract`
  conserva por separado su garantía de un solo child total.
- `/list-skills` **PUEDE** usar el `gh` autenticado y la red, pero **NO DEBE**
  iniciar inferencia.
- Las regresiones de presupuesto **DEBEN** comprobar efectos observables y la
  ausencia de eventos de uso/mensaje del modelo o usar un orquestador que falle
  si es invocado; contar sólo children no es suficiente.
- La suite **DEBE** conservar smokes live autenticados y opt-in para Copilot,
  OpenCode y Pi que consuman inferencia de forma deliberada para probar la
  decisión semántica de `team-lead`. **NO DEBEN** formar parte de `npm test`.
  Cada caso **DEBE** exigir tokens positivos del coordinador y de cada child,
  limitar recursos y timeout, y fallar si una ruta supuestamente live termina
  sin uso de modelo. Activación, consulta de banca y cleanup **DEBEN** seguir
  rutas deterministas separadas; en particular, ver la banca permanece en cero
  tokens aunque el mismo dataset tenga una aceptación live.
- Los lotes de mutación **DEBEN** serializarse porque comparten ownership. Las
  resoluciones remotas independientes **PUEDEN** ejecutarse en paralelo, pero
  siguen limitadas por la allowlist y el máximo de tres referencias.
- El build **DEBE** ser limpio y único; la suite **DEBE** reutilizar ese build y
  ejecutar en paralelo los smokes independientes de los tres CLIs.
- No se añade un runtime Python, un SDK duplicado ni un clone Git. Una extensión
  del host sólo **DEBE** añadirse cuando elimina una petición de modelo o aporta
  una capacidad nativa que el runtime estable no ofrece; el core y la ruta CLI
  **DEBEN** seguir funcionando sin ella.

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
- Ver la banca **DEBE** completar con cero tokens de modelo en Copilot, OpenCode
  y Pi mediante su superficie directa documentada.

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
  allowlist de prompt se presenta como sandbox del sistema operativo. OpenCode
  **DEBE** empezar cada política con `"*": false` y habilitar sólo los nombres
  explícitos; Pi **DEBE** desactivar extensiones descubiertas en children y
  declarar `harbor_delegate` como `executionMode: "sequential"`.
- Si ejecución y cleanup fallan, el orquestador **DEBE** preservar ambos errores
  en un `AggregateError`; nunca debe ocultar que el child pudo quedar vivo.

### Invocación y delegación nominal

- Copilot **DEBE** registrar comandos `client` `/harbor-<id> <task>` para los
  tres roles fijos, los seis bundled y los perfiles activos conocidos al
  iniciar. El handler **DEBE** recargar discovery, resolver el ID estable o el
  path exacto administrado, seleccionar el agente, enviar el task una sola vez
  y restaurar la selección. Un bundled apagado falla sin inferencia.
- El `task` nativo de `team-lead` en Copilot **DEBE** pasar por un hook de código
  que sólo permita el `agent_type` exacto de un player Agent Harbor activo,
  rechace nested delegation y recursión, impida dos llamadas simultáneas y
  cuente como máximo seis por prompt de usuario.
- OpenCode **DEBE** registrar `harbor-<id>` con `template: "$ARGUMENTS"`, el
  `agent` exacto y `subtask: false`; así evita tanto el router como el resumen
  adicional del padre. Un hook **DEBE** revalidar tarea, actividad y ownership
  al ejecutar incluso si el alias quedó cargado después de `bench off`.
  `team-lead` **DEBE** recibir sólo `harbor_delegate`; el enum y la descripción
  del tool enumeran exactamente los destinos activos al iniciar la sesión. Cada
  llamada crea un child desechable con `body.agent` exacto y una correlación
  única del tool. Con Codex OAuth, el child permanece separado del parent para
  no enviar metadata de sesión que ese endpoint rechaza; la correlación y el
  cleanup **DEBEN** conservarse mediante el call ID y los hooks nativos. El
  límite **DEBE** agruparse por el mensaje de usuario raíz, no por los mensajes
  assistant intermedios.
- Pi **DEBE** conservar `/<id> <task>` como comando nativo. El child de
  `team-lead` **DEBE** recibir un `harbor_delegate` custom y acotado cuyo schema
  enumera el roster activo al crear esa sesión; el loader desactiva extensiones
  descubiertas para impedir herramientas implícitas o carga recursiva, y el
  host **DEBE** serializar ese tool. Cada target Pi se reconstruye desde el rol
  fijo o la definición activa embebida y ownership-verified.
- El coordinador **DEBE** preferir un solo especialista y detenerse cuando la
  tarea esté completa o bloqueada. Una secuencia posterior recibe sólo la
  tarea acotada y la evidencia verificada necesaria de etapas anteriores.
  Cuando el usuario declara gates distintos como condiciones obligatorias de
  completitud, el coordinador **DEBE** ejecutar todos esos gates en orden aunque
  implementación o tests ya pasen; minimalidad no autoriza omitir una condición.

### Dataset y evidencia de ciclos

- `test-ts/fixtures/harbor-cycles.json` **DEBE** ser un dataset literal,
  versionado y de schema cerrado; las expectativas no se derivan de
  `bundledPlayers`, porque catálogo y prueba podrían desviarse juntos. El
  roster se compara como conjunto, pero el orden de un ciclo se compara como
  secuencia exacta.
- El dataset **DEBE** declarar los tres IDs fijos y sus identidades nativas, los
  seis bundled en orden canónico y, como mínimo, estos ciclos:
  `default-specialists` (`repo-cartographer` → `crafter`, sin activación) y
  `full-sdlc` (`bench on` de los seis seguido de
  `scout` → `sage` → `smith` → `probe` → `guard` → `pilot`). Cada etapa salvo
  la primera referencia exactamente la evidencia de su predecesora inmediata.
- La prueba offline **DEBE** ejecutar el dataset en Copilot, OpenCode y Pi sin
  inferencia ni red. Para cada etapa comprueba actividad y ownership antes del
  boundary, target lógico e ID runtime exactos, un solo child correlacionado,
  handoff de evidencia no vacía, ausencia de solapamiento y cleanup antes de la
  etapa siguiente. Un child que no devuelve texto se trata como fallo y se
  limpia; nunca habilita la etapa siguiente. Al terminar, los bundled activados
  por el caso vuelven a banca.
- La evidencia nativa del harness **DEBE** preferirse cuando identifica la
  transición de forma suficiente. Cuando no exponga correlación, identidad o
  cleanup, el orquestador **PUEDE** recibir un hook síncrono opcional. Ese hook
  **NO DEBE** iniciar inferencia, red o persistencia, y **DEBE** ser no-op si no
  se inyecta. Un fallo del collector **NO DEBE** alterar ejecución, errores ni
  cleanup del child.
- Los hooks normalizados usan `agent-harbor/evidence@1` y las fases
  `target.resolved`, `child.started`, `prompt.attempted`, `evidence.returned`,
  `child.completed|child.failed` y `child.cleaned`. Tasks, respuestas y errores
  **NO DEBEN** almacenarse en claro: sólo SHA-256, tamaño UTF-8, IDs, resultado
  y metadatos de correlación. Cada evento **DEBE** distinguir una transición
  `observed` de una `inferred`; en particular, el final síncrono del `task`
  Copilot puede inferir cleanup, pero no presentarlo como evento nativo.
- La suite offline demuestra routing solicitado, preflight, orden, handoff y
  cleanup con SDK doubles; **NO DEBE** afirmar que un modelo escogerá
  espontáneamente la secuencia. Los smokes live `full-sdlc` de Copilot,
  OpenCode y Pi **DEBEN** ejecutar el `team-lead` real sobre una fixture
  desechable y presentar los candidatos en un orden distinto al workflow,
  junto con sus roles publicados también desordenados; cada rol sólo puede
  cubrir su gate semántico. Deben observar mediante identidad, delegación y
  terminación nativas `scout` → `sage` → `smith` → `probe` → `guard` → `pilot`,
  exactamente una vez y sin solapamiento, correlacionar cada llamada con un
  child terminal, comprobar el cambio y exigir un handoff inmediato acotado
  que transporte un ID oculto que el coordinador sólo puede obtener de `scout`.
  La identidad y terminación nativas son autoritativas; el marcador escrito por
  el modelo es diagnóstico opcional. Si aparece, sólo puede ser el marcador
  propio, una vez, sin marcadores stale ni duplicados.
- La fixture live **DEBE** acotar cada gate a `ACCEPTANCE.md`, `src/score.js` y
  `test/score.test.js`: sólo implementación edita, verificación ejecuta
  `npm test` exactamente una vez, review es lectura y delivery usa la evidencia
  retornada sin exploración adicional.
- Cada smoke live **DEBE** activar y desactivar los seis bundled mediante el CLI
  determinista antes y después de inferencia, comprobar cleanup positivo y no
  reutilizar esa activación como prueba de gasto: `bench list` **DEBE** seguir
  demostrando cero tokens por separado.
- Cada smoke live **DEBE** limitar cada prompt delegado a 4 KiB, prohibir routers
  y delegación recursiva, y aplicar presupuestos ejecutables: turnos raíz <=
  etapas + 2, 36 turnos, 60 tools y 180 segundos en total, 200.000 tokens
  observados en total,
  y por child como máximo 35.000 tokens y 12 tools. También **DEBE** acotar la
  suma de prompts y evidencias por los límites individuales. Copilot guarda
  `work/live-team-lead-report.json`; OpenCode y Pi guardan, respectivamente,
  `work/live-opencode-team-lead-report.json` y
  `work/live-pi-team-lead-report.json`. Esos reportes sólo **PUEDEN** persistir
  orden, hashes, tamaños, conteos acotados, duraciones, presupuestos, identidad
  runtime y uso raíz/children/total por separado. Tasks, respuestas, IDs
  ocultos, paths, comandos y errores **NO DEBEN** persistirse en claro. La
  totalización **DEBE** usar los eventos nativos de uso y terminación de cada
  harness, exigir uso positivo raíz/children y no dejar huecos entre turnos y
  uso. En Copilot, por child se suma el máximo entre `assistant.usage`
  correlacionado y `subagent.completed.totalTokens`. Estos límites miden
  routing, handoff y recursos de la corrida; no se presentan como
  una comparación universal de eficiencia entre modelos. Su ejecución es
  opt-in porque necesariamente consume inferencia.
- Los smokes OpenCode y Pi **DEBEN** usar autenticación Codex del usuario. El
  modelo preferido exacto es `gpt-5.3-codex-spark`; sólo si el catálogo lo
  declara ausente antes de toda inferencia **PUEDE** elegirse
  `gpt-5.6-luna`. Un fallo de proveedor, routing, fixture o verificación después
  de empezar **NO DEBE** disparar fallback ni una segunda corrida. OpenCode usa
  provider `openai` y reasoning `medium`; Pi usa provider `openai-codex` y
  reasoning `low`. El modelo y reasoning raíz **DEBEN** propagarse a todos los
  children y quedar verificados por eventos nativos.
- El CLI live **DEBE** tener un safety ceiling de 60 AI credits compartidos para
  que seis children no sean truncados por el host; ese techo no sustituye los
  límites más estrictos y asertados de 36 turnos, 200.000 tokens y 180 segundos.
- Antes de inferencia, el smoke live **DEBE** comprobar la extensión
  `plugin:agent-foundry:agent-harbor` en estado `running`, con proceso vivo y
  `/bench` registrado como comando `client`; también **DEBE** solicitar mediante
  RPC un sandbox limitado a la fixture, sin red saliente ni local, exigir el
  acuse exitoso de la actualización y reportar por separado si la solicitud se
  intentó, la política pedida desde el mismo objeto RPC y ese acuse. El handler
  de permisos sólo puede aprobar lecturas dentro de la fixture, la escritura
  exacta esperada, `npm test` o `node --test`, el `task` nativo y el acceso de
  esa extensión. La corrida **DEBE** observar al menos una decisión de permiso
  runtime. Todo bypass de sandbox **DEBE** denegarse y el smoke **DEBE** probar
  la rama del mismo callback configurado con un canario sintético determinista
  `requestSandboxBypass: true`; decisiones runtime y canario **DEBEN** contarse
  por separado y el reporte no puede presentar el canario como evento nativo.
- Cada aprobación del guard Copilot **DEBE** producir una evidencia efímera
  `agent-harbor/evidence@1`, correlacionada con el `toolCallId` y con sólo el
  hash/tamaño del prompt. Ese smoke **DEBE** exigir seis pruebas distintas. En
  los tres harnesses, el prompt posterior a `scout` **DEBE** transportar el ID
  oculto entre una y tres veces y cada evidencia intermedia entre una y tres;
  la evidencia final puede omitirlo. Copiar el marcador inmediato literal es
  preferido y se reporta, pero una paráfrasis acotada con el mismo ID también
  demuestra transferencia. Un marcador propio, si aparece, no puede repetirse;
  cualquier marcador ajeno, stale o duplicado invalida la corrida. No puede
  copiarse la respuesta completa del predecesor. La comparación **DEBE**
  canonicalizar al menos wrappers de blockquote y fences Markdown para que
  citar o encerrar toda la respuesta no evada la prueba.
- Toda verificación `node --test` anidada **DEBE** indicar el archivo de prueba
  y eliminar `NODE_TEST_CONTEXT` del entorno heredado; de otro modo un worker
  del runner padre puede terminar en verde sin ejecutar la fixture.
- Cada entrypoint live **DEBE** usar el runner nativo
  `node --import tsx --test`, propagar código de salida o señal y, además,
  exigir un reporte fresco con schema esperado y `status: passed`. **DEBE**
  borrar primero su reporte previo,
  de modo que una caída antes de escribir no pueda reutilizar evidencia stale;
  también **DEBE** rechazar timestamps no ISO, inválidos, futuros o, en el modo
  de verificación aislada, con más de 24 horas;
  un runner o integración que imprima fallo
  pero devuelva cero **NO DEBE** producir un falso verde.
- La suite offline **DEBE** consumir el reporte TAP del runner nativo, exigir un
  único resumen, al menos un test y `fail: 0`, además del código/señal. No puede
  confiar sólo en `process.exitCode`, porque código de host cargado durante una
  suite puede alterarlo después de que Node haya registrado un fallo.
  Tanto este wrapper como el live **DEBEN** eliminar `NODE_TEST_CONTEXT` antes
  de iniciar un runner hijo.
- Los scripts npm de suite y live **NO DEBEN** encadenar `npm run ... && ...`.
  Un único wrapper Node ejecuta build y runner como children, valida cada
  código/señal y termina explícitamente con 1 ante cualquier fallo.
- Los hooks Copilot **DEBEN** aceptar las dos representaciones estructuradas
  observadas del host (`object` o JSON serializado que decodifique a un objeto)
  con tamaño acotado y rechazar cualquier otra forma. **NO DEBEN** efectuar RPC
  reentrante desde `preToolUse`: usan un snapshot de agentes verificado fuera
  del hook, fallan cerrados si no está disponible, lo refrescan tras mutaciones
  nativas y vuelven a validar ownership en disco en cada dispatch. Un refresh
  **NO DEBE** sobrescribir un evento raíz `selected|deselected` más reciente;
  un epoch de selección y una prueba con `reload()` retardado verifican esta
  precedencia.

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
- `package.json` **DEBE** declarar los exports servidor y TUI de OpenCode, la
  extensión Pi y el bin universal. El plugin Copilot **DEBE** contener su
  configuración, el runtime MCP compilado estable y la extensión de controles
  directos; desactivar lo experimental sólo **PUEDE** degradar esos controles a
  su fallback, no romper el lifecycle compartido.
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
- Copilot CLI 1.0.71 requiere modo experimental para sus comandos de extensión.
  Con él, los cuatro controles deterministas **DEBEN** resolverse como comandos
  `client`; sin él, los wrappers Markdown mínimos permanecen como fallback
  mediado por modelo. Los cinco wrappers llaman una sola vez al tool
  estructurado `control`; sólo `/contract` llama después al `task` nativo.
- El MCP Copilot hereda el working directory al iniciar la sesión. La extensión
  directa **DEBE** leer el `workingDirectory` actual de los metadatos de sesión
  para respetar cambios de carpeta; ningún path elegido por el modelo se acepta
  como argumento del tool.
- La API TUI de OpenCode 1.18.3 no entrega argumentos al callback slash. Por eso
  usa nombres directos inequívocos y diálogos; los cinco comandos canónicos se
  conservan como fallback, y el CLI directo conserva la sintaxis exacta sin
  inferencia.
- Una cadena SDLC completa es opt-in; `team-lead` elige la secuencia mínima de
  uno a seis children y `/contract` continúa eligiendo exactamente uno.

## 8. Matriz de trazabilidad

| ID | Requisito esencial | Evidencia obligatoria |
| --- | --- | --- |
| NAT-01 | Entrypoints, roles y loader nativos | `distribution declares native TypeScript entrypoints`, `Copilot plugins expose canonical commands and one plugin-provided MCP server` y `installed CLIs discover the native packages` |
| EFF-01 | Core único, un build y mínimo trabajo por comando | `Copilot runtime is generated byte-for-byte from shared core`, matriz de cinco comandos, smokes concurrentes y contenido de `npm pack --dry-run --json` |
| TOK-01 | Ruta cero modelo para controles deterministas y para ver la banca en cada distribución | `every distribution has a direct zero-model bench entrypoint`, `OpenCode TUI exposes direct controls that bypass sessions and models`, `Pi deterministic command handlers never enter the SDK orchestrator`, aserción de orquestador vacío en la matriz de contratos y smoke Copilot de comando `client` sin eventos `assistant.usage` ni `assistant.message` |
| CMD-01 | Cinco comandos con semántica común | matriz `*: all five commands share the executable contract` para los tres harnesses |
| VAL-01 | Schema cerrado, límites y cero children ante error | `validation rejects every non-canonical player shape`, `join rejects an oversized rendered profile` y `contract rejects invalid input before creating any child` |
| OWN-01 | Ownership completo, colisiones, traversal y symlinks | `ownership metadata must remain complete`, `ownership rejects duplicate metadata and the wrong roster class`, `all harnesses reject unknown fields and unmanaged collisions`, `leaf symlinks are rejected` y `ancestor symlinks and traversal-shaped IDs are rejected` |
| TXN-01 | Lock, preflight, reemplazo atómico y rollback byte-idéntico | `concurrent roster mutations are serialized`, `bench preflights a whole batch` y `a failed multi-file mutation restores the complete prior state` |
| CON-01 | Un child, allowlist cerrada y cleanup sin pérdida de errores | pruebas de los tres orquestadores, `SDK orchestrators clean up child sessions when prompting fails`, `SDK orchestrators preserve execution and cleanup failures together` y aserciones `"*": false`/`executionMode: "sequential"` |
| AGT-01 | Tres roles activos por defecto y seis bundled opt-in, invocables sin router | `the factory roster has exactly three active roles and six opt-in SDLC players`, `all harness rosters expose only fixed roles until owned SDLC profiles are activated`, `installed CLIs discover the native packages` y pruebas de comandos exactos por adapter |
| ORC-01 | Despacho secuencial nominal, evidencia entre etapas, límite, no recursión y cleanup | `Copilot team-lead hooks enforce exact active sequential delegation across user turns`, `OpenCode named runner dispatches every fixed and activated ID exactly`, `OpenCode team lead dispatches exact active agents sequentially without a router` y `Pi team lead delegates sequentially to different active agents with bounds and preflight` |
| EVD-01 | Dataset literal común, identidades runtime y traza correlacionada sin contenido sensible | `the Harbor cycle dataset is literal, closed, and independent from runtime catalogs`, `the full Harbor dataset cycle activates, dispatches, hands off evidence, and cleans every SDK child`, `the default Harbor cycle dispatches both startup specialists with evidence and cleanup`, `evidence hooks retain only hashes and byte lengths`, `a failing async evidence collector cannot alter child execution or cleanup`, `creation, prompt, and cleanup failures produce bounded truthful evidence traces` y las tres pruebas ORC-01 alimentadas por el mismo dataset |
| LIV-01 | Selección semántica y comunicación eficiente con inferencia real en Copilot, OpenCode y Pi | smoke Copilot opt-in `live Copilot team-lead selects and orchestrates the Harbor SDLC cycle efficiently` y smokes `live opencode|pi team-lead selects and orchestrates the Harbor SDLC cycle with Codex`: candidatos desordenados, nonce oculto acotado, seis children nativos correlacionados, secuencia exacta, concurrencia máxima uno, identidad/terminación nativas, ausencia de marcadores stale/duplicados, presupuestos raíz/child/total, fixture verificada, tokens positivos, cleanup y reportes sanitizados. Evidencia autenticada 2026-07-20: OpenCode 1.18.3 con `openai/gpt-5.3-codex-spark`, `medium`, 103.674 ms, 19 turnos, 18 tools y 44.544 tokens; Pi 0.80.10 con `openai-codex/gpt-5.3-codex-spark`, `low`, 31.110 ms, 19 turnos, 18 tools y 38.840 tokens; ambos sin fallback Luna, verificación positiva y cleanup |
| COP-01 | MCP estructurado, preflight compartido y runtime generado | `Copilot native control performs deterministic shared contract preflight`, `compiled Copilot MCP server is bounded, fails closed, and inherits its invocation paths`, `Copilot runtime is generated byte-for-byte from shared core`, `generated native runtime retains gh timeout and MCP cancellation guards` y smoke ACP `agent-harbor (connected, plugin)` |
| GH-01 | Referencias canónicas, snapshot read-only y body invocation-local | `GitHub references are bounded...`, `GitHub resolver pins one branch and one exact blob with two read-only cancellable gh calls`, `default gh runner enforces its process timeout`, `GitHub skill bodies are snapshot-loaded...` y `contract skills are validated and materialized before any SDK child...`; POC manual autenticado con `gh` |
| PI-01 | API real de Pi, comandos de roles, delegación nominal y sesión en memoria | smoke de `createAgentSession`, RPC `get_commands`, `Pi extension invokes every fixed and activated agent and equips the team lead for named delegation` y `Pi team lead delegates sequentially to different active agents with bounds and preflight` |
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
base y las rutas TOK-01 no requieren modelo, API key, Docker ni red. Una
modificación de lifecycle, ownership, adapter, superficie directa u orquestador
**DEBE** incluir una regresión proporcional.

Las aceptaciones live del coordinador se ejecutan por separado, requieren el
harness autenticado correspondiente y consumen tokens intencionalmente:

```text
# Copilot
npm run test:live:lead

# OpenCode o Pi por separado
npm run test:live:opencode
npm run test:live:pi

# OpenCode y Pi juntos
npm run test:live:codex
```

Debe ejecutarse al menos una vez para una entrega que cambie selección,
handoff, hooks nativos o el contrato de `team-lead` en el harness afectado.
`test:live:codex` cubre OpenCode y Pi; Copilot conserva su entrypoint separado.
Cada wrapper borra reportes anteriores y exige evidencia nueva; su modo
`--verify-report-only` sólo acepta reportes `passed`, con schema y timestamp
válidos. El resultado live no sustituye el gate offline ni convierte controles
deterministas en rutas con modelo.

## 10. Decisiones OSS ya cerradas

Las alternativas enumeradas en `AGENTS.md` no reemplazan el core porque no
reúnen simultáneamente roster persistente, ownership transaccional, child
desechable, snapshots privados y paridad nativa. Sólo se reabre esa decisión
ante un cambio material upstream y un POC que cubra colisiones, actualización,
cleanup y descubrimiento real en los tres harnesses.
