# Requisitos normativos de Agent Harbor

Este documento define el alcance de Agent Harbor 0.12. Las palabras **DEBE**,
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
`/list-skills`, además de `team-lead` y `crafter` mediante
el mecanismo nativo de agentes de cada harness.

Esos dos roles fijos **DEBEN** estar activos al iniciar y permanecer separados
de los seis compañeros SDLC bundled: `portfolio-management`, `design`, `build`,
`manage`, `consume` y `dispose`. Los seis **DEBEN** empezar en banca y sólo
pasan a ser invocables en el proyecto mediante `bench on`. La suite **DEBE**
distinguir ambos estados y probar los ocho nombres después de `bench on all`.

Fixed roles **MUST** load from `src/core/roles/*.md`, and bundled peers **MUST**
load from `src/core/bundled/*.md`. Both directories **MUST** use the same
closed-frontmatter loader: matching filename and `name`, unique `order`, known
tools, a non-empty Markdown body as the prompt, and the same structured skill
references accepted by `/join`. A `repo` reference **MUST** be relative to the
current project; a `github` reference **MUST** match an exact trusted reference
or an exact `SKILL.md` path under a trusted repository root. The build **MUST**
copy both definition directories into the package
and the Copilot runtime.

Cuando se requiere el ciclo completo, esos compañeros representan, en orden:

- `portfolio-management`: encuadre de valor, prioridad, alcance, criterios de
  aceptación, dependencias y riesgo basado en evidencia;
- `design`: diseño mínimo respaldado por evidencia y criterios explícitos de
  terminación;
- `build`: implementación acotada del diseño aprobado;
- `manage`: verificación, operación y evidencia reproducible del cambio;
- `consume`: validación de corrección, seguridad, cobertura, usabilidad y valor
  desde la perspectiva del consumidor;
- `dispose`: plan de cierre, retención, decommission, rollback y fin de vida;
  esta etapa nunca ejecuta eliminación destructiva ni deshace el build.

Fuera de una aceptación que exija el ciclo completo, `team-lead` **DEBE** elegir
sólo el subconjunto mínimo de compañeros necesario para la tarea.

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
4. `scripts/build.mjs`: compilación y copia del runtime nativo de Copilot;
5. `dist`: artefacto generado; nunca fuente editable.

Los adapters **NO DEBEN** reimplementar reglas de negocio. Copilot **DEBE**
incluir una copia generada de `src/core` dentro del plugin; OpenCode y Pi
**DEBEN** importar el mismo `dist/core`. No se mantienen generadores Python ni
paquetes runtime paralelos.

Los prompts de roles **PUEDEN** ser específicos por harness, pero **DEBEN** mantener
la misma responsabilidad y el mismo límite de herramientas. Los comandos de
lifecycle no pueden depender de decisiones del modelo.

Pi **NO DEBE** representar un player únicamente como prompt estático: su
extensión registra los dos roles fijos y cada perfil activo con ownership
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
- `/team` en Copilot, OpenCode y Pi **DEBE** ser un control nativo cero modelo. Consultar,
  filtrar o detener trabajo **NO DEBE** enviar un prompt ni crear una sesión o
  child para producir la vista.
- El paquete **DEBE** ofrecer
  `agent-harbor <copilot|opencode|pi> <bench|join|retire|list-skills>` como ruta
  directa portable. Los adapters **DEBEN** preferir además la superficie nativa
  más eficiente disponible:

  | Harness | Superficie directa preferida | Fallback |
  | --- | --- | --- |
  | Copilot CLI | comandos de extensión `client` para `/team`, `/bench`, `/join`, `/retire` y `/list-skills` | CLI directo para los cuatro controles de lifecycle; no existe fallback skill mediado por modelo |
  | OpenCode | ocho entradas TUI directas: `/team`, banca on/off/list, join, retire y skills list/filter | CLI directo; los cinco comandos canónicos del servidor pueden ser mediados por modelo |
  | Pi | handlers `registerCommand` para los cuatro nombres canónicos y `/team` | CLI directo |

- `/contract` válido **NO ES** cero modelo: su preflight **DEBE** ser
  determinista y después **DEBE** crear exactamente un child. Un fallo de
  preflight crea cero children.
- Una invocación explícita de un especialista **NO ES** cero modelo, pero
  **DEBE** apuntar directamente al agente seleccionado sin una inferencia de
  routing. Copilot y OpenCode **PUEDEN** cambiar el agente de la sesión actual;
  Pi **PUEDE** crear una sesión en memoria. Una tarea vacía, un ID desconocido,
  un bundled apagado o un perfil sin ownership **DEBEN** fallar antes de enviar
  el prompt.
- En Pi, todo fallo de preflight de un comando que normalmente usaría modelo
  **DEBE** ocurrir antes de crear la sesión, el child o un root de actividad y
  **DEBE** declarar `Preflight stopped · no model was called · 0 model tokens.`
  Esto incluye JSON inválido, tarea vacía, alias inactivo, modelo no disponible,
  miembro persistente ocupado y exceso de capacidad del lead o de roots. Un
  rechazo dentro de un lead ya iniciado **NO DEBE** presentar como cero el uso
  real que esa misión ya haya consumido.
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
- Un perfil administrado canónico **DEBE** hacer coincidir filename, `name`,
  `owner`, `roster`, `player`, `revision: "5"` y el marcador exacto de
  ownership. La revisión 5 **DEBE** incluir una definición codificada
  recuperable por los tres adapters para autorizar la configuración propia del
  player.
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
- La revisión canónica es `5`. Una revisión 4 exacta y estructuralmente válida
  **DEBE** reconocerse sólo como ownership heredado y estado `stale`: permite
  reparación explícita segura, pero nunca invocación. Cualquier metadata que no
  sea una revisión 4 heredada exacta ni una revisión 5 exacta **DEBE** tratarse
  como colisión no administrada y nunca justificar reemplazo o eliminación.

## 4. Comandos

### `/bench`

- Acepta vacío, `list [filter]`, `on <ids|all>` u `off <ids|all>`; no existe
  `toggle`.
- `all` significa, en orden: `portfolio-management`, `design`, `build`,
  `manage`, `consume`, `dispose`.
- `on` escribe sólo la copia activa; `off` elimina sólo una copia activa con
  ownership probado y conserva el registro personal recuperable.
- Los lotes son atómicos. El listado no muta ni usa red y distingue `on`,
  `bench`, `stale` y `conflict`.
- Ver la banca **DEBE** completar con cero tokens de modelo en Copilot, OpenCode
  y Pi mediante su superficie directa documentada.

### `/team` (Pi)

