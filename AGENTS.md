# Instrucciones del proyecto

## Política del README y la documentación

El `README.md` de la raíz es deliberadamente breve y está reservado al
onboarding: qué hace Agent Harbor, cómo instalarlo en los runtimes soportados y
cómo ejecutar los primeros flujos útiles. No volver a agregar allí arquitectura,
requisitos exhaustivos, detalles internos, matrices de pruebas, evidencia de
aceptación ni historial de decisiones.

Todo contenido de referencia o explicación extensa debe vivir en `docs/`. Al
agregar o mover documentación, mantener actualizado `docs/README.md` como
índice y enlazar desde el README principal sólo lo necesario para continuar la
lectura. No devolver a la raíz los documentos trasladados a `docs/`.

## Alternativas OSS ya evaluadas

Al 2026-07-19, las siguientes alternativas fueron investigadas, fijadas a una
versión o SHA cuando fue posible y, para las candidatas principales, probadas
con definiciones privadas:

- `spxrogers/agentsync`
- `intellectronica/ruler`
- `runkids/skillshare`
- `PhilippTh/agpack`
- GitHub CLI `gh skill`
- `shrug-labs/aipack`
- `wshobson/agents`
- `dallay/agentsync`
- `amtiYo/agents` (`@agents-dev/cli`)
- `vercel-labs/skills`
- `sigilco/agentplugins`
- `gotalab/skillport`
- BMad Method
- OpenSkills
- SkillKit

Ninguna cumple, como reemplazo completo, con lo que necesita Agent Harbor. En
particular, ninguna reúne simultáneamente:

- roster persistente y ownership transaccional seguro;
- `/bench`, `/join` y `/retire` deterministas y sin uso de modelo;
- `/contract` con exactamente un child desechable;
- managers/contractors y lifecycle de miembros;
- definiciones privadas verificadas y fijadas a snapshots exactos;
- detección de colisiones y cleanup que nunca sobrescriba o elimine archivos
  no administrados;
- adapters nativos equivalentes para Copilot CLI, OpenCode y Pi;
- un agente invocable real en Pi, no sólo instrucciones o skills estáticas.

No volver a proponer estas herramientas como sustituto directo ni reiniciar la
misma búsqueda salvo que exista un cambio material en upstream. Pueden servir
como referencia o componente aislado —por ejemplo, AgentSync para
ownership/drift, Ruler para adapters, Skillshare para distribución y `gh skill`
para adquisición de skills privadas—, pero se debe conservar el core de Agent
Harbor y volver a validar cualquier integración con un POC de colisiones,
actualización, cleanup y descubrimiento real en los tres runtimes.
