import type {ResponseInputItem} from "../../packages/provider/index.ts";
export function pruneConsumedToolImages(input:ResponseInputItem[],history:ResponseInputItem[],unseenCount=0):void{
 while(history.length>Math.max(2,unseenCount)){const oldest=history.shift();if(oldest){const index=input.indexOf(oldest);if(index>=0)input.splice(index,1);}}
}
export function appendToolImages(input:ResponseInputItem[],history:ResponseInputItem[],images:readonly string[]):void{
 if(images.length>4)throw new RangeError("Computer batch image limit exceeded");
 for(const image of images){const item:ResponseInputItem={role:"user",content:[{type:"input_image",image_url:image,detail:"original"}]};input.push(item);history.push(item);}
}
export function inputImageCount(input:readonly ResponseInputItem[]):number{
 let count=0;
 for(const item of input){
  if("content" in item&&typeof item.content!=="string"&&item.content){
   for(const part of item.content)if(part.type==="input_image")count++;
  }
 }
 return count;
}
export function restoreToolImages(input:readonly ResponseInputItem[],indexes:readonly number[]):ResponseInputItem[]{
 return indexes.flatMap(index=>input[index]?[input[index]]:[]);
}
// compactContext verifies identical user content in the same order before this mapping.
export function rebindToolImages(before:readonly ResponseInputItem[],after:readonly ResponseInputItem[],history:ResponseInputItem[]):void{
 const users=(items:readonly ResponseInputItem[])=>items.filter(item=>"role" in item&&item.role==="user");
 const original=users(before),compacted=users(after);
 const indexes=history.map(item=>original.indexOf(item));
 history.splice(0,history.length,...restoreToolImages(compacted,indexes));
}