- Pi **DEBE** registrar `/team [filter|stop <run-id|all>]` como comando nativo.
  Consultar, filtrar o detener **NO DEBE** usar red, mutar el roster, crear una
  sesión SDK o un child ni enviar un prompt; cada resultado **DEBE** declarar
  `0 model tokens`.
- La vista sin filtro **DEBE** caber en un overview dinámico de hasta 30 líneas
  envueltas a 96 celdas. **DEBE** conservar los nueve IDs factory al menos con
  clase y estado efectivo, el resumen global, acceso del lead y cobertura SDLC;
  el espacio restante **PUEDE** mostrar personales, roots/children activos y la
  última misión terminal. Todo miembro personal o run omitido **DEBE** tener un
  conteo exacto y un filtro accionable para recuperarlo. Los contractors sólo
  aparecen como actividad de su misión, no como miembros persistentes.
- El filtro **DEBE** buscar sobre IDs, estado, rol y metadata pública, modelo y
  etiqueta segura. La vista filtrada **PUEDE** conservar más detalle que el
  overview y no necesita repetir los nueve factory ajenos al filtro, pero cada
  línea sigue acotada a 96 celdas. El historial filtrado sólo muestra miembros
  coincidentes y **NO DEBE** presentar su suma parcial como total de misión; la
  fuente en memoria conserva el árbol y la contabilidad completos aunque el
  overview omita filas con conteo. Cada run detallado **DEBE** exponer ID, parent
  cuando exista, agente, clase, estado, duración, etiqueta segura, modelo,
  thinking setting, turnos de modelo y usage nativo.
- Pi **DEBE** aceptar como máximo 32 roots concurrentes por proyecto. Un intento
  adicional **DEBE** fallar antes de crear actividad, sesión o child, indicar
  cómo esperar o detener y declarar el preflight cero modelo. Los roots ya
  admitidos **NO DEBEN** podarse y todos permanecen visibles y detenibles.
- El runtime **PUEDE** conservar como máximo 32 misiones root terminales y sólo
  puede podar una cuando su root y todos sus children sean terminales. Este
  límite de historial es independiente del límite de concurrencia.
- `team-lead` **DEBE** aceptar como máximo 32 especialistas enabled en su schema;
  `enabled` significa presentes y listos en el roster, mientras `active` queda
  reservado para runs vivos `starting`, `working` o `cleaning`.
  Un roster mayor **DEBE** fallar antes de crear el root, con el preflight cero
  modelo, y `/team` **DEBE** mostrar el exceso y una reparación accionable.
- Antes de iniciar un root o una delegación, Pi **DEBE** bloquear double-booking
  de un miembro persistente enabled que ya tenga un run activo en el mismo
  proyecto. Un contractor efímero
  con el mismo nombre no ocupa al miembro, aunque sigue sujeto al cap de roots;
  el rechazo nunca crea otro run o child y no altera la telemetría ya observada.
- Cada root **DEBE** tener un `AbortController` propio combinado con la señal del
  caller. `/team stop <run-id>` solicita cancelar un root activo del proyecto y
  `all` los solicita todos; `Alt+H` **DEBE** ofrecer el mismo stop-all en TUI
  incluso si Pi no entregó señal al slash original.
- La espera del handler **DEBE** competir contra esa señal de abort. Si el
  provider no la respeta, el run **DEBE** asentarse localmente como `cancelled`,
  dejar de ocupar capacidad y limpiar status/widget sin esperar indefinidamente.
  La UI **NO DEBE** afirmar por ello que el cómputo remoto se detuvo; el cleanup
  subyacente permanece best-effort cuando el provider retorne.
- `/team stop all` sin roots activos **DEBE** ser un éxito informativo e
  idempotente. Un run ID desconocido **DEBE** seguir siendo error.
- En `session_shutdown`, la extensión **DEBE** abortar todos los roots que aún
  controla y esperar su cleanup de forma best-effort durante como máximo cinco
  segundos; un provider que no termina no puede prolongar esa espera. Status y
  widget **DEBEN** limpiarse en `finally` cuando el handler se asienta, incluso
  ante fallo, cancelación o error de cleanup.
- La telemetría **DEBE** leer el modelo y thinking setting efectivos de la sesión
  Pi. Antes de una respuesta nativa, el modelo es `configured` si la definición
  declara `model`, o `inherited` si usa la selección del host; después usa
  `provider` y `responseModel ?? model` como `observed`. Múltiples modelos se
  muestran como `mixed observed`, sin atribuir una respuesta a un modelo no
  observado.
- El placeholder Pi 0.80.10 `provider: "unknown"`, `id: "unknown"`,
  `api: "unknown"`, `maxTokens: 0` —y un `model` ausente— **DEBE** combinarse
  con la instantánea pública del registry. Con catálogo sano y vacío, la vista
  dice `unavailable (Pi reports no usable models; use /login)`; con modelos
  utilizables pero sin selección dice `not selected (N available; use /model)`;
  con error o telemetría ausente dice que la disponibilidad no fue observada.
  **NO DEBE** mostrar el placeholder como modelo heredado ni el cero como límite
  real, y **NO DEBE** anunciar delegación posible en ninguno de esos tres
  estados sin modelo activo.
- Los aliases Pi, `/contract` sin modelo y `/scout` **DEBEN** validar modelo,
  disponibilidad y auth antes de crear un root o una sesión. Un rechazo dirige
  a `/model` o `/login`, crea cero children y conserva cero uso observado. Un
  modelo explícito válido puede ejecutarse aunque el host no tenga una selección
  heredada. El child **DEBE** recibir el mismo `agentDir` que usa el host. Los
  providers registrados en memoria que requiera el modelo o el snapshot del
  team lead **DEBEN** reproducirse mediante las APIs públicas de `ModelRuntime`,
  sin volver a cargar extensiones. Una credencial cuyo origen sea `runtime`
  **DEBE** copiarse sólo en memoria y **NO DEBE** persistirse ni sustituir la
  semántica de una credencial OAuth.
- Usage **DEBE** acumular una sola vez `input`, `output`, `reasoning`, cache
  read/write y `totalTokens` de mensajes assistant nativos. Un campo ausente
  significa desconocido; un objeto nativo presente con campos explícitos en
  cero **DEBE** conservar esos ceros. Una combinación contradictoria **DEBE**
  dejar desconocido sólo el campo contradictorio. Si un agregado combina una
  contribución conocida con otra desconocida **DEBE** mostrar `≥N`; sin
  contribución conocida muestra `—`. `reasoning` **NO DEBE** sumarse otra vez
  al total del provider. La deduplicación evento/transcript **DEBE**
  distinguir respuestas distintas aun si carecen de `responseId` y comparten
  timestamp, forma, longitud y usage; cualquier huella de contenido **DEBE** ser
  opaca, efímera y no reversible, y el contenido nunca se retiene.
