# Equipo y observabilidad nativa en Pi

La extensión de Agent Harbor declara y verifica compatibilidad con Pi 0.80.10
y 0.81.1. Mantiene una vista del roster y de la actividad sin pedirle a un
modelo que los interprete. El lifecycle
transaccional sigue siendo la fuente de verdad. La telemetría rica y el
historial son un registro acotado en memoria del proceso Pi actual; la
admisión, ownership y fase de cada player persistente se publican además en un
registro privado por proyecto compartido con otros procesos Pi y Copilot.

## Controles sin modelo

Estos comandos no crean una sesión SDK ni envían prompts:

```text
/team [filter|stop <run-id|all>]
/bench [list [filter]|on <id...>|off <id...>]
/join <json>
/retire <personal-id>
/list-skills [--descriptions|-d] [filter]
```

Todos declaran `0 model tokens`. En TUI, `Alt+H` solicita detener todo el
trabajo Agent Harbor del proyecto controlado por este proceso. En RPC, un
segundo prompt concurrente puede usar `/team stop <run-id|all>`. Cada root local
muestra su `pi-run-N` para permitir una parada selectiva; una fila
`shared-<player>` pertenece a otro proceso Pi/Copilot y debe detenerse allí.

En esta vista, `ready`/`enabled` describe a un miembro válido que forma parte
del roster disponible; `active` se reserva para un run vivo en estado
`starting`, `working` o `cleaning`. Un miembro puede estar enabled sin estar
trabajando, y `busy` significa que un miembro enabled ya tiene un run activo.
Para players persistentes, esa ocupación se observa a escala del proyecto entre
procesos Pi y Copilot. Los contractors anónimos de `/contract` permanecen
process-local.

`/team` y `/bench list` muestran:

- `team-lead`, `crafter`, los seis especialistas SDLC y `talent-scout`;
- agentes personales en sus estados de disponibilidad y contractors que
  aparecen sólo en la actividad de su misión;
- descripción, tools/skills, modelo configurado, disponibilidad y reparación;
- actividad root/child, parent y run ID, tarea reducida, tiempo y estado;
- modelo configurado, heredado u observado, thinking setting, turnos assistant,
  usage nativo y coste nativo reportado por el provider;
- modelo/thinking del próximo child y máximo de salida por respuesta publicado
  por el modelo host.

Esos campos ricos corresponden a runs locales. De un claim persistente externo,
la vista sólo proyecta player, clase direct/delegated, fase, tiempo transcurrido
y el alias opaco `shared-<player>`. Los claims v2 añaden runtime owner
`pi|copilot` y PID como pista pública para detener el run en ese proceso. Un
claim v1 legacy conserva el PID conocido pero no contiene runtime, por lo que se
muestra como `owner runtime unverified (legacy claim) · PID <pid>`. Session/run
nativo, claim token, tarea, modelo, thinking, usage, coste, jerarquía y autoridad
de stop permanecen privados. Un runtime `opencode` en este namespace separado
es inválido y degrada la autoridad en vez de producir una ruta falsa.

La vista general de `/team` se recompone con un presupuesto dinámico de hasta
30 líneas envueltas y 96 celdas por línea. En condiciones normales conserva los
nueve IDs de fábrica —manager, rol fijo, seis bundled y utility— con clase y
estado efectivo. Bajo concurrencia alta prioriza hasta cuatro filas de actividad
actual y conserva una muestra representativa del roster con conteo exacto de lo
omitido. Los personales y runs que no caben siguen siendo recuperables mediante
`/team kind:personal`, `/team member:<id>` o `/team run:<id>`. El mismo máximo de
30 líneas/96 celdas cubre las vistas filtradas; una consulta estrecha puede
dedicarlo a más detalle de sus coincidencias. Cada fila compacta local conserva tarea reducida, modelo, turnos,
tokens y coste; una fila compartida conserva sólo los campos mínimos descritos
arriba.

