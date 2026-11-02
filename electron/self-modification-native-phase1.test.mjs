// Fixed owned state / no generated renderer execution.
import {it,expect,afterEach} from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import {randomUUID} from 'node:crypto'
import vm from 'node:vm'
const require=createRequire(import.meta.url),native=require('./self-modification-native.cjs')
const {createChangeController,registerChangeController}=require('./self-modification.cjs')
const phase=require('./self-modification-native-phase1.cjs')
const roots=[]
it('fixed document-start guard locks native surfaces while preserving the genuine preload bridge (pure VM)',async()=>{
  let nativeCalls=0,bridge
  class Element {click(){nativeCalls++}}
  class Input extends Element {showPicker(){nativeCalls++}}
  const window={alert:()=>nativeCalls++},listeners=[]
  vm.runInNewContext(fs.readFileSync(require.resolve('./preload.cjs'),'utf8'),{
    process:{argv:['--hd-native-readonly-preload-v1'],versions:{electron:'37.10.3'}},window,HTMLElement:Element,HTMLInputElement:Input,DOMException,
    document:{addEventListener:(...args)=>listeners.push(args)},
    require:()=>({contextBridge:{executeInMainWorld:({func})=>func(),exposeInMainWorld:(_name,value)=>bridge=value},
      ipcRenderer:{invoke:channel=>Promise.resolve({channel}),on:()=>{},removeListener:()=>{},sendSync:()=>{}}}),
  })
  window.alert('Never shown')
  expect(nativeCalls).toBe(0)
  expect(Object.getOwnPropertyDescriptor(window,'alert')).toMatchObject({writable:false,configurable:false})
  const file=new Input();file.type='file';file.click();file.showPicker()
  expect(nativeCalls).toBe(0)
  await expect(window.showOpenFilePicker()).rejects.toThrow('read-only')
  expect(await bridge.changes.list()).toEqual({channel:'hd:changes:list'})
  expect(listeners.map(r=>r[0])).toContain('click')
})
afterEach(()=>{for(const r of roots.splice(0))fs.rmSync(r,{recursive:true,force:true})})
it('uses deny-default without framework-subtree exec or loopback exceptions',()=>{
  const p=native.policy('/private/tmp/owned','/private/tmp/owned/runtime/Electron.app',
    '/private/tmp/owned/runtime/Electron.app/Contents/MacOS/Electron')
  expect(p).toContain('(deny default)')
  expect(p).not.toContain('(allow default)')
  expect(p).not.toContain('(allow network')
  expect(p).not.toMatch(/allow process-exec[^\n]+subpath/)
  expect(p).toMatch(/Electron Helper \(Renderer\).*with no-sandbox/)
  expect(p).toContain('(param "BROWSER_PID")')
})
it('genuine passive IPC list never recovers an interrupted preparation or dispatches mutations',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hd-phase1-passive-'));roots.push(root)
  const c=createChangeController(root),created=c.create(0,{request:'Owned synthetic pending',acceptanceCriteria:'No recovery'})
  const change=created.changes[0],attempt=change.attempts[0]
  const pending=c.beginPreparation(1,change.id,attempt.id,{operationId:randomUUID(),ownerPid:9999999,
    source:{root,dev:1,ino:1,gitDev:1,gitIno:1,head:'a'.repeat(40),statusDigest:'b'.repeat(64),dirtyEntries:0,kind:'head',dirtyExcluded:true},
    workspace:{id:randomUUID(),token:randomUUID(),dev:null,ino:null},manifestDigest:null,fileCount:null,error:null})
  expect(pending.ok).toBe(true)
  const before=fs.readFileSync(path.join(root,'self-modification/changes.json'))
  const frame={},sender={mainFrame:frame,getURL:()=> 'hd-native://sealed/index.html'},event={sender,senderFrame:frame}
  const handlers=new Map()
  const detach=registerChangeController({ipcMain:{handle:(channel,fn)=>handlers.set(channel,fn),removeHandler:c=>handlers.delete(c)},
    assertMainSender:()=>{},getMainWindow:()=>({webContents:sender}),getUserDataDir:()=>root,passiveReadOnly:true})
  const list=await handlers.get('hd:changes:list')(event)
  expect(list.ok).toBe(true)
  expect(list.changes[0].attempts[0].state).toBe('preparing')
  expect(await handlers.get('hd:changes:create')(event,2,{request:'No dispatch',acceptanceCriteria:'No dispatch'})).toMatchObject({ok:false})
  expect(fs.readFileSync(path.join(root,'self-modification/changes.json')).equals(before)).toBe(true)
  detach()
})
it.each([null,{},true,'true',{value:{complete:'true',root:true,nodeAbsent:true}},
  {value:{complete:true,root:true,nodeAbsent:true},identity:{},assets:[],blocked:[],receipts:[],metrics:[],counterfeit:true}])(
  'rejects missing/truthy/counterfeit private observations %#',value=>{
    expect(()=>phase.exactObservation(value)).toThrow()
  })
it('never counts EINVAL or omitted kernel fields as a denial',()=>{
  expect(phase.denied({rc:-1,errno:22})).toBe(false)
  expect(phase.denied({rc:1})).toBe(false)
  expect(phase.denied({rc:true,errno:0})).toBe(false)
  expect(phase.denied({rc:1,errno:0,unexpected:true})).toBe(false)
  expect(phase.denied({rc:1,errno:0})).toBe(true)
  expect(()=>phase.validKernel({},'/owned',123)).toThrow()
})
it('keeps Phase 2 generated qualification closed before reading any source',async()=>{
  await expect(native.qualify({source:'/definitely-not-a-source',signal:new AbortController().signal}))
    .rejects.toThrow(/Phase 2.*not released/)
})
it('actual passive controller rejects mutations without creating storage',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hd-phase1-readonly-'));roots.push(root)
  const c=createChangeController(root,fs,{readOnly:true})
  expect(c.list()).toMatchObject({ok:true,revision:0,changes:[]})
  expect(c.create(0,{request:'Owned synthetic request',acceptanceCriteria:'No effects'})).toMatchObject({ok:false})
  expect(fs.readdirSync(root)).toEqual([])
})