- El registro de observabilidad **DEBE** vivir sólo en memoria del proceso Pi y
  separar proyectos. **NO DEBE** retener prompts, respuestas ni contenido de
  thinking. Sólo **PUEDE** conservar una etiqueta heurística de hasta 72
  caracteres que normaliza controles y oculta patrones comunes de paths, URLs,
  bearer/JWT, credenciales y prefijos de secretos. Esta heurística **NO DEBE**
  presentarse como detector universal de secretos.
- La metadata ofrecida al lead **DEBE** limitarse a ID, rol público acotado,
  tools, hasta 12 nombres de skills, procedencia del modelo y estado busy. Pi
  **PUEDE** inyectar en la descripción de delegación un preview orientativo de
  hasta 1.500 caracteres; ese preview declara omisiones y no sustituye la
  consulta autoritativa. `harbor_team_roster` acepta un query de hasta 80
  caracteres y devuelve el roster enabled completo de hasta 32 filas/16 KiB o,
  si no cabe, un diagnóstico sin filas. Ninguna de las dos vistas incluye
  prompts, respuestas, campos de path ni contenido de skills; los patrones
  comunes de paths que aparezcan dentro de metadata pública se sustituyen.
- Cada línea humana de `/team`, reportes, status, widget y tablas de skills
  **DEBE** ocupar como máximo 96 celdas de terminal: ANSI cuenta como ancho
  cero, una secuencia ANSI nunca se parte, los grafemas combinados permanecen
  unidos y los caracteres CJK/emoji anchos ocupan dos celdas. La indentación
  excesiva **DEBE** acotarse con progreso garantizado y un introducer ANSI sin
  terminador **DEBE** eliminarse antes de renderizar su payload como texto.

### `/team` (OpenCode)

- OpenCode **DEBE** registrar `/team` en la TUI como control directo cero
  modelo. Su diálogo acepta vacío, filtro, `help`, `stop <run-id>` o `stop all`;
  ninguna ruta válida **DEBE** enviar un prompt ni crear una sesión o child.
- La vista **DEBE** combinar el roster ownership-checked con actividad nativa
  del proyecto y distinguir trabajo directo, delegado y contractor. Sólo
  **PUEDE** atribuir parent observado o, marcado como inferido, el único lead
  directo activo. No **DEBE** inventar historial terminal que OpenCode no
  expone de forma autoritativa.
- En 45 filas, la vista sin filtro **DEBE** mostrar los nueve miembros factory
  completos al menos por ID/kind/status dentro de 30 líneas envueltas a 96
  columnas. El presupuesto restante **DEBE** asignarse dinámicamente a
  personales y actividad; toda omisión lleva conteo y filtro accionable.
  Filtros amplios y múltiples runs **DEBEN** permanecer compactos dentro de ese
  mismo límite; filtros estrechos conservan detalle rico. La vista filtrada se
  identifica como tal y no presenta sus coincidencias como roster completo.
- Un child desechable **DEBE** probar ownership mediante un claim HMAC ligado a
  proyecto, ID nativo, agente e invocation. Una sesión directa **DEBE** probar
  el agente raw exacto contra un miembro no conflictivo. Mensajes históricos
  nunca **DEBEN** otorgar ownership y no se leen antes de esa prueba.
- Los IDs de sesión nativos **NO DEBEN** aparecer en snapshot, vista ni resultado
  de stop. Cada run usa un alias `run-<digest>` estable sin prefijo nativo; la
  frontera del turno directo también se conserva sólo como digest.
- La proyección de mensajes **NO DEBE** retener ni mostrar respuestas,
  reasoning, tool input/output, snapshots o errores nativos. Sólo conserva
  metadata mínima, números nativos y una etiqueta de tarea acotada/redactada.
- Las tools de lead, scout y skills **DEBEN** proyectar fallos SDK/Gh/loader a
  un error público acotado/redactado, sin `cause` ni nombre host crudo, y
  preservar `AbortError` para cancelación. La evidencia exitosa no se altera.
- Usage directo **DEBE** pertenecer al turno actual; usage de un child firmado
  **PUEDE** cubrir su sesión completa. Cero explícito sigue siendo observado,
  ausencia sigue siendo desconocida y truncamiento/overflow se muestra como
  límite inferior, nunca total exacto.
- Stop **DEBE** refrescar estado activo y volver a probar inmediatamente antes
  de cada interrupt la sesión, ownership y generación/turno exactos. Si la
  discovery global es incompleta, `all` falla cerrado; un run visible exacto
  sólo puede continuar si su recheck individual es autoritativo. La UI **DEBE**
  declarar que OpenCode no ofrece compare-and-interrupt atómico.
- Un interrupt confirmado **NO DEBE** convertirse en “stop failed” porque el
  refresh best-effort posterior falle. Se conserva el resultado committed y se
  informa por separado que la vista no pudo refrescarse. El resultado de stop
  **NO DEBE** concatenar otro roster; dirige a `/team`.
- Una lectura **DEBE** acotarse a 64 sesiones, 32 activas, 24 fanouts de
  mensajes, 16 mensajes por sesión, concurrencia cuatro y deadlines. Inputs se
  rechazan antes del backend por encima de 4 KiB, excepto join (30 KiB) y
  selector/retire (256 bytes).
- Como máximo 32 lifecycles disposable pueden estar activos o pendientes de
  cleanup. Cleanup normal, tardío o sin claim recibe dos deletes acotados. Si ambos
  fallan, nuevas delegaciones/contratos del proyecto quedan bloqueados: el
  usuario **DEBE** inspeccionar y eliminar la sesión nativa pending o firmada y
  luego recargar. Reload sólo libera el guard process-local; no elimina el
  orphan.
- El roster/delegate/direct preflight **DEBE** consultar actividad v2
  autoritativa acotada y unir reservations process-local `starting|working|cleaning`;
  no puede anunciar ready ni double-bookear actividad nativa externa.
- `/harbor-retire` **DEBE** rechazar un personal con cualquier run directo,
  delegado o reservation activo y repetir el snapshot autoritativo justo antes
  de mutar. Colisiones detectadas por el config hook **DEBEN** aparecer
  como `conflict` y no pueden autorizar ownership directo.
- `ContractDefinition.model` **DEBE** validarse como `provider/model` acotado y
  pasarse a `session.prompt.body.model`; provider/model/variant del host se
  acotan antes de trim, ledger, reservation o create.

### `/team` y `/player` (Copilot)

- Copilot **DEBE** registrar `/team [filter|stop <run-id|all>]` y
  `/player <id> <task>` como comandos `client`. `/team` y el preflight inválido
  de `/player` **DEBEN** conservar idénticos los contadores nativos de uso antes
  y después de la invocación.