`LEAD ACCESS` separa especialistas enabled delegables de los que están busy.
También separa la capacidad de roots locales —persistentes y contractors— de
los claims persistentes project-wide, que incluyen roots y children delegados
pero excluyen contractors.
Agent Harbor bloquea double-booking tanto en invocaciones directas como en
delegaciones de miembros persistentes, incluso si el owner es otro proceso Pi o
Copilot. Si la autoridad del registro compartido no puede probarse, no anuncia
ningún especialista como delegable; publica un diagnóstico saneado y acotado
del store junto con una reparación de cero modelos, sin revelar su ruta ni su
contenido. También resume cobertura SDLC y da
comandos de activación. El lead admite como máximo 32 especialistas enabled:
`/team` avisa si se supera y
`/team-lead` detiene el preflight con cero gasto. Su schema lleva metadata
pública acotada de rol/tools/skills y ofrece una consulta determinista opcional.

El filtro cubre ID, clase, estado, metadata pública, modelo, thinking, etiqueta
de tarea y run ID. El texto libre también busca el runtime y PID owner que una
fila externa divulga. En historial muestra sólo miembros coincidentes y nunca
presenta una suma parcial sin marcarla. `LAST MISSION` sin filtro conserva el
árbol completo. Roots concurrentes se agrupan por misión y cada child identifica
su parent.
Una fila externa `shared-*` sólo participa en los campos que divulga. Nunca
coincide con `task:`, `model:`, `thinking:` ni texto libre por el placeholder de
telemetría omitida; la vista cuenta esas filas no evaluadas y aclara que el
resultado cubre sólo campos divulgados.

`/bench on all` y `/bench off all` afectan sólo a los seis bundled; los
personales no cambian. El roster personal admite 200 registros y nunca se
trunca silenciosamente. Nombres que colisionan con comandos built-in de Pi,
como `model` o `reload`, no se pueden unir. Un perfil legado administrado con
uno de esos nombres sí se puede retirar.

Pi 0.80.10 no ofrece `unregisterCommand`. Tras `/bench off` o `/retire`, el
alias viejo falla en preflight con cero gasto y pide `/reload`. `join
{"replace":true}` sí refresca la metadata del comando activo en la sesión.
Un bundled stale se repara con `/bench on <id>` y `/reload`. Un personal con
registro válido pero copia activa stale usa el mismo flujo; sólo un registro
personal stale requiere repetir `/join` con la definición completa y
`"replace":true`.

Un `/join` exitoso informa ID, rol, capacidad efectiva —tools y nombres de
skills—, modelo configurado o herencia del host y el comando `/<id> <task>`.
No muestra paths de registro. El resultado del `join` scoped del scout usa el
mismo resumen, y el alias queda registrado en la sesión Pi actual.

La vista con descripciones limita a 64 las consultas remotas de metadata. En un
catálogo mayor aplica primero el filtro por nombre, repositorio o ruta; un filtro
todavía demasiado amplio falla antes de solicitar descripciones. Todas las
tablas y vistas humanas se ajustan a 96 celdas de terminal: ANSI es atómico y
ocupa cero, los grafemas no se parten y CJK/emoji ancho ocupa dos. La
configuración del catálogo se lee perezosamente sólo para `/list-skills`; si
está dañada, los controles de equipo y roster siguen disponibles. La
indentación se acota y los introducers ANSI truncados se descartan para que una
línea hostil no se bloquee ni contamine la siguiente salida del terminal.

## Ejecución, cancelación y cleanup

Los estados son:

```text
starting → working → cleaning → completed
                            ↘ failed
                            ↘ cancelled
                            ↘ cleanup-error
```

Cada root tiene un `AbortController` propio, combinado con la señal del caller.
Esto permite que `Alt+H` cancele un slash iniciado idle, donde Pi entrega
`ctx.signal === undefined`. Status y widget forman una sola superficie global
por proyecto, no una pila por root. El widget muestra primero los runs vivos más
recientes, ocupa como máximo nueve líneas de 78 celdas —Pi reserva diez— y nunca
sacrifica el control `Alt+H` por historial terminal o wrapping. El foco más
reciente conserva modelo y procedencia, thinking, tokens, coste y etiqueta de
tarea en filas separadas; hasta dos runs secundarios muestran identidad, estado
y enlace de detalle. El status compacto conserva su duración, etiqueta el coste
y expresa el conteo activo sin abreviaturas aunque necesite recortar otro campo;
el widget conserva el desglose roots/runs. Un filtro `run:` omite la sección de
roster porque consulta actividad/historial, no membresía, y titula el historial
como runs coincidentes.

