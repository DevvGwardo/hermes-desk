// Actual Electron/ASAR/lease UI using only FIXED TRUSTED HTML, NOT a generated
// candidate or native qualification. Never touch the live original application.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {_electron as electron} from 'playwright-core'
const require=createRequire(import.meta.url),repo=path.resolve(import.meta.dirname,'../..')
const host=require('../../electron/self-modification-host.cjs')
const tree=require('../../electron/self-modification-artifact.cjs')
const asar=require('@electron/asar')
const root=fs.realpathSync(fs.mkdtempSync('/tmp/hd-selfedit-owned-consumer-'))
const report={root,scope:'fixed-trusted-owned-consumer-and-ASAR-only',nativeQualification:false,artifactApproved:false,checks:[]}
const closure=await host.inspect(path.join(repo,'electron'))
fs.mkdirSync(path.join(root,'host'))
tree.materialize(path.join(root,'host/electron'),closure.files)
fs.writeFileSync(path.join(root,'host/package.json'),closure.packageBytes)
const archive=path.join(root,'host.asar')
await asar.createPackage(path.join(root,'host'),archive)
for(const dir of ['home','tmp','data'])fs.mkdirSync(path.join(root,dir),{mode:0o700})
const entry=path.join(root,'entry.cjs')
fs.writeFileSync(entry,`
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto')
const {app,BrowserWindow}=require('electron')
app.enableSandbox();app.setPath('userData',${JSON.stringify(path.join(root,'data'))});app.on('window-all-closed',()=>{})
app.whenReady().then(async()=>{
 const host=require(${JSON.stringify(path.join(repo,'electron/self-modification-host.cjs'))})
 const tree=require(${JSON.stringify(path.join(repo,'electron/self-modification-artifact.cjs'))})
 const s=require(${JSON.stringify(path.join(repo,'electron/self-modification-supervisor.cjs'))})
 const c=require(${JSON.stringify(path.join(repo,'electron/self-modification-consumer.cjs'))})
 globalThis.asarHost=await host.inspect(${JSON.stringify(archive+'/electron')})
 if(globalThis.asarHost.identity.codeDigest!==${JSON.stringify(closure.identity.codeDigest)})throw Error('ASAR host closure differs')
 fs.mkdirSync(${JSON.stringify(path.join(root,'data/self-modification'))})
 globalThis.physicalWorker=await host.stageWorker(${JSON.stringify(path.join(root,'data'))},${JSON.stringify(archive+'/electron')})
 const renderer=${JSON.stringify(path.join(root,'fixed-renderer'))},target=${JSON.stringify(path.join(root,'target'))}
 tree.materialize(renderer,[{path:'index.html',mode:0o600,bytes:Buffer.from('<!doctype html><html><body><p id="owned">FIXED TRUSTED OWNED RENDERER</p></body></html>')}])
 await s.initializeTarget(target,renderer,{hostDigest:globalThis.asarHost.identity.codeDigest,protectedDigest:'8'.repeat(64)})
 const snapshot=await tree.capture(path.join(target,'current'))
 globalThis.lease=await c.open(target,{hostDigest:globalThis.asarHost.identity.codeDigest,protectedDigest:'8'.repeat(64),
  versionId:randomUUID(),nonce:randomUUID(),artifactDigest:'7'.repeat(64),rendererDigest:snapshot.digest},{trustedBootstrap:true})
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
 await win.loadFile(path.join(globalThis.lease.renderer,'index.html'))
 globalThis.consumeProof={url:win.webContents.getURL(),rendererDigest:snapshot.digest,pid:process.pid,
  osSandbox:app.getAppMetrics().find(m=>m.pid===win.webContents.getOSProcessId())?.sandboxed}
 globalThis.assertIdle=()=>s.assertIdle(target)
 globalThis.targetStatus=()=>s.target(target)
}).catch(e=>{console.error(e.stack);app.exit(1)})
`,{flag:'wx',mode:0o600})
let app
try {
  app=await electron.launch({executablePath:require('electron'),args:[entry],
    env:{PATH:'/usr/bin:/bin',HOME:path.join(root,'home'),TMPDIR:path.join(root,'tmp'),LANG:'en_US.UTF-8'}})
  const page=await app.firstWindow()
  await page.getByText('FIXED TRUSTED OWNED RENDERER',{exact:true}).waitFor()
  const proof=await app.evaluate(()=>({asar:globalThis.asarHost.identity,worker:globalThis.physicalWorker,
    observed:globalThis.consumeProof,binding:globalThis.lease.binding}))
  assert.equal(proof.asar.origin.kind,'asar')
  assert.equal(proof.asar.origin.archiveSha256,tree.sha(fs.readFileSync(archive)))
  assert.equal(proof.asar.version,closure.identity.version)
  assert.equal(proof.observed.osSandbox,true)
  assert.equal(proof.observed.url,new URL('file://'+path.join(root,'target/current/index.html')).href)
  assert.equal(proof.binding.rendererDigest,proof.observed.rendererDigest)
  assert.equal(fs.existsSync(proof.worker.entry),true)
  report.proof=proof
  report.checks.push('Real physical ASAR bytes, actual protected-host code/version and identical physical external worker closure')
  assert.equal(await app.evaluate(()=>{try{globalThis.assertIdle();return false}catch{return true}}),true)
  await app.evaluate(()=>globalThis.lease.begin('owned-unsaved-draft'))
  assert.equal(await app.evaluate(()=>{try{globalThis.targetStatus();return false}catch{return true}}),true)
  assert.equal(await app.evaluate(()=>{try{globalThis.lease.close();return false}catch{return true}}),true)
  await app.evaluate(({BrowserWindow})=>{globalThis.lease.end('owned-unsaved-draft');for(const w of BrowserWindow.getAllWindows())w.close();globalThis.lease.close()})
  assert.equal(fs.existsSync(path.join(root,'target/activation.lock')),false)
  report.checks.push('Real OS-sandboxed fixed trusted renderer consumes bound current bytes under lease; actual idle refusal, pending-work refusal, explicit safe release')
}catch(error){report.failure=error.stack;process.exitCode=1}
finally{if(app)await app.close();fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))}