- La vista general **DEBE** caber en un overview dinámico de hasta 30 líneas
  envueltas a 96 celdas y conservar los nueve IDs factory con clase y estado
  efectivo. El espacio restante **PUEDE** mostrar personales y actividad; toda
  omisión **DEBE** indicar el conteo exacto y filtros `kind:personal`,
  `member:<id>` o `run:<id>`. El resumen conserva disponibilidad, acceso del
  lead, cobertura SDLC y reparación. Una vista filtrada **PUEDE** retener más
  detalle y no necesita repetir miembros ajenos al filtro, pero cada línea sigue
  acotada a 96 celdas.
- Cada run **DEBE** mostrar ID process-local, parent, miembro, clase, estado,
  duración, etiqueta segura, modelo y reasoning
  configurado/heredado/observado, llamadas nativas y usage. Campos nativos
  ausentes son desconocidos y agregados
  parciales son límites inferiores, nunca ceros o totales inventados.
- Si `model.getCurrent()` no informa modelo o devuelve vacío, `unknown`,
  `unknown/default` o `default`, la vista **DEBE** decir `no model reported
  (unobserved)`; **NO DEBE** convertir el sentinel en un modelo efectivo.
- El registro **DEBE** vivir sólo en memoria, separar proyectos y no persistir
  prompts, respuestas, resultados, errores ni reasoning. Sólo conserva la
  misma etiqueta heurística acotada y redactada descrita para Pi; identificadores
  nativos usados para deduplicar se transforman con una clave efímera privada.
- El runner directo **DEBE** validar actividad y ownership, bloquear roots por
  encima de 32 y double-booking de miembros persistentes, conservar el orden de
  selección con un lock, suscribirse a eventos antes de enviar, seleccionar el
  agente exacto y ejecutar exactamente un `session.send` por tarea admitida.
- `session.idle`, idle abortado y `session.error` son terminales. Tras terminal,
  el runner **DEBE** desuscribirse y restaurar la selección previa. Si ejecución
  y restore fallan, **DEBE** conservar ambos fallos en un `AggregateError`.
- Al expirar el timeout, el runner **DEBE** pedir abort y esperar settlement de
  forma acotada. Si no llega terminal, **NO DEBE** restaurar ni permitir otra
  selección; conserva la selección hasta que el evento tardío termine el run.
- `/team stop <run-id|all>` **DEBE** limitarse a roots activos controlados en el
  proyecto actual. `all` sin trabajo es éxito informativo; un ID desconocido es
  error. Detener no implica que el run sea terminal hasta observar settlement.
- El lifecycle de `team-lead` **DEBE** correlacionar root/child con IDs nativos
  sin contenido. Antes de permitir el `task`, un admission hook síncrono **DEBE**
  comprobar parent, proyecto, capacidad y double-booking; un rechazo no consume
  el contador ni deja la sesión marcada in-flight.
- Los aliases `/<id>` cubren fixed, bundled y personales enabled al arrancar.
  `/player` **DEBE** resolver el roster actual, de modo que un `/join` exitoso
  **PUEDE** ser invocable en la misma sesión sin esperar a que el host registre
  otro alias, siempre que el refresh nativo lo confirme `ready` y no falte su
  loader ligado de startup.

### `/join`

- Recibe exactamente un objeto JSON con `name`, `description`, `prompt` y una
  lista no vacía de `tools`; sólo admite además `model`, `replace` y `skills`.
- Rechaza claves desconocidas, valores inseguros, tools desconocidas o
  duplicadas, descripción multilínea y perfiles mayores de 30.000 bytes UTF-8.
- Toda metadata pública persistida o renderizada, incluidas `description` y
  `model`, **DEBE** rechazar controles C0/C1/Cf y ANSI. `prompt` **PUEDE** ser
  multilínea porque no se muestra en el roster ni en la telemetría.
- Escribe registro y copia activa byte-idénticos y los verifica.
- Las superficies nativas Pi y Copilot **DEBEN** resumir ID, rol, capacidad
  efectiva (tools y nombres de skills) y modelo configurado o herencia del host
  sin revelar paths administrados. El contrato común devuelve además el alias
  nominal `/<name> <request>`. El host
  **DEBE** registrar ese alias automáticamente desde la copia activa: Pi en la
  sesión actual y Copilot/OpenCode al cargar o recargar su configuración de
  comandos. No se requiere crear manualmente otro archivo ni editar
  configuración.
- Copilot **PUEDE** resolver el player recién unido mediante `/player` en la
  misma sesión cuando el refresh nativo lo confirma `ready` y no requiere una
  custom tool nueva. Como la API pública fija el conjunto de tools al ejecutar
  `joinSession`, un player con `skills`
  **DEBE** pedir `/reload` sólo cuando su loader `harbor_skill_<id>` no estaba
  registrado al arrancar. Si el loader ligado ya existe —por ejemplo, al
  reemplazar el mismo ID que arrancó con skills— `/player` **DEBE** poder usar
  la definición vigente sin recargar. Un alias de conveniencia para un ID nuevo
  sigue requiriendo reload del discovery del host.
- La confirmación Copilot de `/join` **DEBE** separar commit de roster y
  disponibilidad nativa: informa `registered`, dirige a
  `/team member:<id>` y sólo presenta `/player <id> <task>` como utilizable
  cuando esa vista autoritativa diga `ready`. **NO DEBE** prometer `ready` ni
  `Run now` únicamente porque la transacción haya terminado.
- `skills` admite como máximo tres referencias con nombres únicos. Cada entrada
  es exactamente una referencia `repo` al `SKILL.md` relativo al proyecto o
  una referencia GitHub exacta cubierta por una referencia o root de la
  allowlist incorporada. Una lista no vacía
  requiere `read`, no concede ni requiere `execute`, y no descarga cuerpos
  durante `join`. Campo omitido y lista vacía significan cero skills.

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
  usa su `task` nativo exactamente una vez. El wrapper user-invoked sólo expone
  `harbor_contract`; el hook previo acepta una vez el objeto cerrado
  `{definition:string}`, y el handler autentica identidad de sesión, llamada,
  nombre y argumentos antes de sellar el descriptor cerrado que autoriza ese
  único `task`. Ni un resultado nativo posterior ni una tool de nombre parecido
  pueden autenticar o sustituir el descriptor. El entrypoint programático usa
  `@github/copilot-sdk`. OpenCode usa el cliente recibido de
  `@opencode-ai/plugin` y Pi usa `createAgentSession` de
  `@earendil-works/pi-coding-agent`.
- Toda skill configurada se valida antes de crear el child. Las referencias
  `repo` deben permanecer físicamente dentro del proyecto sin symlinks; las
  GitHub se fijan a un commit antes de descargar el archivo exacto. Un fallo en
  cualquier miembro produce cero children.
