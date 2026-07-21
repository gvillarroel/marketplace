# Equipo y observabilidad nativa en Pi

La extensión de Agent Harbor para Pi 0.80.10 mantiene una vista del roster y
de la actividad sin pedirle a un modelo que los interprete. El lifecycle
transaccional sigue siendo la fuente de verdad; la actividad es un registro
acotado en memoria del proceso Pi actual.

## Controles sin modelo

Estos comandos no crean una sesión SDK ni envían prompts:

```text
/team [filter|stop <run-id|all>]
/bench [list [filter]|on <id...>|off <id...>]
/join <json>
/retire <personal-id>
/list-skills [--descriptions|-d] [filter]
```

Todos declaran `0 model tokens`. En TUI, `Alt+H` detiene todo el trabajo Agent
Harbor activo del proyecto. En RPC, un segundo prompt concurrente puede usar
`/team stop <run-id|all>`. Cada root muestra su `pi-run-N` para permitir una
parada selectiva.

`/team` y `/bench list` muestran:

- `team-lead`, `crafter`, los seis especialistas SDLC y `talent-scout`;
- agentes personales y contractors activos;
- descripción, tools/skills, modelo configurado, disponibilidad y reparación;
- actividad root/child, parent y run ID, tarea reducida, tiempo y estado;
- modelo heredado u observado, thinking setting, turnos assistant y usage nativo;
- modelo/thinking del próximo child y máximo de salida por respuesta publicado
  por el modelo host.

`LEAD ACCESS` separa especialistas delegables de ocupados. Agent Harbor bloquea
double-booking tanto en invocaciones directas como en delegaciones de miembros
persistentes. También resume cobertura SDLC y da comandos de activación. El lead
admite como máximo 32 especialistas activos: `/team` avisa si se supera y
`/team-lead` detiene el preflight con cero gasto. Su schema lleva metadata
pública acotada de rol/tools/skills y ofrece una consulta determinista opcional.

El filtro cubre ID, clase, estado, metadata pública, modelo, thinking, etiqueta
de tarea y run ID. En historial muestra sólo miembros coincidentes y nunca
presenta una suma parcial sin marcarla. `LAST MISSION` sin filtro conserva el
árbol completo. Roots concurrentes se agrupan por misión y cada child identifica
su parent.

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
`ctx.signal === undefined`. En `session_shutdown` se abortan todos los roots y
se espera cleanup durante un máximo de cinco segundos; el cierre es best-effort
y un provider colgado no puede bloquear Pi indefinidamente. Status y widget se
limpian siempre en `finally`.

Pi admite como máximo 32 roots concurrentes por proyecto. El root 33 y un
segundo root del mismo miembro persistente fallan en preflight con cero gasto.
Los contractors cuentan para el límite, pero no ocupan por nombre a un miembro
persistente. Los roots activos nunca se podan. Se retienen como máximo 32
misiones ya asentadas, y una misión sólo es podable cuando root y children son
terminales. El registro es por proyecto, case-insensitive en Windows, y
desaparece al cerrar o recargar Pi.

`team-lead` captura y valida un snapshot completo de sus targets antes de crear
el root. Un fallo durante esa preparación no deja un run `starting` fantasma.

## Modelo, thinking y tokens

Antes de la primera respuesta, el modelo se marca `inherited`: es la selección
efectiva de la sesión Pi, todavía no evidencia del provider. El SDK puede
ajustar el nivel de thinking solicitado según el modelo; Agent Harbor lee `session.model` y
`session.thinkingLevel`. En `message_end`, `provider` y
`responseModel ?? model` pasan a `observed`.

Un player o contract directo con `model` debe usar `provider/model`; Pi valida
existencia y auth antes de crear el child. En una misión de `/team-lead`, todos
los delegados heredan el modelo raíz, coherente con los otros runtimes.

Se acumulan una sola vez los campos nativos:

```text
input · output · reasoning · cache read/write · totalTokens
```

`reasoning` es parte del output del provider y no se suma otra vez. Un campo sin
ningún dato muestra `—`. Si ya existe una contribución conocida y otro turno o
miembro carece de usage, se conserva como cota `≥N` en miembro, misión, status y
widget. El objeto all-zero que Pi usa como sentinel cuando no llega usage se
considera desconocido. Si varios `responseModel` contestan en un child, se
muestra `mixed observed` con una lista acotada.

El transcript se observa también en error/cancelación antes del dispose. La
deduplicación evita contar otra vez mensajes ya recibidos por evento, pero no
colisiona respuestas diferentes de igual forma o longitud aunque falte
`responseId`: usa una huella HMAC efímera y no conserva el contenido. Para la
evidencia se usa el último texto assistant asentado; los deltas intermedios no
se concatenan al resultado final.

Esta telemetría permite observar gasto y detener trabajo; no promete un ceiling
acumulado de tokens. `model max output per response` es por respuesta, no por
child. Los costes declarados en la UI son children, no inferencias, por eso se
muestran también `model turns`.

## Privacidad y evidencia

El runtime no conserva prompts, thinking ni respuestas. Conserva una etiqueta
heurística de hasta 72 caracteres para que el usuario sepa qué se está haciendo.
La etiqueta colapsa controles y sustituye patrones comunes de rutas absolutas,
relativas y UNC, URLs, bearer/JWT, asignaciones de credenciales y prefijos de
secretos. No es un detector universal: no se debe poner un secreto nuevo en el
texto de una tarea esperando que la heurística lo descubra.

La metadata pública persistida, incluidas descripción y modelo, rechaza
controles C0/C1/Cf y secuencias ANSI. La metadata de provider observada también
se normaliza defensivamente antes de renderizarse. El prompt puede ser
multilínea porque nunca forma parte de estas vistas.

El lead recibe sólo evidencia del especialista. El desglose de agente/modelo/
tokens/tiempo se compone fuera de esa evidencia, después del root. El tool del
scout también devuelve un resultado de join conciso, sin rutas locales.
Si ese join ya hizo commit y el recruiter falla o es cancelado después, el
handler reconcilia el alias en `finally` y avisa que el roster sí cambió.

## TUI, RPC y modos headless

TUI usa `notify`, `setStatus` y `setWidget`. RPC los expone como
`extension_ui_request`. Los errores aparecen una vez: TUI recibe un notify; Pi
0.80.10 captura el throw de un command RPC, emite un único `extension_error`
con `event: "command"` y deja el response del prompt en `success: true` porque
el comando fue manejado. Agent Harbor no duplica ese error con notify.
`/team stop all` es idempotente cuando no hay trabajo; un run ID desconocido sí
es un error accionable.

En print/JSON la UI de extensiones es no-op y el handler es `Promise<void>`.
Para automatización se usa RPC o `agent-harbor pi <comando>`; escribir texto ad
hoc en stdout rompería el protocolo.

Al probar un build local con `-e dist/adapters/pi.js`, usa también `-ne` si el
mismo paquete ya está instalado globalmente. Así Pi no carga dos veces la
extensión ni reporta colisiones falsas entre sus tools.

## Coste de comandos con modelo

```text
/scout <need>       1 recruiter child; hasta 3 filtros y como máximo 1 join
/contract <json>    exactamente 1 contractor child
/<player> <task>    1 player child
/team-lead <task>   1 lead + hasta 6 specialists secuenciales
```

JSON inválido, tarea vacía, alias stale, modelo no disponible o exceso de
capacidad fallan en preflight con la línea explícita `no model was called · 0
model tokens`. Si ya existe un run, el reporte usa su telemetría real.
