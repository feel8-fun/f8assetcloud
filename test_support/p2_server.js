// Isolated HTTP harness for Studio integration/Playwright. In-memory SQLite uses
// every real migration and the production Worker/auth routes. Never deployed.
import { createServer } from 'node:http';
import fs from 'node:fs';
import { createApp } from '../src/app.js';
import { createSqliteD1Database } from './sqlite_d1_adapter.js';
const migrations=fs.readdirSync(new URL('../migrations',import.meta.url)).filter((f)=>f.endsWith('.sql')).sort()
  .map((f)=>fs.readFileSync(new URL(`../migrations/${f}`,import.meta.url),'utf8')).join('\n');
const env={DB:createSqliteD1Database({migrationsSql:migrations}),BETTER_AUTH_SECRET:'p2-test-secret-0123456789abcdef0123456789',
  BOOTSTRAP_ADMIN_USERNAME:'p2author',BOOTSTRAP_ADMIN_DISPLAY_NAME:'P2 Author',BOOTSTRAP_ADMIN_EMAIL:'p2@example.com',
  BOOTSTRAP_ADMIN_PASSWORD:'p2-only-password',AUTH_BASE_URL:''};
const app=createApp();
const server=createServer(async(req,res)=>{
  try {
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=Buffer.concat(chunks);
    const request=new Request(env.AUTH_BASE_URL+req.url,{method:req.method,headers:req.headers,
      ...(body.length?{body,duplex:'half'}:{})});
    const response=await app.fetch(request,env,{});
    res.statusCode=response.status;
    for(const [name,value]of response.headers)if(name!=='set-cookie')res.setHeader(name,value);
    const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);
    res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){console.error('P2 test Worker request failed',error);res.statusCode=500;res.end(JSON.stringify({message:'Test harness request failed'}));}
});
server.listen(0,'127.0.0.1',()=>{env.AUTH_BASE_URL=`http://127.0.0.1:${server.address().port}`;process.stdout.write(JSON.stringify({baseUrl:env.AUTH_BASE_URL})+'\n');});