- El child recibe la traducción least-privilege disponible en su SDK. Ninguna
  allowlist de prompt se presenta como sandbox del sistema operativo. OpenCode
  **DEBE** empezar cada política con `"*": false` y habilitar sólo los nombres
  explícitos y mantener su tool ambiental `skill` deshabilitado en contratos;
  Pi **DEBE** desactivar extensiones y skills descubiertas, registrar sólo
  paths exactos de la cápsula y declarar `harbor_delegate` como
  `executionMode: "sequential"`.
- Si ejecución y cleanup fallan, el orquestador **DEBE** preservar ambos errores
  en un `AggregateError`; nunca debe ocultar que el child pudo quedar vivo.
- Pi **DEBE** entregar sus custom tools exclusivamente dentro de la sesión child
  que las necesita. La extensión no las registra como tools globales: un lead
  recibe sólo delegación y consulta de roster; el recruiter recibe sólo
  consulta de roster, filtro de skills y join; un contractor ordinario no
  hereda ninguna de ellas.

### Invocación y delegación nominal

- Copilot **DEBE** registrar comandos `client` `/<id> <task>` para los
  dos roles fijos, los seis compañeros bundled y los perfiles activos conocidos al
  iniciar. El handler **DEBE** recargar discovery, resolver el ID estable o el
  path exacto administrado, seleccionar el agente, enviar el task una sola vez
  y restaurar la selección después de un terminal nativo. Un bundled apagado
  falla sin inferencia. `/player <id> <task>` **DEBE** ofrecer la misma ruta
  segura para cualquier perfil activo al momento de invocar.
- El `task` nativo de `team-lead` en Copilot **DEBE** pasar por un hook de código
  que sólo permita el `agent_type` exacto de un player Agent Harbor activo,
  rechace nested delegation y recursión, impida dos llamadas simultáneas y
  cuente como máximo seis por prompt de usuario.
- OpenCode **DEBE** registrar `<id>` con `template: "$ARGUMENTS"`, el
  `agent` exacto y `subtask: false`; así evita tanto el router como el resumen
  adicional del padre. Un hook **DEBE** revalidar tarea, actividad y ownership
  al ejecutar incluso si el alias quedó cargado después de `bench off`.
  `team-lead` **DEBE** recibir sólo `harbor_team_roster` y
  `harbor_delegate`. La consulta devuelve el roster enabled completo, modelo
  configurado y disponibilidad `ready|busy`; el target de delegación se
  revalida al invocarse, de modo que incluya players unidos durante la sesión
  sin aceptar IDs inactivos. Una reserva por proyecto/agente **DEBE** impedir
  double-booking entre turnos y liberarse en `finally`. Cada llamada crea un
  child desechable con `body.agent` exacto y una correlación única del tool. El
  `provider/model` del target, si existe, **DEBE** prevalecer sobre el modelo
  del turno raíz; en caso contrario lo hereda. Con Codex OAuth, el child permanece separado del parent para
  no enviar metadata de sesión que ese endpoint rechaza; la correlación y el
  cleanup **DEBEN** conservarse mediante el call ID y los hooks nativos. El
  límite **DEBE** agruparse por el mensaje de usuario raíz, no por los mensajes
  assistant intermedios.
- El arranque OpenCode **DEBE** omitir y diagnosticar perfiles hostiles,
  ambiguos o fuera de los límites sin perder roles/controles fijos. Ese modo
  tolerante sólo decide discovery inicial; invocación y mutación conservan el
  preflight estricto y fail-closed.
- Pi **DEBE** conservar `/<id> <task>` como comando nativo. El child de
  `team-lead` **DEBE** recibir un `harbor_delegate` custom y acotado cuyo schema
  enumera el roster enabled al crear esa sesión; el loader desactiva extensiones
  descubiertas para impedir herramientas implícitas o carga recursiva, y el
  host **DEBE** serializar ese tool. Antes de crear el root, Pi **DEBE** capturar
  en una sola lectura un snapshot de cada rol fijo o definición enabled embebida
  y ownership-verified; un fallo de preparación produce cero roots. El mismo
  conjunto acotado de IDs y definiciones **DEBE** alimentar la consulta
  determinista
  `harbor_team_roster`; esa consulta no crea un child. Al delegar, una
  definición con `model` **DEBE** resolver y autenticar ese `provider/model`
  antes de consumir la llamada; una definición sin `model` **DEBE** heredar el
  modelo efectivo del lead.
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
- El dataset **DEBE** declarar los dos IDs fijos y sus identidades nativas, los
  seis compañeros bundled en orden canónico y, como mínimo, estos ciclos:
  `default-specialists` (`crafter`, sin activación) y
  `full-sdlc` (`bench on` de los seis seguido de `portfolio-management` →
  `design` → `build` → `manage` → `consume` → `dispose`). Cada etapa salvo la
  primera referencia exactamente la evidencia de su predecesora inmediata.
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
- La evidencia textual retornada por children Pi y OpenCode **DEBE** quedar
  acotada por el helper común a 30.000 bytes UTF-8. Si el original excede el
  límite, el resultado **DEBE** conservar un prefijo UTF-8 válido y un marcador
  `HARBOR-EVIDENCE-TRUNCATED` con tamaño original y límite; nunca puede crecer
  sin cota dentro del contexto del lead.
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
  terminación nativas `portfolio-management` → `design` → `build` → `manage`
  → `consume` → `dispose`, exactamente una vez y sin solapamiento, correlacionar
  cada llamada con un child terminal, comprobar el cambio y exigir un handoff
  inmediato acotado que transporte un ID oculto que el coordinador sólo puede
  obtener de `portfolio-management`.
  La identidad y terminación nativas son autoritativas; el marcador escrito por
  el modelo es diagnóstico opcional. Si aparece, sólo puede ser el marcador
  propio, una vez, sin marcadores stale ni duplicados.
- La fixture live **DEBE** acotar cada gate a `ACCEPTANCE.md`, `src/score.js` y
  `test/score.test.js`: `portfolio-management` usa entre una y tres consultas
  `read`/`search` acotadas a esos archivos para encuadrar valor, alcance,
  criterios y el ID oculto;
  `design` produce el plan mínimo sólo desde el handoff y sin tools;
  sólo `build` usa entre una y tres lecturas
  de los archivos acotados, edita `src/score.js` y no ejecuta tests; `manage` usa sólo el shell para
  ejecutar `npm test` exactamente una vez y no lee ni edita; `consume` lee una
  vez cada uno de los tres archivos para aceptar corrección, seguridad,
  cobertura y valor sin editar ni ejecutar; y `dispose` evalúa cierre,
  retención, decommission, rollback y EOL sólo desde la evidencia retornada,
  sin tools, borrar ni deshacer el build.
