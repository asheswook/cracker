import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo=fileURLToPath(new URL('../',import.meta.url));
const baseline=process.env.MESSAGE_MOTION_BASELINE==='1';
const evidence=join(repo,'.omo/evidence/message-motion',`${baseline?'before':'after'}-${Date.now()}`);
mkdirSync(evidence,{recursive:true});
const build=mkdtempSync(join(tmpdir(),'message-motion-build-')),profile=mkdtempSync(join(tmpdir(),'message-motion-chrome-'));
const compiled=spawnSync('bun',['build','apps/web/tests/message-motion.tsx','--target=browser','--entry-naming=harness.[ext]','--outdir',build],{cwd:repo,encoding:'utf8'});
writeFileSync(join(evidence,'build.log'),compiled.stdout+compiled.stderr);
assert.equal(compiled.status,0);
const server=spawn('bun',['tests/fixtures/message-motion/server.ts'],{cwd:repo,env:{...process.env,MESSAGE_MOTION_BUILD:build},stdio:['ignore','pipe','pipe']});
const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture startup timeout')),10000);server.on('error',reject);server.stdout.on('data',data=>{const match=String(data).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
const {loadOmowright}=await import(join(homedir(),'.codex/plugins/cache/sisyphuslabs/omo/5.1.7/skills/browser/scripts/omowright.mjs'));
const {omowright}=await loadOmowright();
let browser,page;
const results=[];
const sources=['WorkingBubble.tsx','MessageList.tsx','MessageBubble.tsx','Chat.tsx','messageArrivals.ts','message-motion.css','store.ts'];
writeFileSync(join(evidence,'source-hashes.json'),JSON.stringify(Object.fromEntries(sources.map(name=>[name,createHash('sha256').update(readFileSync(join(repo,'apps/web/src',name))).digest('hex')])),null,2));
const click=id=>page.locator(`#${id}`).click();
async function fresh(){await page.goto(origin,{waitUntil:'load'});await omowright.repinViewport(page,{width:768,height:812});await page.locator('#begin').waitFor({state:'visible'});}
async function trace(name,action,duration=700){
  await page.evaluate(duration=>{window.motionFrames=[];window.motionDone=new Promise(resolve=>{const start=performance.now();const sample=()=>{const working=document.querySelector('.working-message'),bubble=document.querySelector('.typing-bubble'),feed=document.querySelector('.message-feed');window.motionFrames.push({time:performance.now()-start,fixture:JSON.parse(document.querySelector('#fixture-state').textContent),signal:JSON.parse(document.querySelector('#fixture-state').textContent).signal,working:{active:working?.dataset.active,exiting:working?.dataset.exiting,cleared:working?.dataset.cleared,status:bubble?.getAttribute('role'),paused:bubble?.querySelector('i')?getComputedStyle(bubble.querySelector('i')).animationPlayState:null,dots:bubble?.querySelectorAll('i').length??0,height:working?.getBoundingClientRect().height??0,opacity:bubble?Number(getComputedStyle(bubble).opacity):0},gap:feed.scrollHeight-feed.clientHeight-feed.scrollTop,messages:[...document.querySelectorAll('.message')].map(node=>({id:node.id,pending:node.dataset.pendingId??null,text:node.querySelector('.bubble')?.textContent?.slice(0,120),opacity:Number(getComputedStyle(node).opacity),transform:getComputedStyle(node).transform,top:node.getBoundingClientRect().top}))});if(performance.now()-start<duration)requestAnimationFrame(sample);else resolve(window.motionFrames);};requestAnimationFrame(sample);});},duration);
  await action();
  const frames=await page.evaluate(()=>window.motionDone);
  writeFileSync(join(evidence,`${name}.json`),JSON.stringify(frames,null,2));
  writeFileSync(join(evidence,`${name}.png`),await page.screenshot());
  results.push({name,frames:frames.length,visibleTypingFrames:frames.filter(frame=>frame.working.dots>0&&frame.working.opacity>0.05&&frame.working.height>5).length,lastGap:frames.at(-1).gap});
  return frames;
}
try{
  browser=await omowright.connectPipe({browserPath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',browserArgs:['--headless','--no-first-run',`--user-data-dir=${profile}`],storageRoot:profile,readinessTimeoutMs:30000});page=await browser.newTab('about:blank');
  await fresh();
  const fast=await trace('fast-reply',()=>click('fast'));
  if(!baseline)assert(fast.every(frame=>frame.working.dots===0),'60ms signal must not flash');
  await fresh();
  const delayed=await trace('delayed-composing',()=>click('begin'));
  if(!baseline){const signalled=delayed.find(frame=>frame.signal),shown=delayed.find(frame=>frame.working.active==='true');assert(shown&&signalled&&shown.time-signalled.time>=100,'onset must wait for stable observed signal');}
  const renew=await trace('renew-signal',()=>click('renew'));
  if(!baseline)assert(renew.every(frame=>frame.working.active==='true'),'same signal renewal must not restart');
  const handoff=await trace('reply-handoff',()=>click('reply'));
  if(!baseline){assert(handoff.some(frame=>!frame.signal&&frame.working.exiting==='true'&&frame.working.dots===3&&frame.working.status===null&&frame.working.paused==='paused'),'handoff must freeze only visual old bubble');assert.equal(handoff.at(-1).working.dots,0);assert(handoff.some(frame=>frame.messages.some(message=>message.opacity>0&&message.opacity<1&&message.transform!=='none')),'reply must rise');}
  await fresh();
  const history=await trace('history-prepend',()=>click('history'));
  if(!baseline)assert(history.every(frame=>frame.messages.every(message=>message.opacity===1&&message.transform==='none')),'history must not enter');
  const duplicate=await trace('duplicate-poll',()=>click('duplicate'));
  if(!baseline)assert(duplicate.every(frame=>frame.messages.every(message=>message.opacity===1&&message.transform==='none')),'duplicate must not enter');
  await fresh();
  const hydrated=await trace('history-hydration',()=>click('hydrate'));
  if(!baseline)assert(hydrated.every(frame=>frame.messages.every(message=>message.opacity===1&&message.transform==='none')),'hydrated history must not enter');
  await fresh();
  await page.locator('textarea').fill('키보드로 보낸 합성 메시지');
  const human=await trace('human-send',()=>page.keyboard.press('Enter'));
  if(!baseline)assert(human.some(frame=>frame.messages.some(message=>message.pending&&message.opacity>0&&message.opacity<1&&message.transform!=='none')),'human pending must rise');
  const ack=await trace('human-ack',()=>click('ack'));
  if(!baseline)assert(ack.every(frame=>frame.messages.every(message=>message.opacity===1&&message.transform==='none')),'ack must not replay');
  for(const cancellation of ['idle','cancel','unread','disconnect','task-switch','conversation-switch','wrong-source']){
    await fresh();await trace(`${cancellation}-setup`,()=>click('begin'),350);
    const stopped=await trace(cancellation,()=>click(cancellation),cancellation==='idle'?650:350);
    if(!baseline){if(cancellation==='idle')assert(stopped.filter(frame=>!frame.signal).every(frame=>frame.working.active==='false'&&frame.working.status===null),'idle ends semantic typing immediately');const cleared=stopped.findIndex(frame=>frame.working.cleared==='true');assert(cleared>=0,cancellation+' must clear');assert(stopped.slice(cleared).every(frame=>frame.working.dots===0&&frame.working.height===0&&frame.working.status===null),cancellation+' must immediately remove visual and semantic status');}
  }
  await fresh();
  const expiry=await trace('lease-expiry',()=>click('expires'),1100);
  if(!baseline){assert(expiry.some(frame=>frame.working.active==='true'));assert.equal(expiry.at(-1).working.dots,0);}
  await fresh();
  await trace('long-history',()=>click('long-history'));
  const narrow=await trace('anchored-resize',()=>omowright.repinViewport(page,{width:375,height:812}));
  if(!baseline)assert(Math.abs(narrow.at(-1).gap)<=1,'resize must retain bottom');
  await trace('anchored-composing',()=>click('begin'));
  const longHandoff=await trace('anchored-handoff',()=>click('reply'));
  if(!baseline){const rows=longHandoff.filter(frame=>frame.fixture.messages===31).map(frame=>frame.messages.at(-1));assert(rows.length>3);assert(rows[0].top>rows.at(-1).top+5,'overflow handoff must rise from below, not fall as old shell collapses');assert(rows.every(row=>row.top>=rows.at(-1).top-1),'handoff must never start above final reply');}
  const tail=await trace('anchored-tail',()=>click('reply'));
  if(!baseline)assert(Math.abs(tail.at(-1).gap)<=1,'new tail must retain bottom');
  const reading=await trace('reader-wheel',async()=>page.cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:180,y:450,deltaX:0,deltaY:-600},await page.resolveSessionId()));
  if(!baseline)assert(reading.at(-1).gap>100,'trusted wheel must release bottom');
  const whileReading=await trace('reader-new-tail',()=>click('reply'));
  if(!baseline){assert(whileReading.at(-1).gap>100,'new reply must not steal reader position');await page.locator('.new-message').waitFor({state:'visible'});}
  const returned=await trace('reader-return',()=>page.locator('.new-message').click(),1000);
  if(!baseline)assert(Math.abs(returned.at(-1).gap)<=1,'new message action must reach bottom');
  await fresh();
  await page.cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},await page.resolveSessionId());
  const reduced=await trace('reduced-arrival',()=>click('reply'));
  if(!baseline)assert(reduced.every(frame=>frame.messages.every(message=>message.opacity===1&&message.transform==='none')),'reduced motion must be immediate');
}finally{
  await browser?.close();
  const exited=new Promise(resolve=>server.once('exit',resolve));server.kill();await exited;
  rmSync(profile,{recursive:true,force:true});rmSync(build,{recursive:true,force:true});
  writeFileSync(join(evidence,'results.json'),JSON.stringify({baseline,results,cleanup:{browser:true,server:true,profile:true,build:true}},null,2));
  console.log(JSON.stringify({evidence,baseline,results},null,2));
}
