# Evaluaciones de Agent Harbor

Este documento ordena la evidencia de evaluación conocida del repositorio a
`2026-07-26`. Distingue las validaciones históricas del producto de un estudio
nativo de Harbor: las primeras prueban comportamiento y calidad del corte en
que se ejecutaron; no constituyen por sí solas una comparación reproducible de
skills, agentes o candidatos.

El detalle cronológico y los resultados sanitizados permanecen en
[TEST-LOG.md](TEST-LOG.md). El corte funcional más reciente documentado está en
[STATUS-2026-07-22.md](STATUS-2026-07-22.md).

## Estado del corpus actual

| Familia | Evidencia conocida | Último estado documentado | Alcance |
| --- | --- | --- | --- |
| Suite offline y regresión | Build limpio, pruebas TypeScript, smokes instalados de Copilot, OpenCode y Pi, typecheck y checks de diff | `498/498` pruebas y `73/73` checks de captura aprobados el 2026-07-22 | Corrección determinista, lifecycle, ownership, privacidad, discovery y compatibilidad de runtimes |
| Aceptación autenticada del team lead | Tres reportes JSON locales para Copilot, OpenCode y Pi | Los tres aprobaron el 2026-07-20 con uso positivo de modelo y seis delegaciones secuenciales | Flujo SDLC completo y cleanup; una ejecución conocida por runtime |
| Evaluación empírica de runtimes | Tours RPC/TUI, joined players, actividad real, stop/cancel y accounting | Reauditoría `CLEAN` y tours finales aprobados el 2026-07-22 | Experiencia instalada y comportamiento observable en versiones concretas de los hosts |
| Seguridad y distribución | Auditoría npm, dry-run del paquete, ausencia de MCP, validación de configuración y hooks de calidad | 0 vulnerabilidades reportadas; paquete y 14 hooks aprobados el 2026-07-22 | Supply chain, contenido distribuido y controles del repositorio |
| Evaluación comparativa de skills o candidatos | No hay datasets Harbor registrados, jobs nativos, rewards comparables ni selección congelada | No iniciada | No se puede afirmar mejora, ranking o promoción de un candidato |
| Holdout | No hay split holdout registrado ni evento de liberación | Sellado por ausencia: no existe un holdout declarado | No hay evidencia de generalización fuera de las fixtures visibles |

## Reportes autenticados conservados

Los reportes detallados son artefactos privados ignorados por Git bajo `work/`.
Los siguientes digests fueron publicados en el registro de pruebas y siguen
coincidiendo con los archivos locales al hacer este inventario:

| Harness | Runtime y modelo documentados | Generado (UTC) | SHA-256 |
| --- | --- | --- | --- |
| Copilot | 1.0.71, `copilot/gpt-5.4-mini`, reasoning `low` | `2026-07-20T23:12:09.416Z` | `14098d642edd018d56bf6410d935e98d53cc9ab6cd279327a68cc710fe92ae83` |
| OpenCode | 1.18.3, `openai/gpt-5.3-codex-spark`, reasoning `medium` | `2026-07-20T23:05:59.546Z` | `b3a7409908891b2e8443884ae5a4efda62639e41cdf8ddd34736bbe5f43f91bb` |
| Pi | 0.80.10, `openai-codex/gpt-5.3-codex-spark`, reasoning `low` | `2026-07-20T23:06:42.592Z` | `d3d8f8048916752a657161466d2174565c891a0117376ef79c057d9ce2b8988` |

El registro histórico informa `115,434`, `57,847` y `50,272` tokens observados,
respectivamente, y resultado `Passed` en los tres casos. Esos valores describen
esas ejecuciones concretas; no son medias, intervalos ni una comparación de
calidad entre modelos o runtimes.

## Qué demuestran las evaluaciones actuales

- Los controles deterministas y el lifecycle compartido tenían cobertura
  automatizada verde en el último corte documentado.
- Cada runtime completó al menos una aceptación autenticada del flujo de seis
  especialistas en el orden canónico.
- Las revisiones empíricas encontraron defectos visibles y carreras reales que
  fueron corregidos y vueltos a probar.
- Los tours finales comprobaron surfaces instaladas, accounting, cancelación,
  aislamiento del proyecto y rutas sin uso de modelo.
- La evidencia durable está sanitizada en `docs/`; las transcripciones,
  reportes y sandboxes completos permanecen locales bajo `work/`.

## Qué no demuestran

- No existe una cohorte expresada como directorios de tareas Harbor con
  `task.toml`, ni locks SHA-256 por split.
- No hay separación formal entre `discovery`, `development`, `validation` y
  `holdout`.
- No hay baseline y candidato ejecutados con un mismo comparison profile,
  attempts y política de retry.
- No hay reportes nativos de `harbor-run-results`, rewards agregados,
  intervalos, coste comparativo ni decisión de promoción.
- Las fixtures visibles y las correcciones derivadas de ellas pueden haber
  influido en el desarrollo. No deben renombrarse retrospectivamente como
  holdout.
- Los resultados históricos están ligados a las versiones, modelos, commits y
  estado local registrados entonces; no certifican automáticamente el
  worktree actual.

## Organización adoptada

`evaluations/current-evidence/` es el estudio-organizador del inventario
publicado. Su ledger y estado operativo son locales y negados por defecto; Git
puede ver solamente su `.gitignore` y los índices derivados bajo
`publication/`.

El estudio contiene una etapa de `publication` y liga por digest esta página,
el log de pruebas y el reporte de estado. No registra datasets, jobs ni rewards
porque esos artefactos nunca existieron bajo el contrato de un estudio Harbor.
Su propósito es fijar procedencia y evitar que el catálogo documental se
confunda con evidencia experimental nativa.

## Protocolo para la próxima evaluación nativa

1. Crear un estudio nuevo, sin reutilizar el catálogo histórico.
2. Declarar un `comparisonProfile` estable que fije tareas, agente, modelo,
   métrica, attempts, retries y gates.
3. Registrar todos los datasets antes de ejecutar una etapa y comprobar que no
   se solapan por ruta, task ID o digest.
4. Reservar `discovery`, `development` y, si corresponde, `validation` para
   trabajo visible al optimizador.
5. Mantener el holdout sin inspeccionar y sin ejecutar hasta que una selección
   de desarrollo completada quede ligada por digest.
6. Delegar baseline, comparación y reportes a `harbor-run-results`; usar la
   skill propietaria de cualquier evolución o recovery.
7. Publicar únicamente índices sin rutas y tablas agregadas revisadas. Jobs,
   trials, prompts, respuestas, trazas, diagnósticos y credenciales permanecen
   fuera de Git.

Este orden hace que una futura afirmación de mejora pueda rastrearse hasta
datasets congelados, una selección previa al holdout y reportes nativos, sin
reescribir la historia de las validaciones actuales.
