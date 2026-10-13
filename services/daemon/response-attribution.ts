import type { Message } from '../../packages/protocol/index.ts';

// Only control message records enter this ledger. Harness role:user inputs never do.
export class ResponseAttribution {
  private ids:string[];
  constructor(ids:readonly string[]=[]){this.ids=[...ids];}
  apply(message:Pick<Message,'id'|'role'|'synthetic'>):void {
    if(message.role!=='user'||message.synthetic||this.ids.includes(message.id))return;
    this.ids=[...this.ids,message.id].slice(-256);
  }
  checkpoint():string[]{return [...this.ids];}
  snapshot(){const last=this.ids.at(-1);return last?{response_to_message_id:last,applied_user_ids:[...this.ids]}:{};}
}