- Cada smoke live **DEBE** activar y desactivar los seis compañeros bundled mediante el CLI
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
  reasoning `low`. En esta fixture, cuyos especialistas no declaran un override
  de modelo, el modelo y reasoning raíz **DEBEN** propagarse a todos los
  children y quedar verificados por eventos nativos. Fuera de la fixture, Pi
  conserva la regla anterior: un `provider/model` explícito del especialista
  sustituye sólo el modelo heredado después del preflight de catálogo/auth.
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
  los tres harnesses, el prompt posterior a `portfolio-management` **DEBE** transportar el ID
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

- Lee opcionalmente `.agent-harbor/skill-sources.json` del proyecto. El archivo
  cerrado versión 1 reemplaza los defaults y acepta hasta 32 fuentes GitHub de
  scope `repository`, `folder` o `skill`. Esa configuración **DEBE** cargarse
  de forma perezosa sólo al ejecutar `/list-skills`; un archivo inválido o
  sobredimensionado **NO DEBE** bloquear `/team`, `/bench`, `/join`, `/retire`
  ni `/contract`.
- Resuelve cada rama mediante el `gh` autenticado del usuario y enumera como
  máximo 500 `SKILL.md` por scope desde ese snapshot.
- Reporta por defecto una tabla compacta con sólo `REPOSITORY`, `PATH` y
  `SKILL`. `--descriptions`/`-d` **DEBE** añadir `DESCRIPTION` usando sólo el
  frontmatter acotado y no mostrar el body, commit ni blob. La carga acepta como
  máximo 64 descripciones: en un catálogo mayor **DEBE** aplicar primero un
  filtro por nombre, repositorio o ruta y fallar antes de pedir metadata si aún
  quedan más de 64 filas. Tras esa carga, el filtro final **PUEDE** coincidir
  también con la descripción. Las
  superficies terminales **DEBEN** solicitar color ANSI cuando lo soporten y
  Copilot **DEBE** añadir bordes Unicode y una cabecera explícita de cero tokens.
- La visibilidad configurada por el proyecto **NO DEBE** ampliar
  `trustedSkills` ni `trustedSkillRepositories`; la ejecución conserva una
  referencia exacta por player aunque el root incorporado sea un repositorio.
- No clona, instala, cachea, escribe, ejecuta ni muestra el cuerpo remoto.

### `/scout`

- `/scout <necesidad>` **DEBE** seleccionar un agente fijo interno
  `talent-scout` y consumir exactamente una sesión de modelo reclutador.
- El agente **DEBE** recibir sólo tres tools scoped: un snapshot read-only del
  roster, un filtro read-only de metadata y un `join` cerrado. No recibe
  filesystem, shell, delegación, `/contract`, skills ambientales ni el control
  lifecycle general.
- Antes de filtrar skills o mutar el roster **DEBE** consultar exactamente una
  vez el snapshot acotado de los especialistas habilitados, sin campos de path
  y con redacción de patrones comunes dentro de rol/modelo. La
  consulta **DEBE** mostrar el conjunto completo —como máximo 32 miembros y
  16 KiB—; el query sólo ordena coincidencias, nunca oculta filas. Si no cabe,
  **DEBE** devolver un diagnóstico sin filas y bloquear filtro/join para ese
  run. El formatter sustituye patrones comunes de paths en rol/modelo antes de
  exponerlos. El guard determinista sólo impone completitud, orden, ejecución
  secuencial, presupuestos y estado terminal; no recibe las filas y **NO
  PUEDE** decidir suficiencia semántica. La policy explícita del recruiter sí
  exige que, si un miembro `ready` ya tiene rol, tools y skills suficientes,
  informe su comando directo y termine sin filtro ni `join`; no puede reclutar
  un duplicado sólo para cambiarle el nombre.
- El filtro **DEBE** consultar sólo referencias exactas de `trustedSkills` y
  referencias descubiertas en `trustedSkillRepositories`, nunca
  `.agent-harbor/skill-sources.json`; devuelve nombre, repo, path, track y
  descripción, nunca body ni commit. La enumeración remota usa concurrencia
  acotada; antes de cargar metadata prefiltra nombre/repositorio/path, admite
  como máximo 64 candidatos y cuatro requests simultáneos, y exige estrechar
  una consulta que no pueda cumplir ese límite. Admite como máximo tres
  consultas por la instrucción del agente.
- Cuando el snapshot no cubre la necesidad, el agente puede seleccionar
  únicamente referencias devueltas sin modificar sus coordenadas, **DEBE**
  incluir `read` si selecciona una skill y **DEBE** llamar `join` exactamente
  una vez. La mutación conserva toda la validación, ownership, locking,
  colisiones y rollback de `/join`.
- Si el `join` ya hizo commit y el recruiter Pi falla o se cancela después, Pi
  **DEBE** reconciliar el alias en `finally` e informar que el roster cambió; no
  puede presentar la mutación confirmada como rollback.
- Copilot lo publica como `/scout` mediante la extensión y sus tres custom
  tools ligadas al agente; Pi inyecta esas tools sólo en el child recruiter;
  OpenCode aplica `execution.agent === "talent-scout"`. El recruiter no entra
  en el roster delegable del `team-lead`.

## 5. GitHub y skills privadas

`PlayerDefinition.skills` **DEBE** ser una allowlist propia del player, no una
autorización al catálogo global. Admite dos formas cerradas:

- `{"kind":"repo","name":"...","path":".../SKILL.md"}`: path con `/`,
  relativo al root del proyecto, contenido y sin traversal, paths absolutos,
  segmentos ambiguos ni symlinks;
- `{"kind":"github","name":"...","repo":"owner/repo","path":".../SKILL.md","track":"refs/heads/..."}`:
  referencia exacta cubierta por la allowlist GitHub activa.

Los nombres **DEBEN** ser únicos aunque las fuentes difieran. Campo omitido o
lista vacía **DEBE** producir un registro de skills vacío, nunca discovery
ambiental implícito.

Antes de usar el cuerpo, el loader compartido **DEBE** resolver nuevamente la
rama GitHub a un commit SHA o abrir el único archivo repo autorizado; exigir
1..18.000 bytes UTF-8, frontmatter de primera línea y un único `name`
coincidente; quitar frontmatter no portable; y copiar sólo el body a una
cápsula privada de la invocación. No se copian siblings. El contenido no puede
ampliar tools, persistencia, fuentes ni alcance. Credenciales privadas son las
del `gh` del usuario; Agent Harbor no almacena tokens.
Cada proceso `gh` **DEBE** tener un timeout de 20 segundos y recibir la señal de
cancelación del host cuando exista. Ninguna distribución requiere un servidor,
archivo de configuración o proceso auxiliar para exponer custom tools.

Cada harness **DEBE** imponer el grupo mediante su propia configuración:

