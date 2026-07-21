# Agent Harbor

Agent Harbor convierte GitHub Copilot CLI, OpenCode y Pi en un equipo de
agentes administrable. Los tres runtimes comparten el mismo roster y las mismas
reglas de ciclo de vida.

Incluye:

- `team-lead` y `crafter`, disponibles desde el inicio;
- seis especialistas SDLC opcionales: `portfolio-management`, `design`,
  `build`, `manage`, `consume` y `dispose`;
- `/bench`, `/join`, `/retire` y `/list-skills` deterministas, sin inferencia
  cuando se usan desde la superficie directa de cada runtime;
- `/contract` para ejecutar exactamente un agente desechable;
- ownership seguro: nunca sobrescribe ni elimina perfiles que no administra.

## Instalación

Elige el runtime donde lo vas a usar. Después de instalar o actualizar, abre
una sesión nueva desde la carpeta de tu proyecto.

### GitHub Copilot CLI

```shell
copilot plugin marketplace add gvillarroel/marketplace
copilot plugin install agent-foundry@agent-harbor
copilot --experimental
```

### OpenCode

Instalación global desde GitHub:

```shell
opencode plugin https://github.com/gvillarroel/marketplace/archive/refs/heads/main.tar.gz --global
```

Para instalarlo sólo en el proyecto actual, omite `--global`.

### Pi

```shell
pi install git:github.com/gvillarroel/marketplace
```

Para instalarlo sólo en el proyecto actual:

```shell
pi install --local git:github.com/gvillarroel/marketplace
```

## Primeros pasos

1. Consulta los agentes disponibles:

   ```text
   /bench
   ```

   En OpenCode el control directo equivalente es `/bench-list`.

2. Activa sólo los especialistas que necesites:

   ```text
   /bench on design build consume
   ```

   En OpenCode usa `/bench-on`, que solicita los nombres en un diálogo.

3. Ejecuta una tarea:

   - En Copilot y OpenCode, selecciona `team-lead`, `crafter` o un especialista
     activo desde el selector nativo de agentes.
   - En Pi, invócalo directamente, por ejemplo:

     ```text
     /team-lead Diseña e implementa este cambio y valida el resultado.
     ```

Para enviar una tarea a un agente exacto en Copilot u OpenCode, usa
`/harbor-<id> <tarea>`, por ejemplo:

```text
/harbor-design Diseña el cambio mínimo para soportar esta funcionalidad.
```

También puedes administrar el roster sin depender de la interfaz del host:

```shell
agent-harbor <copilot|opencode|pi> bench list
agent-harbor <copilot|opencode|pi> bench on design build
agent-harbor <copilot|opencode|pi> list-skills
```

## Documentación

La documentación detallada está en [`docs/`](docs/README.md): uso avanzado,
comandos, agentes, arquitectura, requisitos, decisiones de diseño y evidencia
de pruebas.
