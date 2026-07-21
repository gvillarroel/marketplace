# Plan de simplificación de Agent Harbor

Este plan parte de `main@0dc250d` y busca reducir complejidad accidental sin
cambiar el contrato documentado en [REQUIREMENTS.md](REQUIREMENTS.md). La rama
de implementación es `refactor/simplify-agent-harbor`.

## Línea base

En `main@0dc250d`, la auditoría estática encontró 3.158 líneas no vacías de
TypeScript de producción (incluidos comentarios y declaraciones ambientales). Los
hotspots principales eran:

| Símbolo | Líneas aproximadas | Decisiones estimadas |
| --- | ---: | ---: |
| `createCopilotCoordinatorGuard` | 234 | 83 |
| `AgentHarborPlugin` | 213 | 61 |
| `Roster.bench` | 108 | 62 |
| `PiOrchestrator.run` | 120 | 40 |
| `CopilotOrchestrator.run` | 113 | 37 |
| `OpenCodeOrchestrator.runAgent` + `run` | 186 | 37 |

Las “decisiones” son una heurística de branches, loops, `catch`, ternarios y
operadores lógicos; sirven para comparar estructura, no como umbral normativo.
Los dos caminos de `OpenCodeOrchestrator` compartían 78 líneas normalizadas,
aproximadamente 88 % del método menor.

## Límites de compatibilidad

La simplificación no puede cambiar:

- texto, orden ni estados actuales de `/bench`, incluido `all`;
- bytes canónicos de perfiles revision 4 ni su definición recuperable;
- ownership, detección de colisiones, containment y rechazo de symlinks;
- preflight completo antes de mutar, escritura atómica, verificación y rollback
  byte a byte bajo un único lock;
- comandos deterministas sin inferencia y cero children ante input inválido;
- exactamente un child por contrato, modelo/variant heredados y tool policies;
- límites de delegación por prompt/turn/run: secuencial, máximo seis, sin
  repetición ni recursión;
- secuencia, correlación y minimización de eventos de evidencia;
- aislamiento y cleanup de cápsulas de skills;
- runtimes Copilot autocontenidos y byte-idénticos a la salida canónica.

## Cambios de esta rama

1. **Identidad y layout compartidos.** Una sola expresión canónica para IDs y
   un solo mapa de directorio/extensión por harness. Los adapters reutilizan
   estas constantes sin mover reglas de ownership ni filesystem.
2. **Escaneo activo de una pasada.** `active.ts` inspecciona cada perfil una
   vez y proyecta vistas owned, managed e invocable, conservando orden, límite
   de 200 y semántica fail-closed.
3. **Resolver GitHub sin duplicación.** `GhResolver` comparte el paso privado
   branch → commit; `resolve` y `load` mantienen exactamente dos llamadas `gh`
   y validan siempre contra el commit fijado.
4. **Políticas y build declarativos.** OpenCode comparte la construcción de su
   conjunto permitido. El build expresa targets y adapters como datos y usa un
   solo helper de copia; mantiene copias físicas, nunca links.
5. **`Roster.bench` por etapas.** Separar parsing, inventario y planificación
   del lote. El método público conserva un solo lock y ejecuta la transacción
   únicamente después de completar todo el preflight.
6. **Un lifecycle interno OpenCode.** `runAgent` y `run` preparan diferencias
   específicas, pero comparten creación, prompt, extracción, evidencia,
   cleanup y combinación de errores dentro del mismo runtime.

## Resultados medidos

Las cifras comparan `main@0dc250d` con la implementación de esta rama. Las
“decisiones” siguen la misma heurística de la línea base.

| Métrica | Antes | Después | Resultado |
| --- | ---: | ---: | --- |
| `Roster.bench` | 108 líneas / ~62 decisiones | 12 / 1 | El método público sólo coordina parse, plan y transacción. |
| OpenCode `runAgent + run` | ~186 / 37 | 42 / ~7 | Las diferencias específicas quedan en wrappers pequeños. |
| Lifecycle OpenCode total | ~186 / 37 | 131 / ~19 | Un solo `create`, `prompt`, `delete` y protocolo de evidencia. |
| LOC no vacías `src/orchestrators` | 553 | 512 | -41 líneas. |
| LOC no vacías `src/**/*.ts` | 3.158 | 3.244 | +86 por helpers nombrados y dos módulos canónicos; la meta es complejidad local, no minimizar bytes fuente. |
| Lecturas por candidato owned en discovery managed | hasta 2 | 1 | `owned` y `managed` derivan del mismo snapshot. |

| Duplicación estática | Antes | Después |
| --- | ---: | ---: |
| Literales de la regex canónica de ID | 6 | 1 |
| Tablas canónicas de layout | 2 | 1 |
| Llamadas OpenCode `session.create/prompt/delete` | 6 | 3 |
| Resoluciones branch → commit duplicadas | 2 | 1 |
| Call sites `cp(...)` en el build | 6 | 2 |

Los hotspots Copilot/Pi fuera del alcance permanecen sin cambios. Se evita así
mezclar una reducción comprobable con reescrituras simultáneas de las zonas de
mayor riesgo.

## Cambios deliberadamente fuera de alcance

- No se crea un `runChild` común a Copilot, OpenCode y Pi: sus contratos de
  abort, output, dispose y cápsula difieren materialmente.
- No se unifican todavía las variantes sync/async de path y symlink safety.
- No se reescribe el algoritmo del lock ni la transacción.
- No se descompone aún la máquina de correlación de hooks Copilot. Es el
  hotspot más sensible y merece una rama con caracterización específica.
- No se eliminan copias de `dist` en plugins; son necesarias por `${PLUGIN_ROOT}`.

## Estrategia de entrega

Cada etapa debe pasar `npm run typecheck` y su suite dirigida. El gate final es:

```text
npm test
npm run typecheck
npm audit --audit-level=high
npm pack --dry-run --json
git diff --check
```

Se compararán además los outputs observables de tests de caracterización, los
artefactos generados y las métricas de tamaño/duplicación antes y después. Los
smokes con inferencia no se repiten si la rama no cambia selección semántica,
prompts de roles, handoff ni hooks; los reportes autenticados vigentes se
verifican con `--verify-report-only`.

## Criterios de salida

- suite offline completa sin skips en los tres CLIs instalados;
- tarball válido que incluya arquitectura, requisitos y ambos plugins;
- cero vulnerabilidades de severidad alta;
- menos duplicación ejecutable y métodos públicos más cortos en los hotspots
  intervenidos;
- diff funcionalmente acotado y trazable a las seis etapas anteriores;
- rama publicada sin modificar nuevamente `main`.