- Copilot SDK usa `enableConfigDiscovery: false`, `skillDirectories` con una
  sola cápsula y `CustomAgentConfig.skills` con los nombres exactos. Los
  perfiles Markdown no reciben un loader global: declaran una custom tool sin
  argumentos `harbor_skill_<id>` ligada en código al grupo completo del player.
  El modelo nunca aporta el ID. Al arrancar, `joinSession` **DEBE** registrar la
  unión mínima formada por `harbor_contract`, las tres tools del recruiter y un
  loader por cada rol fijo o perfil activo canónico que ya tenga skills; no
  registra loaders de players en banca ni delegación; la única consulta de
  roster model-callable está ligada al recruiter y es read-only/acotada, mientras
  Copilot resuelve la delegación del lead mediante su guard nativo. Como el conjunto público queda
  fijo para esa sesión, un player con skills exige `/reload` sólo si su loader
  ligado no estaba en esa unión inicial. Un reemplazo del mismo ID **PUEDE**
  reutilizar un loader ya registrado, cuyo handler vuelve a validar la
  definición vigente. El `crafter` fijo aporta su loader desde el arranque.
- OpenCode niega la tool ambiental `skill`. Sólo un perfil con skills recibe
  `agent_harbor_skills`; su handler deriva la definición desde
  `execution.agent`, no acepta referencias del modelo y devuelve exactamente
  el grupo configurado. `/contract` mantiene ambas tools deshabilitadas e
  inyecta sólo bodies ya validados.
- Pi usa `noSkills: true`, `additionalSkillPaths` con archivos exactos y un
  `skillsOverride` fail-closed que rechaza diagnostics, nombres o paths extra
  antes de `createAgentSession`.

La exclusividad se refiere al registro y loaders de skills: sólo las
referencias declaradas se revelan o materializan como skills. No constituye una
ACL de filesystem o red; un child con `read` o `execute` conserva las
capacidades ordinarias que el usuario le declaró.

## 6. Portabilidad e instalación

- Node.js `>=22.19.0` es el único runtime de implementación y pruebas requerido.
- El código **NO DEBE** asumir shell, separador de paths ni sufijo ejecutable.
- `npm run build` **DEBE** eliminar artefactos previos y producir `dist` y el
  runtime Copilot desde la misma fuente sin red ni credenciales; un error de
  tipos no puede dejar un `dist` parcialmente actualizado.
- `package.json` **DEBE** declarar los exports servidor y TUI de OpenCode, la
  extensión Pi y el bin universal. El plugin Copilot **DEBE** contener su
  manifest, el runtime compilado estable y la extensión de controles directos y
  custom tools. **NO DEBE** contener configuración de transporte ni iniciar un
  proceso o servidor auxiliar. Desactivar lo experimental sólo **PUEDE**
  degradar esos controles a su fallback, no romper el lifecycle compartido.
- Los SDKs se fijan a versiones exactas: `@github/copilot-sdk@1.0.6`,
  `@opencode-ai/plugin@1.18.3` (que fija su SDK y coincide con el host mínimo
  OpenCode 1.18.3) y el peer provisto por Pi
  `@earendil-works/pi-coding-agent@0.80.10`. Pi permanece como peer opcional
  para no duplicar el runtime del host.

## 7. Límites deliberados para mantener simplicidad

- No se implementa un framework de plugins propio encima de los tres SDKs.
- No se duplican comandos como `toggle`, `lineup` o `leave`.
- No se heredan skills instaladas, personales o ambientales. Para ejecución
  sólo se soportan archivos repo exactos y referencias GitHub exactas declaradas
  en el player. Los scopes configurados por el proyecto son sólo visibles; los
  únicos repositorios que otorgan confianza de ejecución son los roots
  incorporados explícitamente en `trustedSkillRepositories`.
- No se promete aislamiento de sistema operativo.
- Copilot CLI 1.0.73 requiere modo experimental para sus comandos de extensión.
  Con él, los cuatro controles deterministas **DEBEN** resolverse como comandos
  `client`. No se publican wrappers Markdown para esos controles: sin extensión
  se usa el CLI directo y nunca un fallback que consuma tokens. Sólo `/contract`
  conserva un wrapper que llama a `harbor_contract` y después al `task` nativo.
- La extensión Copilot **DEBE** leer el `workingDirectory` actual de los
  metadatos de sesión para respetar cambios de carpeta; ningún path elegido por
  el modelo se acepta como argumento de una custom tool.
- La API TUI de OpenCode 1.18.3 no entrega argumentos al callback slash. Por eso
  usa ocho nombres directos inequívocos y diálogos, incluido `/team`; los cinco
  comandos canónicos del servidor se conservan como fallback, y el CLI directo
  conserva la sintaxis exacta sin inferencia.
- Una cadena SDLC completa es opt-in; `team-lead` elige la secuencia mínima de
  uno a seis children y `/contract` continúa eligiendo exactamente uno.

## 8. Matriz de trazabilidad

