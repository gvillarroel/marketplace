import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pluginRoot,evidenceDirectory,check,json} from './check.mjs';
import {write} from './native.mjs';
import {verifyProof} from './proof.mjs';

const structure=check();
const records=['copilot','codex'].map(client=>json(path.join(evidenceDirectory,`${client}.json`)));
for(const record of records) {
  assert.equal(record.sourceSkillCount,3);
  assert.equal(record.source,'https://github.com/gvillarroel/marketplace.git');
  assert(record.membershipPassed&&record.bIndependent&&record.reverseOrderPassed);
  const names=items=>items.map(item=>item.name.split(':').at(-1)).sort();
  assert.deepEqual(names(record.skillsA),['shared-example-1','shared-example-2']);
  for(const field of ['skillsBOnly','skillsBFirst'])assert.deepEqual(names(record[field]),['shared-example-2','shared-example-3']);
  for(const field of ['skillsBoth','skillsBothReverse'])assert.deepEqual(names(record[field]),['shared-example-1','shared-example-2','shared-example-2','shared-example-3']);
  assert.equal(record.invocations.length,4);
  for(const invocation of record.invocations) {
    const token=fs.readFileSync(path.join(pluginRoot,'library',invocation.skill,'references/proof.txt'),'utf8').trim();
    assert(verifyProof(record.client,invocation,token).passed);
  }
}
const result={sourceSkillScope:'plugins/shared-skills-example',sourceSkillCount:structure.skillCount,canonicalSkillFiles:structure.skillFiles.map(file=>file.replaceAll('\\','/')),layout:'Nested plugin roots; compatibility manifests; direct GitHub installation',nativeInvocationsPassed:8,nativeInvocations:8,results:records};
write(path.join(evidenceDirectory,'results.json'),result);
write(path.join(evidenceDirectory,'report.md'),`# Pruebas de Codex y Copilot desde GitHub\n\nInstalación desde https://github.com/gvillarroel/marketplace.git. El ejemplo mantiene exactamente tres skills, sin generación de paquetes ni enlaces simbólicos.\n\n| Cliente | Commit probado | Solo A | A+B | Uso real | Retirar A | Instalar B primero |\n|---|---|---|---|---|---|---|\n${records.map(record=>`| ${record.version.split('\n')[0]} | ${record.snapshotCommit} | 1,2 | 1,A:2,B:2,3 | 4/4 | B conserva 2,3 | 2,3; añadir A conserva las cuatro selecciones |`).join('\n')}\n\nLas ocho invocaciones cargaron el contexto nativo de la skill y leyeron su references/proof.txt desde la caché del plugin correspondiente, y devolvieron exactamente el token esperado. Las trazas están en los JSON de cada cliente.\n\nLas pruebas usaron perfiles aislados e instalaron el marketplace directamente desde GitHub. Las sesiones de modelo trabajaron en directorios temporales separados del repositorio fuente.\n\nLas raíces son A=plugins/shared-skills-example y B=plugins/shared-skills-example/library. Todas las rutas permanecen dentro de su raíz. La skill 2 tiene una sola copia en el ejemplo; los clientes conservan sus propias cachés de instalación.\n\nEl transporte copia el árbol de cada raíz del plugin; la selección del manifiesto controla las skills registradas y mostradas, no un filtrado físico de archivos al descargar.\n`);
console.log('PASS: 8/8 native skill invocations; both install orders; three canonical skill sources.');
