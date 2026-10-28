import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {root} from './check.mjs';

export const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
};
const stateFile = path.join(root, '.test-state/run.json');
export const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {directory:fs.mkdtempSync(path.join(os.tmpdir(), 'shared-skill-plugin-'))};
write(stateFile, state);
const where = name => spawnSync('where.exe', [name], {encoding:'utf8', windowsHide:true}).stdout.trim().split(/\r?\n/)[0];
const cached = path.join(process.env.LOCALAPPDATA, 'copilot/pkg/win32-x64');
const versions = fs.existsSync(cached) ? fs.readdirSync(cached).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort((a,b) => b.localeCompare(a, undefined, {numeric:true})) : [];
const copilotEntry = versions.map(v => path.join(cached,v,'index.js')).find(f => fs.existsSync(f));
const codexExe = path.join(process.env.APPDATA,'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
export const clients = {
  copilot:copilotEntry ? {exe:process.execPath,prefix:[copilotEntry]} : {exe:where('copilot'),prefix:[]},
  codex:{exe:process.env.CODEX_EXAMPLE_BIN || codexExe,prefix:[]},
};
export function profile(client, mode) {
  const directory = client === 'codex'
    ? path.join(os.homedir(), '.cx-test', path.basename(state.directory).slice(-6), mode)
    : path.join(state.directory, mode, client);
  const workspace = path.join(state.directory, mode, `${client}-workspace`);
  fs.mkdirSync(directory,{recursive:true});
  fs.mkdirSync(workspace,{recursive:true});
  const env = {...process.env, CI:'true', NO_COLOR:'1', COPILOT_AUTO_UPDATE:'false', DISABLE_AUTOUPDATER:'1'};
  const gitConfigCount=Number(env.GIT_CONFIG_COUNT||0);
  env.GIT_CONFIG_COUNT=String(gitConfigCount+1);
  env[`GIT_CONFIG_KEY_${gitConfigCount}`]='core.longpaths';
  env[`GIT_CONFIG_VALUE_${gitConfigCount}`]='true';
  if (client === 'copilot') {env.COPILOT_HOME=directory;env.COPILOT_CACHE_HOME=path.join(directory,'cache');}
  if (client === 'codex') {
    env.CODEX_HOME=directory;
    const auth = path.join(os.homedir(),'.codex/auth.json');
    if (fs.existsSync(auth) && !fs.existsSync(path.join(directory,'auth.json'))) fs.copyFileSync(auth,path.join(directory,'auth.json'));
  }
  return {directory,workspace,env};
}
export async function run(client,args,mode,options={}) {
  const p=profile(client,mode), binary=clients[client];
  return new Promise(resolve => {
    const cp=spawn(binary.exe,[...binary.prefix,...args],{cwd:options.cwd||p.workspace,env:{...p.env,...options.env},windowsHide:true});
    cp.stdin.end(options.stdin||'');
    let stdout='',stderr='',timedOut=false;
    cp.stdout.on('data',d=>{stdout+=d;});cp.stderr.on('data',d=>{stderr+=d;});
    const timer=setTimeout(()=>{timedOut=true;cp.kill();},options.timeout||60000);
    cp.on('error',error=>{clearTimeout(timer);resolve({args,status:null,stdout,stderr,error:error.message});});
    cp.on('close',status=>{clearTimeout(timer);resolve({args,status,stdout,stderr,timedOut});});
  });
}
export async function rpc(client, mode, requests) {
  const p=profile(client,mode),binary=clients[client];
  const cp=spawn(binary.exe,[...binary.prefix,'app-server'],{cwd:p.workspace,env:p.env,windowsHide:true});
  let buffer='',stderr='',next=0;
  const pending=new Map(),notifications=[];
  cp.stderr.on('data',d=>{stderr+=d;});
  cp.stdout.on('data',data=>{
    buffer+=data;
    let nl;
    while ((nl=buffer.indexOf('\n'))>=0) {
      const line=buffer.slice(0,nl);buffer=buffer.slice(nl+1);
      let message;try {message=JSON.parse(line);}catch {continue;}
      if (message.id!==undefined && pending.has(message.id)) {const item=pending.get(message.id);pending.delete(message.id);clearTimeout(item.timer);item.resolve(message);}
      else notifications.push(message);
    }
  });
  const request=(method,params)=>new Promise((resolve,reject)=>{
    const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`RPC timeout: ${method}`));},45000);
    pending.set(id,{resolve,reject,timer});cp.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  try {
    const init=await request('initialize',{clientInfo:{name:'shared-skill-plugin-example',version:'1.0.0'},capabilities:{experimentalApi:true}});
    cp.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const responses=[];
    for (const [method,params] of requests) responses.push({method,response:await request(method,params)});
    return {init,responses,notifications,stderr};
  } finally {cp.stdin.end();cp.kill();for(const item of pending.values())clearTimeout(item.timer);}
}
export function git(args,cwd=root) {
  const r=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true,timeout:30000});
  if (r.status!==0)throw new Error(`Git failed: ${r.stderr}`);
  return r.stdout.trim();
}
