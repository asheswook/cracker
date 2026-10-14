import { z } from 'zod';
import { createDatabase } from '../services/control/db';
import { pauseAdmission, reportDraining } from '../services/control/repository/draining';

export function drainOptions(args:readonly string[]){
  let vm:string|undefined,all=false,action:'report'|'pause'|'unpause'='report';
  for(let index=0;index<args.length;index++){
    const arg=args[index];
    if(arg==='--vm'){if(vm)throw new Error('Duplicate --vm');vm=z.uuid().parse(args[++index]);}
    else if(arg==='--all')all=true;
    else if(arg==='--pause'||arg==='--unpause'){
      if(action!=='report')throw new Error('Choose only one of --pause or --unpause');action=arg==='--pause'?'pause':'unpause';
    }else throw new Error(`Unknown argument: ${arg}`);
  }
  if(vm&&all)throw new Error('Choose --vm or --all');
  if(action!=='report'&&!vm&&!all)throw new Error('Mutations require --vm <uuid> or --all');
  return {vm,action};
}
export async function drainRuns(args:readonly string[],url:string){
  const options=drainOptions(args),sql=createDatabase(z.url().parse(url));
  try{
    if(options.action!=='report')await pauseAdmission(sql,options.action==='pause',options.vm);
    const vms=await reportDraining(sql,options.vm);
    if(options.vm&&!vms.length)throw new Error('VM not found');
    return {action:options.action,ready:vms.every(vm=>vm.active_runs.length===0&&vm.pending_commands.length===0),vms};
  }finally{await sql.end();}
}
if(import.meta.main){
  if(process.argv.includes('--help'))console.log('DATABASE_URL=... bun scripts/drain-runs.ts [--vm <uuid>] [--pause | --unpause] [--all]\nDefault: report only. Pause blocks new admissions, never stops runs or acknowledges commands.');
  else{
    try{console.log(JSON.stringify(await drainRuns(process.argv.slice(2),z.url().parse(process.env['DATABASE_URL'])),null,2));}
    catch(error){if(!(error instanceof Error))throw error;console.error(JSON.stringify({error:error.name,message:error instanceof z.ZodError?'Invalid arguments or DATABASE_URL':error.message}));process.exitCode=1;}
  }
}
