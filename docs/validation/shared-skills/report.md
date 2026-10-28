# Pruebas de Codex y Copilot desde GitHub

Instalación desde https://github.com/gvillarroel/marketplace.git. El ejemplo mantiene exactamente tres skills, sin generación de paquetes ni enlaces simbólicos.

| Cliente | Commit probado | Solo A | A+B | Uso real | Retirar A | Instalar B primero |
|---|---|---|---|---|---|---|
| GitHub Copilot CLI 1.0.103. | babe975c7b917b062143ee23c2613e6432dc19e9 | 1,2 | 1,A:2,B:2,3 | 4/4 | B conserva 2,3 | 2,3; añadir A conserva las cuatro selecciones |
| codex-cli 0.145.0 | babe975c7b917b062143ee23c2613e6432dc19e9 | 1,2 | 1,A:2,B:2,3 | 4/4 | B conserva 2,3 | 2,3; añadir A conserva las cuatro selecciones |

Las ocho invocaciones cargaron el contexto nativo de la skill y leyeron su references/proof.txt desde la caché del plugin correspondiente, y devolvieron exactamente el token esperado. Las trazas están en los JSON de cada cliente.

Las pruebas usaron perfiles aislados e instalaron el marketplace directamente desde GitHub. Las sesiones de modelo trabajaron en directorios temporales separados del repositorio fuente.

Las raíces son A=plugins/shared-skills-example y B=plugins/shared-skills-example/library. Todas las rutas permanecen dentro de su raíz. La skill 2 tiene una sola copia en el ejemplo; los clientes conservan sus propias cachés de instalación.

El transporte copia el árbol de cada raíz del plugin; la selección del manifiesto controla las skills registradas y mostradas, no un filtrado físico de archivos al descargar.
