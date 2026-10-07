import {z} from 'zod';
import {createDatabase} from '../../../services/control/db.ts';
export async function cleanupWorkspace(sql,workspace){
  const id=z.string().uuid().parse(workspace);
  return sql.begin(async tx=>{
    const rows=await tx`SELECT id FROM assistant.workspaces WHERE id=${id} AND name='settings-browser-matrix' FOR UPDATE`;
    if(rows.length!==1)throw new Error('Refusing cleanup: owned fixture workspace not found');
    await tx`UPDATE assistant.workspaces SET default_conversation_id=NULL WHERE id=${id}`;
    const conversations=await tx`DELETE FROM assistant.conversations WHERE workspace_id=${id} RETURNING id`;
    const removed=await tx`DELETE FROM assistant.workspaces WHERE id=${id} RETURNING id`;
    return {workspace:id,conversationsDeleted:conversations.length,workspacesDeleted:removed.length};
  });
}
if(import.meta.main){
  const sql=createDatabase(process.env.TEST_DATABASE_URL??'postgres://assistant:assistant@127.0.0.1:55439/assistant_dev');
  try{console.log(JSON.stringify(await cleanupWorkspace(sql,process.argv[2])));}finally{await sql.end();}
}