En `session_shutdown` se abortan todos los roots y
se espera cleanup durante un máximo de cinco segundos; el cierre es best-effort
y un provider colgado no puede bloquear Pi indefinidamente. La espera del slash
también compite contra abort, pero el run conserva `cleaning`, capacidad y UI si
el provider aún no se asentó: así no habilita double-booking ni afirma una parada
remota no observada. Cuando el settlement real llega, el estado pasa a
`cancelled` o `cleanup-error`, la superficie se limpia si era el último run y se
emite exactamente una notificación terminal tardía. En shutdown la UI se limpia
siempre aunque venza la espera acotada.

Pi admite como máximo 32 roots locales concurrentes por proyecto. El root 33 y un
segundo root del mismo miembro persistente fallan en preflight con cero gasto.
Los contractors cuentan para el límite, pero no ocupan por nombre a un miembro
persistente ni para el registro compartido. Separadamente, el registro del
proyecto admite como máximo 32 claims persistentes activos, contando roots y
children Pi/Copilot. Los roots activos nunca se podan. Se retienen como máximo 32
misiones ya asentadas, y una misión sólo es podable cuando root y children son
terminales. El runtime rico es por proyecto, case-insensitive en Windows, y
desaparece al cerrar o recargar Pi; cada claim compartido debe liberarse al
asentarse su run exacto.

`team-lead` captura y valida un snapshot completo de sus targets enabled antes
de crear el root. Un fallo durante esa preparación no deja un run `starting`
fantasma.

Antes de crear una sesión o ejecutar modelo para un player persistente, Pi toma
un claim `starting` bajo un gate filesystem compartido. Dentro de ese mismo gate
hace la última comparación de la definición activa y, para `team-lead` o
`talent-scout`, del snapshot completo de roster. Así un `retire`, `bench off` o
reemplazo que gane la carrera hace fallar la admisión sin crear child. El claim
pasa a `working`/`cleaning` sólo si Pi sigue poseyendo y puede releer su
generación exacta.

Los mismos gates serializan mutaciones destructivas con nuevas admisiones. Un
claim de especialista protege ese ID; un claim de manager o recruiter protege
el roster que puede estar usando. El scout puede excluir únicamente su propio
token exacto al hacer el join scoped. Una lectura, publicación o release
ambigua falla cerrado; nunca se presenta la mutación como segura por omitir
actividad que no pudo leerse.

El heartbeat del claim no convierte un timeout en abandono. Si vence mientras
el PID owner todavía puede existir, la fila sigue visible, busy y contada contra
capacidad, y pide recuperar o reiniciar el proceso owner. Sólo una admisión
posterior puede recuperar un claim tras probar que el PID terminó y repetir la
lectura exacta de identidad, token y mtime. Un inventario malformado o ilegible
degrada `/team`: muestra `≥N` runs visibles, marca disponibilidad persistente
como no verificada, conserva el aviso incluso sin coincidencias y bloquea
delegación. No transforma cero filas en “nadie trabaja”.

Si Pi pierde la generación exacta después de admitir trabajo, la siguiente
publicación/revalidación local de fase marca `cleanup-error` y aborta el root que
controla. Un fallo al liberar el claim se propaga —junto al fallo original
cuando corresponde— y conserva el hazard de esa claim/generación: el player y
un slot de capacidad compartida siguen ocupados hasta release o recovery exacto.
Pi no eleva por sí solo ese caso al hazard durable project-wide de Copilot. Una
lectura malformada o ambigua del inventario sí degrada toda la autoridad y
bloquea admisión/delegación hasta reparar el store.

## Modelo, thinking, tokens y coste

Antes de la primera respuesta, el modelo se marca `configured` cuando la
definición del player o contract declara `model`; si no lo declara, se marca
`inherited` porque usa la selección efectiva de la sesión Pi. Ninguna de las
dos etiquetas es todavía evidencia del provider. El SDK puede ajustar el nivel
de thinking solicitado según el modelo; Agent Harbor lee `session.model` y
`session.thinkingLevel`. En `message_end`, `provider` y `responseModel ?? model`
pasan a `observed`.

