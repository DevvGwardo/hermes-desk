// Owned inert bytes / genuine public contracts / synthetic DOM originals only.
// No native OS calls, generated self-edit candidate, approval or live activation.
import {it,expect,afterEach,vi} from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {randomUUID} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {EventEmitter} from 'node:events'
import {JSDOM} from 'jsdom'
import {fixture,supervisor,tree} from './self-modification-fixture.test.support.mjs'
const require=createRequire(import.meta.url),production=require('./self-modification-supervisor.cjs'),roots=[]
afterEach(()=>{vi.restoreAllMocks();for(const r of roots.splice(0))fs.rmSync(r,{recursive:true,force:true})})
async function interrupted() {
  const f=await fixture({currentNativeSynthetic:true});roots.push(f.root);f.seed()
  const root=f.config.root,previous=await tree.capture(path.join(root,'current')),t=supervisor.target(root),id=randomUUID()
  const tx={version:2,id,versionId:f.record.versionId,state:'intent',nonce:randomUUID(),artifactDigest:f.q.artifactDigest,
    rendererDigest:f.q.rendererDigest,previousDigest:previous.digest,targetDev:t.stat.dev,targetIno:t.stat.ino,
    stage:`stage-${id}`,previous:`known-good-${id}`,ownerPid:2147483647,reason:'',
    previousDev:previous.root.dev,previousIno:previous.root.ino,previousIdentityDigest:supervisor.treeIdentity(path.join(root,'current')),
    targetId:t.value.id,targetDigest:f.record.target.identityDigest,
    qualificationDigest:tree.sha(JSON.stringify(f.q)),qualificationNonce:f.q.nonce,journalRevision:f.record.journalRevision,
    epoch:f.record.epoch,consumer:null}
  tx.consumer={targetId:tx.targetId,versionId:tx.versionId,nonce:tx.nonce,artifactDigest:tx.artifactDigest,rendererDigest:tx.rendererDigest}
  fs.writeFileSync(path.join(root,'transaction.json'),JSON.stringify(tx))
  fs.writeFileSync(path.join(root,'activation.lock'),JSON.stringify({id,pid:tx.ownerPid}))
  return {...f,tx,root,admission:{userData:f.data}}
}
it.each([false,true])('production direct recover and worker CLOSED before writes, mutation=%s',async mutation=>{
  const f=await interrupted()
  if(mutation)fs.writeFileSync(path.join(f.root,'current/index.html'),'OWNED INERT BAD BYTES')
  const before=(await tree.capture(f.root)).digest
  await expect(production.recover(f.root,f.tx.versionId,f.admission)).rejects.toThrow(/Phase 2/)
  const child=spawnSync(process.execPath,[require.resolve('./self-modification-supervisor-worker.cjs')],{
    input:JSON.stringify({action:'recover',root:f.root,versionId:f.tx.versionId,...f.admission}),encoding:'utf8',timeout:5000})
  expect(child.status).toBe(1);expect(child.stdout).toContain('Phase 2')
  expect((await tree.capture(f.root)).digest).toBe(before)
})
it('future synthetic admitted intent verifies exact known-good before acknowledgment/release',async()=>{
  const f=await interrupted()
  expect((await supervisor.recover(f.root,f.tx.versionId,f.admission)).state).toBe('rolled-back')
  expect((await tree.capture(path.join(f.root,'current'))).digest).toBe(f.tx.previousDigest)
  expect(fs.existsSync(path.join(f.root,'activation.lock'))).toBe(false)
})
it.each(['wrong-current','current-replacement','file-replacement','old-wrong','old-symlink','old-replacement','traversal',
  'nonce','artifact','policy','revision','target','lock','rename-result','terminal-write'])(
  'future synthetic recover rejects %s and retains uncertain authority',async fault=>{
    const f=await interrupted(),current=path.join(f.root,'current'),old=path.join(f.root,f.tx.previous)
    if(['old-wrong','old-symlink','old-replacement','rename-result','terminal-write'].includes(fault)) {
      fs.renameSync(current,old);fs.mkdirSync(current);fs.writeFileSync(path.join(current,'index.html'),'OWNED INERT CANDIDATE')
    }
    if(fault==='wrong-current')fs.writeFileSync(path.join(current,'index.html'),'OWNED INERT BAD BYTES')
    if(fault==='file-replacement') {
      const p=path.join(current,'index.html');fs.renameSync(p,p+'.retained');fs.copyFileSync(p+'.retained',p)
    }
    if(fault==='current-replacement'||fault==='old-replacement') {
      const name=fault==='current-replacement'?current:old
      fs.renameSync(name,name+'.retained');tree.materialize(name,(await tree.capture(name+'.retained')).files)
    }
    if(fault==='old-wrong')fs.writeFileSync(path.join(old,'index.html'),'OWNED BAD KNOWN-GOOD')
    if(fault==='old-symlink'){fs.renameSync(old,old+'.retained');fs.symlinkSync(old+'.retained',old)}
    if(fault==='traversal')f.tx.previous='../unknown'
    if(fault==='nonce')f.tx.qualificationNonce=randomUUID()
    if(fault==='artifact')f.tx.artifactDigest='a'.repeat(64)
    if(fault==='policy')f.tx.qualificationDigest='a'.repeat(64)
    if(fault==='revision')f.tx.journalRevision++
    if(fault==='target')f.tx.targetDigest='a'.repeat(64)
    if(fault==='lock')fs.writeFileSync(path.join(f.root,'activation.lock'),JSON.stringify({id:randomUUID(),pid:f.tx.ownerPid}))
    fs.writeFileSync(path.join(f.root,'transaction.json'),JSON.stringify(f.tx))
    if(fault==='rename-result') {
      const rename=fs.renameSync
      vi.spyOn(fs,'renameSync').mockImplementation((a,b)=>{rename(a,b);if(a===old)fs.writeFileSync(path.join(current,'index.html'),'OWNED MUTATED AFTER RENAME')})
    }
    if(fault==='terminal-write')vi.spyOn(fs,'fsyncSync').mockImplementationOnce(()=>{throw Error('OWNED terminal journal failure')})
    await expect(supervisor.recover(f.root,f.tx.versionId,f.admission)).rejects.toThrow()
    expect(fs.existsSync(path.join(f.root,'activation.lock'))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(f.root,'transaction.json'))).state).toBe('intent')
    expect(fs.existsSync(path.join(f.root,`version-${f.tx.versionId}.json`))).toBe(false)
})
function installFrames() {
  const app=new EventEmitter();Object.assign(app,{exit:vi.fn(),whenReady:()=>new Promise(()=>{}),disableHardwareAcceleration:()=>{},enableSandbox:()=>{},commandLine:{appendSwitch:()=>{}}})
  const ipc=()=>Object.assign(new EventEmitter(),{handle:()=>{},handleOnce:()=>{}})
  const protocol={handle:()=>{},registerSchemesAsPrivileged:()=>{}}
  const electron={app,ipcMain:ipc(),protocol,session:{fromPartition:()=>{}},BrowserWindow:class{}}
  const fakeProcess=Object.assign(new EventEmitter(),{versions:{electron:'37.10.3'},pid:123})
  const mocks=new Map(['node:child_process','node:net','node:tls','node:http','node:https','node:dgram','node:worker_threads'].map(n=>[n,{}]))
  const module={exports:{}},messages=[]
  vm.runInNewContext(fs.readFileSync(require.resolve('./self-modification-native-mode.cjs'),'utf8'),{
    module,exports:module.exports,process:fakeProcess,Buffer,URL,Response,console,
    require:n=>n==='electron'?electron:n==='node:module'?{_load:()=>electron}:mocks.has(n)?mocks.get(n):require(n.startsWith('./')?path.join(import.meta.dirname,n):n)})
  const mode=module.exports.install({send:v=>messages.push(v),renderer:'/owned',manifest:[],preload:'/owned/preload.cjs',channels:[]})
  const ses=Object.assign(new EventEmitter(),{setPermissionRequestHandler:()=>{},setPermissionCheckHandler:()=>{},setDevicePermissionHandler:()=>{},
    setDisplayMediaRequestHandler:()=>{},cookies:{set:()=>{},remove:()=>{},flushStore:()=>{}},webRequest:{onBeforeRequest:()=>{}},protocol:{handle:()=>{}}})
  const frame={processId:123,routingId:1}
  const wc=Object.assign(new EventEmitter(),{ipc:ipc(),session:ses,setWindowOpenHandler:()=>{},mainFrame:frame})
  app.emit('web-contents-created',null,wc)
  return {wc,app,messages,mode}
}
it.each(['separate','on-event','malformed','uncancellable','main-unknown'])('installed frame event %s cancels or fatally refuses before dispatch',kind=>{
  const {wc,app}=installFrames(),cancel=vi.fn()
  const event={preventDefault:cancel},details={isMainFrame:false}
  if(kind==='separate')wc.emit('will-frame-navigate',event,details)
  if(kind==='on-event')wc.emit('will-frame-navigate',{...event,...details})
  if(kind==='malformed')wc.emit('will-frame-navigate',event,{isMainFrame:'false'})
  if(kind==='uncancellable')wc.emit('will-frame-navigate',{},details)
  if(kind==='main-unknown')wc.emit('will-frame-navigate',event,{isMainFrame:true,url:'https://example.invalid'})
  expect(cancel).toHaveBeenCalledTimes(kind==='uncancellable'?0:1)
  expect(app.exit).toHaveBeenCalledTimes(['malformed','uncancellable','main-unknown'].includes(kind)?1:0)
})
it.each(['separate','on-event'])('valid canonical installed main-frame %s is still page-navigation denied',format=>{
  const {wc,app,mode}=installFrames(),cancel=vi.fn()
  mode.loadWindow({webContents:wc,loadURL:()=>new Promise(()=>{}),isDestroyed:()=>false})
  const details={isMainFrame:true,isSameDocument:false,url:'hd-native://sealed/index.html',frame:wc.mainFrame}
  const event={preventDefault:cancel}
  wc.emit('will-frame-navigate',format==='on-event'?{...event,...details}:event,...format==='separate'?[details]:[])
  expect(cancel).toHaveBeenCalledOnce();expect(app.exit).not.toHaveBeenCalled()
})
it.each([false,true])('genuine preload synthetic originals: normal=%s / all required family effects refused only when marked',async normal=>{
  const dom=new JSDOM('<!doctype html><body></body>',{runScripts:'outside-only',url:'https://owned.invalid'}),ctx=dom.getInternalVMContext(),w=dom.window
  let delegated=0,bridge
  const original=()=>{delegated++;return Promise.resolve()}
  w.HTMLInputElement.prototype.showPicker=()=>{delegated++}
  w.HTMLSelectElement.prototype.showPicker=()=>{delegated++}
  w.HTMLVideoElement.prototype.requestPictureInPicture=original
  Object.defineProperty(w.navigator,'credentials',{value:{get:original,create:original,store:original,preventSilentAccess:original}})
  w.documentPictureInPicture={requestWindow:original}
  ctx.process={argv:normal?[]:['--hd-native-readonly-preload-v1'],platform:'darwin',versions:{electron:'37.10.3'}}
  ctx.require=()=>({contextBridge:{executeInMainWorld:({func})=>func(),exposeInMainWorld:(_name,v)=>bridge=v},
    ipcRenderer:{invoke:()=>Promise.resolve({ok:true}),on:()=>{},removeListener:()=>{},sendSync:()=>{}}})
  vm.runInContext(fs.readFileSync(require.resolve('./preload.cjs'),'utf8'),ctx)
  const color=w.document.createElement('input');color.type='color'
  const select=w.document.createElement('select')
  color.showPicker();select.showPicker()
  if(normal) {await w.navigator.credentials.get();await w.documentPictureInPicture.requestWindow();expect(delegated).toBe(4)}
  else {
    await expect(w.navigator.credentials.get()).rejects.toThrow(/read-only/)
    await expect(w.documentPictureInPicture.requestWindow()).rejects.toThrow(/read-only/)
    await expect(w.HTMLVideoElement.prototype.requestPictureInPicture.call({})).rejects.toThrow(/read-only/)
    expect(()=>w.Document.prototype.createElement.call(w.document,'iframe')).toThrow(/read-only/)
    expect(()=>new w.DOMParser().parseFromString('<iframe></iframe>','text/html')).toThrow(/read-only/)
    expect(()=>w.document.createRange().createContextualFragment('<iframe></iframe>')).toThrow(/read-only/)
    const div=w.document.createElement('div');div.innerHTML='<p>SAFE</p>';w.document.body.appendChild(div)
    const ev=new w.Event('keydown',{bubbles:true,cancelable:true});w.document.body.appendChild(color);color.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true);expect(delegated).toBe(0)
    const barrier=await vm.runInContext('('+require('./self-modification-native-surface-probe.cjs').probe.toString()+')()',ctx)
    expect(barrier.controls.every(v=>v===true)).toBe(true)
    expect(barrier.results.length).toBeGreaterThan(60)
    expect(delegated).toBe(0)
    const exec=w.RegExp.prototype.exec
    w.RegExp.prototype.exec=()=>null
    try {
      expect(()=>w.document.createElement('iframe')).toThrow(/read-only/)
      expect(()=>div.innerHTML='<iframe></iframe>').toThrow(/read-only/)
    } finally {w.RegExp.prototype.exec=exec}
  }
  expect(await bridge.changes.list()).toEqual({ok:true});w.close()
})
it.each([0,1])('preload insertion refuses native frame under Array.prototype[%s] poisoning',index=>{
  const dom=new JSDOM('<!doctype html><body></body>',{runScripts:'outside-only',url:'https://owned.invalid'})
  const ctx=dom.getInternalVMContext(),w=dom.window
  ctx.process={argv:['--hd-native-readonly-preload-v1'],platform:'darwin',versions:{electron:'37.10.3'}}
  ctx.require=()=>({contextBridge:{executeInMainWorld:({func})=>func(),exposeInMainWorld:()=>{}},
    ipcRenderer:{invoke:()=>Promise.resolve({ok:true}),on:()=>{},removeListener:()=>{},sendSync:()=>{}}})
  try {
    vm.runInContext(fs.readFileSync(require.resolve('./preload.cjs'),'utf8'),ctx)
    const result=vm.runInContext(`(()=>{
      const doc=document.implementation.createDocument('http://www.w3.org/1999/xhtml','iframe',null)
      const frame=doc.documentElement,range=doc.createRange()
      range.selectNode(frame)
      const fragment=range.extractContents()
      if(${index}===1)fragment.prepend(document.createElement('span'))
      let ordinaryRefused=false,poisonedRefused=false
      try{document.body.appendChild(fragment)}catch(e){ordinaryRefused=e.name==='NotAllowedError'}
      Object.defineProperty(Array.prototype,'${index}',{configurable:true,set(){},get(){return undefined}})
      try{document.body.appendChild(fragment)}catch(e){poisonedRefused=e.name==='NotAllowedError'}
      finally{delete Array.prototype['${index}']}
      return {ordinaryRefused,poisonedRefused,connected:frame.parentNode===document.body,windowAbsent:frame.contentWindow===null}
    })()`,ctx)
    expect(result).toEqual({ordinaryRefused:true,poisonedRefused:true,connected:false,windowAbsent:true})
  } finally {w.close()}
})
it('native activation gate denies window-capture, closed-shadow and control-type mutation routes',()=>{
  const dom=new JSDOM('<!doctype html><body></body>',{runScripts:'outside-only',url:'https://owned.invalid'})
  const ctx=dom.getInternalVMContext(),w=dom.window
  ctx.process={argv:['--hd-native-readonly-preload-v1'],platform:'darwin',versions:{electron:'37.10.3'}}
  ctx.require=()=>({contextBridge:{executeInMainWorld:({func})=>func(),exposeInMainWorld:()=>{}},
    ipcRenderer:{invoke:()=>Promise.resolve({ok:true}),on:()=>{},removeListener:()=>{},sendSync:()=>{}}})
  try {
    vm.runInContext(fs.readFileSync(require.resolve('./preload.cjs'),'utf8'),ctx)
    const result=vm.runInContext(`(()=>{
      const make=()=>{const input=document.createElement('input');input.type='color';document.body.appendChild(input);return input}
      const dispatch=node=>{const e=new MouseEvent('click',{bubbles:true,cancelable:true,composed:true})
        const before=window.__hdNativeSurfaceDenials;node.dispatchEvent(e)
        return {defaultPrevented:e.defaultPrevented,denials:window.__hdNativeSurfaceDenials-before}}
      const plain=document.createElement('div');document.body.appendChild(plain)
      const ordinaryNonControl=dispatch(plain)
      const ordinary=dispatch(make())
      const stop=e=>e.stopPropagation()
      window.addEventListener('click',stop,true)
      const intercepted=dispatch(make())
      window.removeEventListener('click',stop,true)
      const host=document.createElement('div');document.body.appendChild(host)
      const shadow=host.attachShadow({mode:'closed'})
      const hidden=document.createElement('input');hidden.type='color';shadow.appendChild(hidden)
      const closedShadow=dispatch(hidden)
      // Ancestor capture listener stopping propagation before the root listener.
      window.addEventListener('click',stop,true)
      const closedShadowStarved=dispatch(hidden)
      window.removeEventListener('click',stop,true)
      // Page replaces the intrinsic addEventListener before calling attachShadow.
      const replacedHost=document.createElement('div');document.body.appendChild(replacedHost)
      const original=EventTarget.prototype.addEventListener
      EventTarget.prototype.addEventListener=function(){}
      const replacedRoot=replacedHost.attachShadow({mode:'closed'})
      const replacedControl=document.createElement('input');replacedControl.type='color';replacedRoot.appendChild(replacedControl)
      EventTarget.prototype.addEventListener=original
      const replacedAddEventListener=dispatch(replacedControl)
      const mutated=make();mutated.type='text';mutated.addEventListener('click',()=>{mutated.type='color'})
      const mutatedAfterGuard=dispatch(mutated)
      // Ordinary open shadow root without a control is not a native surface.
      const openHost=document.createElement('div');document.body.appendChild(openHost)
      const openRoot=openHost.attachShadow({mode:'open'});openRoot.innerHTML='<p>SAFE</p>'
      const openShadowOrdinary=dispatch(openRoot.querySelector('p'))
      let declarativeRefused=false
      try{document.createElement('div').innerHTML='<template shadowrootmode="closed"><input type=color></template>'}
      catch(error){declarativeRefused=error.name==='NotAllowedError'}
      document.open();document.write('<!doctype html><body></body>');document.close()
      const afterDocumentOpen=dispatch(make())
      return {ordinaryNonControl,ordinary,intercepted,closedShadow,closedShadowStarved,replacedAddEventListener,
        mutatedAfterGuard,openShadowOrdinary,declarativeRefused,afterDocumentOpen}
    })()`,ctx)
    expect(result.ordinaryNonControl).toEqual({defaultPrevented:false,denials:0})
    expect(result.openShadowOrdinary).toEqual({defaultPrevented:false,denials:0})
    expect(result.declarativeRefused).toBe(true)
    for(const route of ['ordinary','intercepted','closedShadow','closedShadowStarved','replacedAddEventListener',
      'mutatedAfterGuard','afterDocumentOpen'])
      expect(result[route]).toEqual({defaultPrevented:true,denials:1})
  } finally {w.close()}
})
