import {test,expect} from "bun:test";
import type {ResponseInputItem} from "../packages/provider/index.ts";
import {appendToolImages,pruneConsumedToolImages,inputImageCount} from "../services/daemon/image-history.ts";
test('visual context retains newest two tool images while preserving user uploads and all action history',()=>{
 // Given an uploaded image, a single-image user message that resembles a screenshot, and actual typed tool history.
 const uploaded:ResponseInputItem={role:'user',content:[{type:'input_text',text:'attachment metadata'},{type:'input_image',image_url:'data:image/png;base64,dXNlcg==',detail:'auto'}]};
 const singleUserImage:ResponseInputItem={role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,c2luZ2xl',detail:'original'}]};
 const call:ResponseInputItem={type:'function_call',call_id:'call1',name:'computer',arguments:'{}'};
 const result:ResponseInputItem={type:'function_call_output',call_id:'call1',output:'observed button'};
 const reasoning:ResponseInputItem={type:"reasoning",id:"reasoning1",summary:[],encrypted_content:"protected-reasoning"};
 const input:ResponseInputItem[]=[uploaded,singleUserImage,call,result,reasoning],history:ResponseInputItem[]=[];
 // When
 appendToolImages(input,history,['data:image/png;base64,b2xk','data:image/png;base64,bWlk','data:image/png;base64,bmV3']);pruneConsumedToolImages(input,history);
 // Then
 expect(input.slice(0,5)).toEqual([uploaded,singleUserImage,call,result,reasoning]);expect(input).toHaveLength(7);expect(inputImageCount(input)).toBe(4);
 expect(JSON.stringify(input)).not.toContain('base64,b2xk');expect(JSON.stringify(history)).toContain('base64,bWlk');expect(JSON.stringify(history)).toContain('base64,bmV3');
 expect(history.every(item=>'content' in item&&JSON.stringify(item.content).includes('"detail":"original"'))).toBe(true);
});

test('all current batch frames reach next inference before consumed history is pruned',()=>{
 // Given two consumed screenshots plus a user upload.
 const upload:ResponseInputItem={role:'user',content:[{type:'input_image',image_url:'upload',detail:'auto'}]};
 const input:ResponseInputItem[]=[upload],history:ResponseInputItem[]=[];
 appendToolImages(input,history,['old1','old2']);pruneConsumedToolImages(input,history);
 // When a batch emits intermediate terminal/file screenshots and a final frame.
 appendToolImages(input,history,['terminal','file','detail','final']);pruneConsumedToolImages(input,history,4);
 const visible=input.flatMap(item=>'content' in item&&typeof item.content!=='string'&&item.content?item.content.flatMap(part=>part.type==='input_image'?[part.image_url]:[]):[]);
 // Then all current batch frames remain visible in order for the next inference, without duplicating final.
 expect(visible).toEqual(['upload','terminal','file','detail','final']);
 expect(history).toHaveLength(4);
 pruneConsumedToolImages(input,history);
 expect(history).toHaveLength(2);expect(inputImageCount(input)).toBe(3);expect(input[0]).toBe(upload);
 expect(JSON.stringify(history)).toContain('detail');expect(JSON.stringify(history)).toContain('final');
});

for(const batch of [['new1'],['new1','new2'],['new1','new2','new3','new4']])test(`consumed images fill only the two-frame minimum, new batch ${batch.length}`,()=>{
 const input:ResponseInputItem[]=[],history:ResponseInputItem[]=[];
 appendToolImages(input,history,['old1','old2']);
 appendToolImages(input,history,batch);pruneConsumedToolImages(input,history,batch.length);
 const expected=batch.length===1?['old2',...batch]:batch;
 const urls=history.flatMap(item=>'content' in item&&typeof item.content!=='string'&&item.content?item.content.flatMap(part=>part.type==='input_image'?[part.image_url]:[]):[]);
 expect(urls).toEqual(expected);expect(inputImageCount(input)).toBe(Math.max(2,batch.length));
});
test('all eight unseen frames survive separate calls from one response',()=>{
 const input:ResponseInputItem[]=[],history:ResponseInputItem[]=[];
 appendToolImages(input,history,['old1','old2']);
 appendToolImages(input,history,['a1','a2','a3','a4']);pruneConsumedToolImages(input,history,4);
 appendToolImages(input,history,['b1','b2','b3','b4']);pruneConsumedToolImages(input,history,8);
 expect(inputImageCount(input)).toBe(8);expect(JSON.stringify(input)).not.toContain('old');
});

test('tracked desktop frames rebind after compaction and checkpoint roundtrip without pruning identical user uploads',async()=>{
 const {rebindToolImages,restoreToolImages}=await import('../services/daemon/image-history.ts');
 const upload:ResponseInputItem={role:'user',content:[{type:'input_image',image_url:'same-pixels',detail:'original'}]};
 let input:ResponseInputItem[]=[upload],history:ResponseInputItem[]=[];
 appendToolImages(input,history,['same-pixels','old2']);
 const compacted:ResponseInputItem[]=structuredClone(input);
 rebindToolImages(input,compacted,history);
 input=compacted;
 const indexes=history.map(item=>input.indexOf(item));
 input=structuredClone(input);
 history=restoreToolImages(input,indexes);
 for(const frame of ['new1','new2','new3']){appendToolImages(input,history,[frame]);pruneConsumedToolImages(input,history);}
 expect(inputImageCount(input)).toBe(3);
 expect(input[0]).toEqual(upload);
 expect(JSON.stringify(input)).not.toContain('old2');
 expect(JSON.stringify(history)).not.toContain('same-pixels');
});
