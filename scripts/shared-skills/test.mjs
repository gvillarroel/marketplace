import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,pluginRoot,evidenceDirectory,check,marketplace} from './check.mjs';
import {run,rpc,write,git} from './native.mjs';
import {serve} from './git-server.mjs';
import {verifyProof} from './proof.mjs';
import {redactEvidence} from './evidence.mjs';

const structure=check();
const index=process.argv.indexOf('--client'),selected=index<0?null:process.argv[index+1];
if(index>=0&&!['copilot','codex'].includes(selected))throw new Error('Use --client copilot or --client codex');
const sourceIndex=process.argv.indexOf('--source');
const remoteSource=sourceIndex<0?null:process.argv[sourceIndex+1];
if(sourceIndex>=0&&remoteSource!=='https://github.com/gvillarroel/marketplace.git')throw new Error('Use --source https://github.com/gvillarroel/marketplace.git');
assert(!git(['status','--porcelain','--untracked-files=all','--','plugins/shared-skills-example','.agents/plugins/marketplace.json','.github/plugin/marketplace.json']),'Commit changed skill/manifest assets before testing the Git snapshot');
const snapshotCommit=remoteSource?git(['ls-remote',remoteSource,'HEAD']).split(/\s+/)[0]:git(['rev-parse','HEAD']);
assert(/^[a-f0-9]{40}$/.test(snapshotCommit),'Missing tested Git commit');
const server=remoteSource?null:await serve({marketplace:root});
const source=remoteSource||server.url('marketplace');
const outputDirectory=remoteSource?evidenceDirectory:path.join(root,'work/shared-skills-local');
const parse=text=>{try{return JSON.parse(text);}catch{return null;}};
const names=skills=>skills.map(skill=>skill.name.split(':').at(-1)).sort();
const expected={a:['shared-example-1','shared-example-2'],b:['shared-example-2','shared-example-3'],both:['shared-example-1','shared-example-2','shared-example-2','shared-example-3']};

async function testClient(client) {
  const profile=`${client[0]}${Date.now().toString(36)}`,reverse=profile+'r',commands=[];
  const step=async(args,activeProfile=profile)=>{
    const result=await run(client,args,activeProfile);commands.push(result);
    assert.equal(result.status,0,`${client} ${args.join(' ')}: ${result.stderr}`);
    return result;
  };
  const inventory=async(activeProfile=profile)=>{
    if(client==='copilot')return (parse((await step(['skill','list','--json'],activeProfile)).stdout)||[]).filter(skill=>skill.name.includes('shared-example-'));
    const result=await rpc('codex',activeProfile,[['skills/list',{forceReload:true}]]);commands.push({rpc:'skills/list',response:result});
    assert(!result.responses[0].response.error,'Native skills/list returned an error');
    return (result.responses[0].response.result?.data?.flatMap(data=>data.skills)||[]).filter(skill=>skill.name.includes('shared-example-'));
  };
  const install=(name,activeProfile=profile)=>step(['plugin',client==='codex'?'add':'install',`${name}@${marketplace}`,...(client==='codex'?['--json']:[])],activeProfile);
  const register=activeProfile=>step(['plugin','marketplace','add',source],activeProfile);
  const version=(await step(['--version'])).stdout.trim();
  const record={client,version,testedAt:new Date().toISOString(),source,snapshotCommit,sourceSkillCount:structure.skillCount,profile,invocations:[]};
  const save=()=>{
    write(path.join(root,'.test-state',`${client}-commands.json`),commands);
    write(path.join(outputDirectory,`${client}.json`),redactEvidence(record));
  };
  await register(profile);await install('shared-example-a');record.skillsA=await inventory();assert.deepEqual(names(record.skillsA),expected.a);console.log(`${client}: A exposes exactly skills 1 and 2.`);
  await install('shared-example-b');record.skillsBoth=await inventory();assert.deepEqual(names(record.skillsBoth),expected.both);console.log(`${client}: A+B expose 1, A:2, B:2 and 3.`);
  for(const [plugin,id] of [['shared-example-a',1],['shared-example-a',2],['shared-example-b',2],['shared-example-b',3]]) {
    const skill=`shared-example-${id}`,token=fs.readFileSync(path.join(pluginRoot,'library',skill,'references/proof.txt'),'utf8').trim();
    const prompt=client==='copilot'?`/${id===2?plugin+':':''}${skill}`:`Use the installed ${plugin} plugin's ${skill} skill. Follow its instructions, including reading its bundled proof file, and return exactly the proof token. Do not search for source repositories or other skills.`;
    const args=client==='copilot'
      ? ['-p',prompt,'--allow-tool','skill','--allow-tool','view','--available-tools','skill','view','--disable-builtin-mcps','--no-custom-instructions','--sync-session=off','--no-ask-user','--no-color','--output-format','json']
      : ['-a','never','-s','read-only','exec','--json','--ephemeral','--skip-git-repo-check',prompt];
    const result=await run(client,args,profile,{timeout:120000});commands.push(result);
    const events=result.stdout.split('\n').filter(Boolean).map(parse).filter(Boolean);
    const final=client==='copilot'?events.filter(event=>event.type==='assistant.message'&&event.data?.content).at(-1)?.data.content:events.filter(event=>event.type==='item.completed'&&event.item?.type==='agent_message').at(-1)?.item.text;
    const trace=events.filter(event=>client==='copilot'?event.type==='tool.execution_start'||event.type==='tool.execution_complete':event.type==='item.completed');
    const invocation={plugin,skill,status:result.status,final,trace};invocation.verification=verifyProof(client,invocation,token);invocation.passed=invocation.verification.passed;record.invocations.push(invocation);save();
    console.log(JSON.stringify({client,plugin,skill,passed:invocation.passed,verification:invocation.verification}));
    assert(invocation.passed,`${client} ${plugin}:${skill} did not load/read/return its proof. ${result.stderr}`);
  }
  await step(client==='copilot'?['plugin','disable',`shared-example-a@${marketplace}`]:['plugin','remove',`shared-example-a@${marketplace}`,'--json']);
  record.skillsBOnly=await inventory();assert.deepEqual(names(record.skillsBOnly),expected.b);
  await register(reverse);await install('shared-example-b',reverse);record.skillsBFirst=await inventory(reverse);assert.deepEqual(names(record.skillsBFirst),expected.b);
  await install('shared-example-a',reverse);record.skillsBothReverse=await inventory(reverse);assert.deepEqual(names(record.skillsBothReverse),expected.both);
  record.membershipPassed=true;record.bIndependent=true;record.reverseOrderPassed=true;record.nativeSkillUsePassed=true;save();
  console.log(`PASS ${client}: direct Git install, exact skill selection, 4/4 invocations, B independent, reverse order.`);
}
try {
  const outcomes=await Promise.allSettled((selected?[selected]:['copilot','codex']).map(testClient));
  const failures=outcomes.filter(result=>result.status==='rejected');
  for(const result of failures)console.error(result.reason);
  if(failures.length)process.exitCode=1;
} finally {if(server)await server.close();}
