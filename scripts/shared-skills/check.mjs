import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const pluginRoot=path.join(root,'plugins/shared-skills-example');
export const evidenceDirectory=path.join(root,'docs/validation/shared-skills');
export const definitions=[['','shared-example-a',[1,2]],['library','shared-example-b',[2,3]]];
export const marketplace='agent-harbor';
export const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
export function files(directory) {
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    if(['.git','.test-state','evidence'].includes(entry.name))return [];
    assert(!entry.isSymbolicLink(),`Unexpected symlink: ${entry.name}`);
    const target=path.join(directory,entry.name);
    return entry.isDirectory()?files(target):[target];
  });
}
export function check() {
  const skillFiles=files(pluginRoot).filter(file=>path.basename(file)==='SKILL.md');
  assert.equal(skillFiles.length,3,'Exactly three physical skill sources are required');
  for(const [folder,name,ids] of definitions) {
    const selectionRoot=path.join(pluginRoot,folder);
    const manifests=['.codex-plugin','.claude-plugin'].map(directory=>{
      assert(files(path.join(selectionRoot,directory)).every(file=>file.endsWith('.json')),'Manifest folders contain metadata only');
      return json(path.join(selectionRoot,directory,'plugin.json'));
    });
    assert.deepEqual(manifests[0],manifests[1]);
    const manifest=manifests[0];assert.equal(manifest.name,name);
    assert.deepEqual(manifest.skills.map(entry=>path.basename(entry)),ids.map(id=>`shared-example-${id}`));
    for(const entry of manifest.skills) {
      assert(entry.startsWith('./')&&!entry.split(/[\\/]/).includes('..'));
      const resolved=path.resolve(selectionRoot,entry);
      assert(resolved.startsWith(selectionRoot+path.sep));
      assert(fs.existsSync(path.join(resolved,'SKILL.md')));
      assert(fs.existsSync(path.join(resolved,'references/proof.txt')));
    }
    assert(!fs.existsSync(path.join(selectionRoot,'plugin.json')),'This selection uses compatibility manifests');
  }
  const copilot=json(path.join(root,'.github/plugin/marketplace.json'));
  const codex=json(path.join(root,'.agents/plugins/marketplace.json'));
  for(const catalog of [copilot,codex])assert.equal(catalog.name,marketplace);
  assert.deepEqual(copilot.plugins.filter(p=>p.name.startsWith('shared-example-')).map(p=>[p.name,p.source]),[['shared-example-a','./plugins/shared-skills-example'],['shared-example-b','./plugins/shared-skills-example/library']]);
  assert.deepEqual(codex.plugins.map(p=>[p.name,p.source.source,p.source.path]),[['shared-example-a','local','./plugins/shared-skills-example'],['shared-example-b','local','./plugins/shared-skills-example/library']]);
  console.log('PASS: exactly three skills; JSON-only manifest folders; A={1,2}, B={2,3}; contained paths; no build or symlinks.');
  return {skillFiles:skillFiles.map(file=>path.relative(root,file)),skillCount:skillFiles.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))check();
