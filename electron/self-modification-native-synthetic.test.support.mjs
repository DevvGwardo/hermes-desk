// Transparent synthetic contracts ONLY. No native executable or qualification.
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
export const contract=require('./self-modification-native-contract.cjs')
const tree=require('./self-modification-artifact.cjs')
export function syntheticBarrier() {
  const inventory=contract.SURFACE_LABELS.map(label=>({label,state:'guarded'}))
  const results=inventory.filter(r=>!['input.file-color-and-select.click','input.pointer-keyboard-default-action'].includes(r.label))
    .map(r=>({...r,route:'SYNTHETIC ONLY',outcome:'denied-before-effect',denials:1}))
  for(const kind of ['file','color','select'])for(const event of ['click','pointerdown','mousedown','dblclick','keydown','keyup','beforeinput'])
    results.push({label:'input.'+kind+'.'+event,state:'guarded',route:'SYNTHETIC ONLY',outcome:'default-prevented-before-effect',denials:1})
  const barrier={inventory,results,controls:[true,true,true,true]}
  return {barrier,inventoryDigest:tree.sha(JSON.stringify(inventory)),
    permissionEvidence:{requestDenied:true,checkDenied:true,deviceDenied:true,displayDenied:true}}
}
export function metrics(id) {
  return [['Browser',id.browserPid,id.browserCreationTime],['Tab',id.pid,id.creationTime]].map(([type,pid,creationTime])=>({
    cpu:{cumulativeCPUUsage:0,percentCPUUsage:0,idleWakeupsPerSecond:0},pid,type,creationTime,
    memory:{workingSetSize:1,peakWorkingSetSize:1},sandboxed:true}))
}
export function kernel(executable,pid,browserPid,paths=[],role=pid===browserPid?'browser':'renderer') {
  const denied={rc:1,errno:0},allowed={rc:0,errno:0},browser=role==='browser'
  return {pid,ppid:browser?1:browserPid,startSec:1234561,startUsec:1,executable,
    privateSocket:browser?'99':'0',sockets:browser?['99']:[],
    paths:paths.map(p=>({pathDigest:tree.sha(p),'file-read-data':denied,'file-write-data':denied,
      'file-write-unlink':denied,'file-write-create':denied})),
    mach:Object.fromEntries(['com.apple.SecurityServer','com.apple.tccd','com.apple.tccd.system','com.apple.pasteboard.1',
      'com.apple.coreservices.launchservicesd','com.github.Electron.MachPortRendezvousServer.unrelated']
      .map(n=>[n,browser&&n==='com.apple.coreservices.launchservicesd'?allowed:denied])),
    generic:{'network-outbound':denied,'network-inbound':denied,'network-bind':denied,'appleevent-send':denied,
      'process-fork':browser?allowed:denied},
    rendezvous:{registerBrowser:browser?allowed:denied,registerUnrelated:denied,lookupBrowser:browser?denied:allowed,lookupUnrelated:denied}}
}
export function syntheticQualification(base,job=base.job,nonce=base.nonce) {
  const q=structuredClone(base),id={windowId:1,webContentsId:1,pid:2147483002,browserPid:2147483001,
    creationTime:1234561000.001,browserCreationTime:1234561000.001}
  Object.assign(q,{version:2,policy:contract.POLICY,job,nonce,policyDigest:'a'.repeat(64),guardDigest:'b'.repeat(64),
    entryDigest:'c'.repeat(64),identity:id,metrics:metrics(id)})
  q.runtime={relativePath:base.runtime.relativePath,sha256:base.runtime.sha256,pid:id.browserPid,
    creationTime:id.browserCreationTime,executable:path.join(job,'app/node_modules',base.runtime.relativePath),
    rendererExecutable:path.join(job,'app/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)'),rendererSha256:'d'.repeat(64)}
  q.preload={path:path.join(job,'app/electron/preload.cjs'),sha256:'e'.repeat(64),provenance:'actual-genuine-constructor-and-passive-bridge'}
  q.privateChannel={version:1,kind:'cloexec-private-fd-v1',nonce,artifactDigest:q.artifactDigest,identity:id,
    rendererInherited:false,observationDigest:q.observationDigest}
  const paths=[path.join(job,'protected.txt')]
  q.kernelEvidence={paths,browser:kernel(q.runtime.executable,id.browserPid,id.browserPid,paths),
    renderer:kernel(q.runtime.rendererExecutable,id.pid,id.browserPid,paths)}
  contract.validateQualification(q)
  return q
}
// Load genuine implementations with the closed admission gate replaced for
// synthetic fixtures. An explicitly supplied test clock can accelerate timers;
// implementation/predicates stay byte-identical. No production enabling option.
export function syntheticModule(name,overrides={},clock={setTimeout,clearTimeout}) {
  const filename=require.resolve(name),module={exports:{}}
  const syntheticContract={...contract,phase2Available:()=>true,assertAuthority:contract.validateQualification}
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,__dirname:path.dirname(filename),
    Buffer,process,AbortController,URL,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,setInterval,clearInterval,console,
    require:n=>overrides[n]||(n==='./self-modification-native-contract.cjs'?syntheticContract:require(n))},{filename})
  return module.exports
}
