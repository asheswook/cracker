import type { Provider } from "../packages/provider";
export function memoryProviderFixture(output: unknown, inspect?: (input: Parameters<Provider["respond"]>[0]) => void): Provider {
  return { respond: async input => {
    inspect?.(input);
    return { id:crypto.randomUUID(),created_at:0,output_text:"",error:null,incomplete_details:null,instructions:null,metadata:null,model:"fixture",object:"response",output:[{type:"message",id:crypto.randomUUID(),role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify(output),annotations:[]}]}],parallel_tool_calls:false,temperature:null,tool_choice:"auto",tools:[],top_p:null,status:"completed" };
  } };
}