Pi 0.80.10 usa el placeholder `provider: "unknown"`, `id: "unknown"`,
`api: "unknown"` y `maxTokens: 0` cuando no hay modelo activo; el contexto
público también puede omitir `model`. Agent Harbor captura una sola instantánea
del modelo y la combina con `modelRegistry.getAvailable()` y `getError()`. Un
catálogo sano y vacío se muestra como `unavailable (Pi reports no usable
models; use /login)`. Si el catálogo sano tiene modelos pero ninguno está
seleccionado, la vista dice `not selected (N available; use /model)`. Si el
catálogo no puede observarse, muestra `no active model; availability unobserved
(use /model or /login)`. Ningún caso publica el placeholder como modelo
heredado ni el cero como límite real; `LEAD ACCESS` tampoco anuncia targets
delegables hasta que exista una selección utilizable.

Un player o contract directo con `model` debe usar `provider/model`; Pi valida
existencia y auth antes de crear el child. Los aliases, `/contract` sin modelo y
`/scout` validan de la misma forma la selección heredada. Una selección ausente,
placeholder, sin auth o ya no disponible falla antes de crear el root o la
sesión y dirige a `/model` o `/login`. La sesión child recibe el mismo
`agentDir` que el host para que `auth.json` y `models.json` sean utilizables. Los
providers registrados en memoria no se recargan como extensiones dentro del
child: Harbor captura sólo los requeridos por el modelo elegido y por los
modelos explícitos del snapshot del lead, crea un `ModelRuntime` aislado mediante
las APIs públicas de Pi y reproduce allí su configuración. Una API key cuyo
origen host es estrictamente `runtime` se transfiere sólo en memoria; nunca se
persiste ni se convierte una credencial OAuth. En una misión de `/team-lead`,
todos los especialistas sin `model` heredan el modelo efectivo del lead. Cada
especialista que sí declara `model` usa esa configuración tras volver a validar
existencia y auth justo antes de consumir la delegación. La actividad distingue
ambos casos y después sustituye la etiqueta por evidencia `observed` si llega
una respuesta nativa.

Se acumulan una sola vez los campos nativos:

```text
input · output · reasoning · cache read/write · totalTokens
```

Cuando Pi lo entrega, también se acumula el objeto nativo de coste en USD:

```text
cost.input · cost.output · cost.cacheRead · cost.cacheWrite · cost.total
```

Agent Harbor no contiene una tabla de precios ni estima campos ausentes. Un
cero explícito permanece cero; una contribución desconocida convierte el
agregado conocido en `≥`; una combinación contradictoria deja desconocido sólo
el campo contradictorio. Run, misión, status y widget muestran esta observación
sin presentarla como límite de gasto.

`reasoning` es parte del output del provider y no se suma otra vez. Un campo sin
ningún dato muestra `—`. Si ya existe una contribución conocida y otro turno o
miembro carece de usage, se conserva como cota `≥N` en miembro, misión, status y
widget. El objeto all-zero que Pi usa como sentinel cuando no llega usage se
interpreta por presencia: si Pi entrega explícitamente los campos nativos en
cero, la vista muestra cero; si omite `usage`, el campo queda desconocido. Una
combinación contradictoria (por ejemplo, componentes positivos con total cero)
deja desconocido sólo el campo contradictorio. Si varios `responseModel`
contestan en un child, se muestra `mixed observed` con una lista acotada.

El transcript se observa también en error/cancelación antes del dispose. La
deduplicación evita contar otra vez mensajes ya recibidos por evento, pero no
colisiona respuestas diferentes de igual forma o longitud aunque falte
`responseId`: usa una huella HMAC efímera y no conserva el contenido. Para la
evidencia se usa el último texto assistant asentado; los deltas intermedios no
se concatenan al resultado final.

Esta telemetría permite observar gasto y detener trabajo; no promete un ceiling
acumulado de tokens o dólares. `model max output per response` es por respuesta,
no por child. Los costes declarados en la UI pertenecen a children y provienen
del provider, no de inferencias de Agent Harbor; por eso se muestran también
`model turns`.

## Privacidad y evidencia

