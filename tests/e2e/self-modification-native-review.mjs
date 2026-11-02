// Real independent native review UI ONLY. Never artifact qualification/approval.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import { _electron as electron } from 'playwright-core'
const require=createRequire(import.meta.url)
const repo=path.resolve(import.meta.dirname,'../..')
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hd-self-edit-native-review-'))
const report={scope:'independent-native-review-UI-only',nativeQualification:false,artifactApproved:false,root,checks:[]}
for(const folder of ['home','userData','tmp']) fs.mkdirSync(path.join(root,folder),{mode:0o700})
const entry=path.join(root,'entry.cjs')
fs.writeFileSync(entry,`
const {app}=require('electron')
app.enableSandbox();app.setPath('userData',${JSON.stringify(path.join(root,'userData'))})
app.on('window-all-closed',()=>{})
app.whenReady().then(async()=>{
 const view=require(${JSON.stringify(path.join(repo,'electron/self-modification-review.cjs'))})
 globalThis.nativeReviewResults=[]
 for(const title of ['Owned decline review','Owned continue review']){
  const allowed=await view.read({title,detail:'Artifact: SYNTHETIC UI FIXTURE ONLY\\n</pre><script>window.UNTRUSTED_EXECUTED=true</script>\\n'+('complete diff line\\n'.repeat(10000))})
  globalThis.nativeReviewResults.push(allowed)
 }
}).catch(e=>{console.error(e.stack);app.exit(1)})
`,{flag:'wx',mode:0o600})
let app
try {
  app=await electron.launch({executablePath:require('electron'),args:[entry],
    env:{PATH:'/usr/bin:/bin',HOME:path.join(root,'home'),TMPDIR:path.join(root,'tmp'),LANG:'en_US.UTF-8'}})
  const first=await app.firstWindow()
  await first.getByRole('heading',{name:'Owned decline review',exact:true}).waitFor()
  assert.equal(await first.getByRole('button',{name:'Continue to separate native confirmation'}).isEnabled(),false)
  assert.deepEqual(await first.evaluate(()=>({node:typeof window.require,bridge:typeof window.nubAgent,injected:typeof window.UNTRUSTED_EXECUTED})),
    {node:'undefined',bridge:'undefined',injected:'undefined'})
  const proof=await app.evaluate(({BrowserWindow,ipcMain,app})=>{
    const win=BrowserWindow.getAllWindows()[0],p=win.webContents.getLastWebPreferences()
    const key=[...ipcMain._invokeHandlers.keys()].find(k=>k.startsWith('hd:self-edit-review:'))
    return {node:p.nodeIntegration,isolation:p.contextIsolation,sandbox:p.sandbox,
      osSandbox:app.getAppMetrics().find(m=>m.pid===win.webContents.getOSProcessId())?.sandboxed,
      foreign:ipcMain._invokeHandlers.get(key)({sender:win.webContents,senderFrame:{}},true)}
  })
  assert.deepEqual(proof,{node:false,isolation:true,sandbox:true,osSandbox:true,foreign:false})
  report.checks.push('Real hardened native review window, OS sandbox observation, no application bridge/Node, escaped hostile text, private foreign-frame denial, default cancel')
  await first.getByRole('button',{name:'Cancel',exact:true}).click()
  let second
  for(let i=0;i<200;i++){
    second=app.windows().find(w=>w!==first)
    if(second) break
    await new Promise(r=>setTimeout(r,50))
  }
  assert(second)
  await second.getByRole('heading',{name:'Owned continue review',exact:true}).waitFor()
  await second.getByRole('checkbox').check()
  await second.getByRole('button',{name:'Continue to separate native confirmation'}).click()
  for(let i=0;i<100;i++){
    if((await app.evaluate(()=>globalThis.nativeReviewResults)).length===2)break
    await new Promise(r=>setTimeout(r,25))
  }
  assert.deepEqual(await app.evaluate(()=>globalThis.nativeReviewResults),[false,true])
  assert.equal(await app.evaluate(({ipcMain})=>[...ipcMain._invokeHandlers.keys()].filter(k=>k.startsWith('hd:self-edit-review:')).length),0)
  report.checks.push('Actual decline and deliberate trusted continue, complete scrollable content, ephemeral authority removed; no artifact grant or target application')
} catch(e) {report.failure=e.stack;process.exitCode=1}
finally {if(app)await app.close();fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))}
