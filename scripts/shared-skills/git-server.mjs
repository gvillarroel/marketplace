import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {git,state} from './native.mjs';

export async function serve(snapshots) {
  const directory=path.join(state.directory, `git-${Date.now()}`);
  fs.mkdirSync(directory,{recursive:true});
  for (const [name,source] of Object.entries(snapshots)) git(['clone','--bare',source,path.join(directory,`${name}.git`)]);
  const backendPath=path.join(git(['--exec-path']),'git-http-backend.exe');
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if (!Object.keys(snapshots).some(name=>url.pathname.startsWith(`/${name}.git/`))) {res.writeHead(404);res.end();return;}
    const backend=spawn(backendPath,[],{windowsHide:true,env:{...process.env,GIT_PROJECT_ROOT:directory,GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:decodeURIComponent(url.pathname),QUERY_STRING:url.search.slice(1),REQUEST_METHOD:req.method,CONTENT_TYPE:req.headers['content-type']||'',CONTENT_LENGTH:req.headers['content-length']||'',REMOTE_ADDR:'127.0.0.1',SERVER_PROTOCOL:'HTTP/1.1'}});
    let headers=Buffer.alloc(0),sent=false;
    backend.stdout.on('data',chunk=>{
      if(sent){res.write(chunk);return;}
      headers=Buffer.concat([headers,chunk]);const end=headers.indexOf('\r\n\r\n');if(end<0)return;
      for(const line of headers.subarray(0,end).toString().split('\r\n')) {const colon=line.indexOf(':');if(colon<0)continue;const key=line.slice(0,colon),value=line.slice(colon+1).trim();if(key.toLowerCase()==='status')res.statusCode=Number(value.split(' ')[0]);else res.setHeader(key,value);}
      sent=true;res.write(headers.subarray(end+4));
    });
    backend.stderr.on('data',()=>{});backend.on('close',code=>{if(!sent)res.statusCode=code?500:200;res.end();});req.pipe(backend.stdin);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:name=>`http://127.0.0.1:${server.address().port}/${name}.git`,close:()=>new Promise(resolve=>server.close(resolve))};
}