El runtime rico process-local no conserva prompts, thinking ni respuestas.
Conserva una etiqueta heurística de hasta 72 caracteres para que el usuario
sepa qué se está haciendo. El registro compartido tampoco contiene esa etiqueta,
modelo, usage, coste ni historial: sólo ownership y fase mínimos del player
persistente. Los contractors de `/contract` nunca entran en ese registro.
La etiqueta colapsa controles y sustituye patrones comunes de rutas absolutas,
relativas y UNC, URLs, bearer/JWT, asignaciones de credenciales y prefijos de
secretos. No es un detector universal: no se debe poner un secreto nuevo en el
texto de una tarea esperando que la heurística lo descubra.

La metadata pública persistida, incluidas descripción y modelo, rechaza
controles C0/C1/Cf y secuencias ANSI. La metadata de provider observada también
se normaliza defensivamente antes de renderizarse. El prompt puede ser
multilínea porque nunca forma parte de estas vistas.

El lead recibe sólo evidencia del especialista. El desglose de agente/modelo/
tokens/tiempo se compone fuera de esa evidencia, después del root. El scout
debe consultar primero y exactamente una vez su snapshot acotado del roster;
cada fila declara disponibilidad, rol, tools y skills con patrones comunes de
rutas sustituidos. La policy del recruiter exige que, si un miembro `ready` ya
cubre la necesidad, termine sin filtrar ni hacer `join`; el guard determinista
no recibe las filas ni decide esa suficiencia, sólo completitud, orden,
presupuestos, serialización y terminalidad. Si falta capacidad, el tool de alta
devuelve un resultado conciso, también sin rutas locales. El snapshot muestra
todos los especialistas habilitados hasta 32 miembros/16 KiB; si no cabe, no
revela una muestra parcial y bloquea filtro y alta para evitar reclutar una
capacidad omitida. El preview de hasta 1.500 caracteres que Pi incluye en la
descripción de delegación es sólo orientativo, puede declarar omisiones y nunca
sustituye esta consulta completa.
Si ese join ya hizo commit y el recruiter falla o es cancelado después, el
handler reconcilia el alias en `finally` y avisa que el roster sí cambió.

## TUI, RPC y modos headless

TUI usa `notify`, `setStatus` y `setWidget`. RPC los expone como
`extension_ui_request`. Los errores aparecen una vez: TUI recibe un notify; Pi
0.80.10 captura el throw de un command RPC, emite un único `extension_error`
con `event: "command"` y deja el response del prompt en `success: true` porque
el comando fue manejado. Agent Harbor no duplica ese error con notify.
`/team stop all` es idempotente cuando el inventario compartido autoritativo no
muestra trabajo y tampoco hay roots locales. Pi sólo puede abortar roots cuyo
`AbortController` posee: los `shared-*` se informan como propiedad de otro
proceso y cada resultado conserva el runtime/PID owner exacto para detenerlos
allí; un claim v1 legacy conserva el PID y marca sólo el runtime owner como no
verificado. Si falla la autoridad compartida, Pi todavía puede solicitar stop
de sus roots locales, pero avisa que no puede verificar ni detener trabajo de
otros procesos; un run ID desconocido sigue siendo error accionable. El resultado
masivo permanece dentro de 30 líneas/96 celdas, cuenta los detalles omitidos y
dirige a `/team` para inspeccionarlos.

Las completions de `/team` y `/bench` comparten por proyecto una lectura en
vuelo, cachean el roster durante 750 ms y devuelven como máximo 50 opciones. Así
teclear no vuelve a recorrer un roster grande por cada pulsación; una mutación
de roster invalida la cache.

En print/JSON la UI de extensiones es no-op y el handler es `Promise<void>`.
Para automatización se usa RPC o `agent-harbor pi <comando>`; escribir texto ad
hoc en stdout rompería el protocolo.

Al probar un build local con `-e dist/adapters/pi.js`, usa también `-ne` si el
mismo paquete ya está instalado globalmente. Así Pi no carga dos veces la
extensión ni reporta colisiones falsas entre sus tools.

## Coste de comandos con modelo

```text
/scout <need>       1 recruiter child; 1 roster snapshot; 0..3 filtros; 0..1 join
/contract <json>    exactamente 1 contractor child
/<player> <task>    1 player child
/team-lead <task>   1 lead + hasta 6 specialists secuenciales
```

JSON inválido, tarea vacía, alias stale, modelo no disponible o exceso de
capacidad fallan en preflight con la línea explícita `no model was called · 0
model tokens`. Si ya existe un run, el reporte usa su telemetría real.
