import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,linkSync,mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {basename,join,resolve,dirname} from 'node:path';

function command(binary,args){
 const result=spawnSync(binary,args,{encoding:'utf8'});
 assert.equal(result.status,0,`${binary} failed: ${result.stderr||result.stdout}`);
 return result;
}
const team=process.env.ASSISTANT_DEVELOPMENT_TEAM;
const bundle=process.env.ASSISTANT_MACOS_BUNDLE_ID;
assert.ok(team&&/^[A-Z0-9]{10}$/.test(team),'Set ASSISTANT_DEVELOPMENT_TEAM to your Apple team ID');
assert.ok(bundle&&/^[A-Za-z0-9.-]+$/.test(bundle),'Set ASSISTANT_MACOS_BUNDLE_ID to your bundle identifier');
function verify(app){
 command('codesign',['--verify','--deep','--strict',app]);
 const signature=command('codesign',['-dv','--verbose=4',app]).stderr;
 assert.ok(signature.includes('Authority=Developer ID Application:'),'Development builds cannot be distributed');
 assert.ok(signature.split('\n').includes(`TeamIdentifier=${team}`));
 assert.ok(signature.split('\n').includes(`Identifier=${bundle}`));
 command('xcrun',['stapler','validate',app]);
 command('spctl',['--assess','--type','execute','--verbose=2',app]);
 command('syspolicy_check',['distribution',app]);
}

const [appArgument,zipArgument,...extra]=process.argv.slice(2);
assert.ok(appArgument&&zipArgument&&extra.length===0,'Usage: bun scripts/package-macos.mjs APP_PATH ZIP_PATH');
const app=resolve(appArgument),zip=resolve(zipArgument);
assert.equal(basename(app),'Assistant.app');
assert.ok(zip.endsWith('.zip')&&!existsSync(zip),'Use a new ZIP path');
verify(app);
const temporary=mkdtempSync(join(dirname(zip),'.assistant-package-check-'));
const candidate=join(temporary,'Assistant.zip'),extracted=join(temporary,'extracted');
try{
 command('ditto',['-c','-k','--sequesterRsrc','--keepParent',app,candidate]);
 command('ditto',['-x','-k',candidate,extracted]);
 verify(join(extracted,'Assistant.app'));
 linkSync(candidate,zip);
 console.log(JSON.stringify({archive:zip,bytes:statSync(zip).size,sha256:createHash('sha256').update(readFileSync(zip)).digest('hex'),signature:true,stapled:true,gatekeeper:true,distribution_check:true,extracted_copy_verified:true}));
}finally{rmSync(temporary,{recursive:true});}
