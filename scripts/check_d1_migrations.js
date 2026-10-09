// Exercise the same splitter and D1 runtime used to ship migrations, in an
// isolated temporary database. This command never invokes --remote.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const storage=mkdtempSync(join(tmpdir(),'f8cloud-d1-'));
try {
  const result=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','migrations','apply','DB','--local','--persist-to',storage],{stdio:'inherit'});
  if(result.error)throw result.error;
  process.exitCode=result.status??1;
}finally{rmSync(storage,{recursive:true,force:true});}