| ID | Requisito esencial | Evidencia obligatoria |
| --- | --- | --- |
| NAT-01 | Entrypoints, roles y loaders nativos | `distribution declares native TypeScript entrypoints`, `Copilot extension fixes a minimal native custom-tool union at startup` y `installed CLIs discover the native packages` |
| EFF-01 | Core único, un build y mínimo trabajo por comando | `Copilot runtime is generated byte-for-byte from shared core`, matriz de cinco comandos, smokes concurrentes y contenido de `npm pack --dry-run --json` |
| TOK-01 | Ruta cero modelo para controles deterministas y para ver la banca/equipo en cada distribución | `every distribution has a direct zero-model bench entrypoint`, `OpenCode TUI exposes direct controls that bypass sessions and models`, focal completo `test-ts/opencode-team.test.ts`, `Pi deterministic command handlers never enter the SDK orchestrator`, `Pi /team and enriched /bench are searchable zero-model controls with completions and human errors`, `Pi team lead rejects more than 32 active specialists before creating a ghost run`, aserción de orquestador vacío en la matriz de contratos y smoke Copilot de comando `client` sin eventos `assistant.usage` ni `assistant.message` |
| CMD-01 | Cinco comandos con semántica común | matriz `*: all five commands share the executable contract` para los tres harnesses |
| VAL-01 | Schema cerrado, límites y cero children ante error | `validation rejects every non-canonical player shape`, `join rejects an oversized rendered profile` y `contract rejects invalid input before creating any child` |
| OWN-01 | Ownership completo, colisiones, traversal y symlinks | `ownership metadata must remain complete`, `ownership rejects duplicate metadata and the wrong roster class`, `all harnesses reject unknown fields and unmanaged collisions`, `leaf symlinks are rejected` y `ancestor symlinks and traversal-shaped IDs are rejected` |
| TXN-01 | Lock, preflight, reemplazo atómico y rollback byte-idéntico | `concurrent roster mutations are serialized`, `bench preflights a whole batch` y `a failed multi-file mutation restores the complete prior state` |
| CON-01 | Un child, allowlist cerrada y cleanup sin pérdida de errores | pruebas de los tres orquestadores, `SDK orchestrators clean up child sessions when prompting fails`, `SDK orchestrators preserve execution and cleanup failures together` y aserciones `"*": false`/`executionMode: "sequential"` |
| SKL-01 | Grupo propio por player, fuentes repo/GitHub y cero discovery ambiental | `repository skill references reject traversal, absolute paths, mismatched names, and cross-source duplicate names`, `skill capsules contain only the configured file and clean up their invocation root`, `shared custom-tool contracts bind skill loaders to players and fail closed`, `compiled Copilot profiles bind custom skill tools without transport servers`, `OpenCode removes an owned stale profile from host discovery instead of inheriting expanded tools`, `managed dispatch rejects owned profiles whose executable frontmatter differs from the encoded definition`, `contract skills are validated and materialized before any SDK child is created`, `Pi gives a child exactly its invocation-scoped skill allowlist`, `Pi fails closed on ambient, malformed, or post-reload skill discovery and cleans the capsule` y `Pi cancellation during skill reload creates no child and cleans the capsule` |
| AGT-01 | Dos roles activos por defecto y seis compañeros SDLC bundled opt-in, invocables sin router | `the factory roster has exactly two active roles and six opt-in SDLC players`, `all harness rosters expose only fixed roles until owned SDLC profiles are activated`, `installed CLIs discover the native packages` y pruebas de comandos exactos por adapter |
| ORC-01 | Despacho secuencial nominal, evidencia entre etapas, límite, no recursión y cleanup | `Copilot team-lead hooks enforce exact active sequential delegation across user turns`, `OpenCode named runner dispatches every fixed and activated ID exactly`, `OpenCode team lead dispatches exact active agents sequentially without a router`, `Pi team lead delegates sequentially to different active agents with bounds and preflight` y `Pi team lead rejects more than 32 active specialists before creating a ghost run` |
| EVD-01 | Dataset literal común, identidades runtime y traza correlacionada sin contenido sensible | `the Harbor cycle dataset is literal, closed, and independent from runtime catalogs`, `the full Harbor dataset cycle activates, dispatches, hands off evidence, and cleans every SDK child`, `the default Harbor cycle dispatches crafter with evidence and cleanup`, `evidence hooks retain only hashes and byte lengths`, `a failing async evidence collector cannot alter child execution or cleanup`, `creation, prompt, and cleanup failures produce bounded truthful evidence traces` y las tres pruebas ORC-01 alimentadas por el mismo dataset |
| LIV-01 | Selección semántica y comunicación eficiente con inferencia real en Copilot, OpenCode y Pi | smoke Copilot opt-in `live Copilot team-lead selects and orchestrates the Harbor SDLC cycle efficiently` y smokes `live opencode|pi team-lead selects and orchestrates the Harbor SDLC cycle with Codex`: candidatos desordenados, nonce oculto acotado, seis children nativos correlacionados, secuencia exacta, concurrencia máxima uno, identidad/terminación nativas, ausencia de marcadores stale/duplicados, presupuestos raíz/child/total, fixture verificada, tokens positivos, cleanup y reportes sanitizados. La evidencia autenticada anterior al cambio de roster **NO** satisface esta secuencia canónica y **DEBE** regenerarse con los seis compañeros vigentes antes de afirmar LIV-01 cumplido. |
| COP-01 | Custom tools nativas, preflight compartido y runtime generado | `Copilot native control performs deterministic shared contract preflight`, `Copilot contract skill exposes only its native preflight tool and cannot be model-invoked`, `compiled Copilot profiles bind custom skill tools without transport servers`, `Copilot runtime is generated byte-for-byte from shared core`, `generated native runtime retains gh timeout and closed custom-tool contracts` y smoke ACP `agent-harbor (connected, plugin)` |
| COP-TEAM-01 | Roster y actividad Copilot cero modelo, lifecycle privado, accounting nativo y restore seguro | `Copilot runtime redacts tasks, privately deduplicates native usage, and preserves lower bounds`, `Copilot runtime preserves hierarchy, terminal facts, project isolation, cap32, and double-booking`, `Copilot team view shows deterministic roster, live hierarchy, filters, and last mission within 96 columns`, `Copilot coordinator emits correlated content-minimized root and child lifecycle events`, `Copilot child admission denies before native work without poisoning the next delegation`, pruebas de contrato de extensión, runtime byte-idéntico y smoke real `--plugin-dir` con usage inalterado |
| OPC-TEAM-01 | Roster/actividad OpenCode cero modelo, provenance privada, stop fail-closed y cleanup visible | todos los casos de `test-ts/opencode-team.test.ts`, incluidos HMAC ligado a sesión/proyecto, IDs opacos, redacción, telemetría de turno, límites, colisiones, recheck por target, lifecycle de diálogos, retry/hazard de cleanup y cap32; más `test-ts/opencode-server-hardening.test.ts` para el bridge de configuración |
| GH-01 | Referencias canónicas, snapshot read-only y body invocation-local | `GitHub references are bounded...`, `GitHub resolver pins one branch and one exact blob with two read-only cancellable gh calls`, `default gh runner enforces its process timeout`, `GitHub skill bodies are snapshot-loaded...` y `contract skills are validated and materialized before any SDK child...`; POC manual autenticado con `gh` |
| PI-01 | API real de Pi, skills aisladas, delegación nominal, `/team` y cancelación acotada | smoke de `createAgentSession`, RPC `get_commands`, `Pi gives a child exactly its invocation-scoped skill allowlist`, `Pi extension invokes every fixed and activated agent and equips the team lead for named delegation`, `Pi /team and enriched /bench are searchable zero-model controls with completions and human errors`, `Pi exposes a live safe team run, native usage, propagated signal, and always-cleared status/widget`, `Pi Alt+H cancels an idle slash child without a caller signal and clears live UI`, casos de root cap, double-booking y `/team stop` en `test-ts/adapters.test.ts`, y todas las pruebas de `test-ts/pi-team.test.ts` |
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

La comparación con una instalación Copilot existente es opt-in porque lee un
estado externo que puede estar deliberadamente atrasado. Antes de usar esa
instalación como evidencia de entrega **DEBEN** pasar `npm run
test:installed:copilot` y, para discovery nativo sin inferencia, `npm run
test:installed:copilot:smoke`. Un drift detectado es fallo informativo hasta
actualizar la copia instalada; no se incorpora silenciosamente a `npm test`.

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
