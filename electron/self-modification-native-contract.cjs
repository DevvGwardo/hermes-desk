'use strict'
// Consumption contracts, not a receipt generator or Phase2 release mechanism.
const path=require('node:path'),tree=require('./self-modification-artifact.cjs')
const {keys,identity:uuid}=require('./self-modification-schema.cjs')
const POLICY='native-deny-default-trusted-renderer-v2',VERSION=2
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const integer=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max
const positive=v=>Number.isFinite(v)&&v>0
const canonical=v=>typeof v==='string'&&path.isAbsolute(v)&&path.normalize(v)===v&&!/[\0\r\n]/.test(v)
const pid=v=>integer(v,1,2147483647)
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
const deny=message=>{throw Error(message)}
function phase2Available(){return false}
function validIdentity(v) {
  if(!keys(v,['windowId','webContentsId','pid','creationTime','browserPid','browserCreationTime'])||
    !integer(v.windowId,1)||!integer(v.webContentsId,1)||!pid(v.pid)||!pid(v.browserPid)||
    v.pid===v.browserPid||!positive(v.creationTime)||!positive(v.browserCreationTime))
    deny('Invalid actual native identity')
  return v
}
function validMetrics(metrics,id) {
  validIdentity(id)
  if(!Array.isArray(metrics)||metrics.length!==2)deny('Incomplete/unknown native topology')
  for(const [type,p,creation] of [['Browser',id.browserPid,id.browserCreationTime],['Tab',id.pid,id.creationTime]]) {
    const m=metrics.find(m=>m?.type===type)
    if(!keys(m,['cpu','pid','type','creationTime','memory','sandboxed'])||m.pid!==p||
      m.creationTime!==creation||m.sandboxed!==true||
      !keys(m.cpu,['cumulativeCPUUsage','percentCPUUsage','idleWakeupsPerSecond'])||
      !Object.values(m.cpu).every(v=>Number.isFinite(v)&&v>=0)||
      !keys(m.memory,['workingSetSize','peakWorkingSetSize'])||
      !Object.values(m.memory).every(v=>integer(v))||m.memory.peakWorkingSetSize<m.memory.workingSetSize)
      deny('Malformed/unbound native metrics')
  }
  return metrics
}
function validReceipts(receipts,id) {
  if(!Array.isArray(receipts)||!receipts.length||receipts.length>64)deny('Missing genuine bridge receipts')
  for(const r of receipts) {
    const {channel,topFrame,ok,revision,...binding}=r||{}
    if(!keys(r,['channel','topFrame','ok','revision',...Object.keys(id)])||channel!=='hd:changes:list'||
      topFrame!==true||ok!==true||!integer(revision)||!same(binding,id))deny('Malformed/unbound genuine bridge receipt')
  }
}
const MACH=['com.apple.SecurityServer','com.apple.tccd','com.apple.tccd.system','com.apple.pasteboard.1',
  'com.apple.coreservices.launchservicesd','com.github.Electron.MachPortRendezvousServer.unrelated']
const OPS=['file-read-data','file-write-data','file-write-unlink','file-write-create']
const GENERIC=['network-outbound','network-inbound','network-bind','appleevent-send','process-fork']
const RENDEZVOUS=['registerBrowser','registerUnrelated','lookupBrowser','lookupUnrelated']
const result=v=>keys(v,['rc','errno'])&&[0,1].includes(v.rc)&&v.errno===0
const denied=v=>result(v)&&v.rc===1
const NATIVE_ALIASES=['clipboard','capture','sessionProxy','sessionProtocol','sessionCookie','dialogOpen','dialogSave',
  'openExternal','spawn','tray','notification','updater','nativePlugin']
const SURFACE_LABELS=[
  'window.alert','window.confirm','window.prompt','window.print','window.open',
  'window.showOpenFilePicker','window.showSaveFilePicker','window.showDirectoryPicker',
  'clipboard.read','clipboard.readText','clipboard.write','clipboard.writeText',
  'media.getUserMedia','media.getDisplayMedia','media.enumerateDevices','wake.request',
  'credentials.get','credentials.create','credentials.store','credentials.preventSilentAccess','permissions.query',
  'WebAuthn.isUserVerifyingPlatformAuthenticatorAvailable','WebAuthn.isConditionalMediationAvailable','WebAuthn.getClientCapabilities',
  'documentPiP.requestWindow','video.PiP','document.exitPiP','input.file-color-and-select.click','input.showPicker',
  'select.showPicker','input.pointer-keyboard-default-action',
  'parser.createElement','parser.createElementNS','parser.innerHTML','parser.outerHTML','parser.shadow.innerHTML',
  'parser.insertAdjacentHTML','parser.setHTML','parser.setHTMLUnsafe','parser.shadow.setHTML','parser.shadow.setHTMLUnsafe',
  'parser.write','parser.writeln','parser.parseFromString','parser.createContextualFragment',
  ...['appendChild','insertBefore','replaceChild'].map(k=>'insert.node.'+k),
  ...['append','prepend','before','after','replaceWith','replaceChildren','insertAdjacentElement'].map(k=>'insert.element.'+k),
  ...['append','prepend','replaceChildren','adoptNode','importNode'].map(k=>'insert.document.'+k),
  ...['append','prepend','replaceChildren'].map(k=>'insert.fragment.'+k),
  'insert.range.insertNode','insert.range.surroundContents',
]
function validKernel(v,executable,expectedPid,paths,role) {
  if(!Array.isArray(paths)||!['browser','renderer'].includes(role)||!paths.every(canonical)||
    !keys(v,['pid','ppid','startSec','startUsec','executable','privateSocket','sockets','paths','mach','generic','rendezvous'])||
    !pid(v.pid)||v.pid!==expectedPid||!integer(v.ppid,0,2147483647)||!canonical(v.executable)||v.executable!==executable||
    !integer(v.startSec,1)||!integer(v.startUsec,0,999999)||
    typeof v.privateSocket!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(v.privateSocket)||
    !Array.isArray(v.sockets)||v.sockets.length>1024||new Set(v.sockets).size!==v.sockets.length||
    !v.sockets.every(s=>typeof s==='string'&&/^[1-9][0-9]{0,19}$/.test(s))||
    !Array.isArray(v.paths)||v.paths.length!==paths.length||
    !keys(v.mach,MACH)||!keys(v.generic,GENERIC)||!keys(v.rendezvous,RENDEZVOUS)||
    ![...Object.values(v.mach),...Object.values(v.generic),...Object.values(v.rendezvous)].every(result))
    deny('Invalid live kernel/process/path identity')
  for(const [i,f] of v.paths.entries()) {
    if(!keys(f,['pathDigest',...OPS])||f.pathDigest!==tree.sha(paths[i])||!OPS.every(op=>result(f[op]))||
      !OPS.slice(1).every(op=>denied(f[op])))deny('Unknown/partial/reordered graph kernel evidence')
  }
  if(!GENERIC.slice(0,4).every(op=>denied(v.generic[op]))||
    v.generic['process-fork'].rc!==(role==='browser'?0:1)||
    !MACH.every(name=>v.mach[name].rc===(role==='browser'&&name==='com.apple.coreservices.launchservicesd'?0:1))||
    !RENDEZVOUS.every(name=>v.rendezvous[name].rc===(
      role==='browser'&&name==='registerBrowser'||role==='renderer'&&name==='lookupBrowser'?0:1)))
    deny('Unknown/allowed kernel authority')
  if(role==='browser'?(v.privateSocket==='0'||!v.sockets.includes(v.privateSocket)):v.privateSocket!=='0')
    deny('Invalid private outcome socket provenance')
  return v
}
function validPreflight(v,{browserPid,preload,preloadSha256}) {
  if(!keys(v,['identity','preferences','metrics','guards','receipts','surfaceEvidence']))deny('Incomplete genuine preflight')
  const id=validIdentity(v.identity),p=v.preferences
  if(id.browserPid!==browserPid||!keys(p,['sandbox','contextIsolation','nodeIntegration','disableDialogs','preload','preloadSha256','preloadProvenance'])||
    p.sandbox!==true||p.contextIsolation!==true||p.nodeIntegration!==false||p.disableDialogs!==true||
    !canonical(p.preload)||p.preload!==preload||!hex(p.preloadSha256)||p.preloadSha256!==preloadSha256||
    p.preloadProvenance!=='actual-genuine-constructor-and-passive-bridge'||
    !Array.isArray(v.guards)||v.guards.length>512||!v.guards.every(g=>typeof g==='string'&&g.length>0&&g.length<160)||
    !['constructor:BrowserWindow','constructor:Notification','constructor:Tray','constructor:WebContentsView',
      'file-chooser:intercept-installed','document-start:native-surface-guard-observed'].every(g=>v.guards.includes(g)))
    deny('Missing/unsafe protected preload or guard provenance')
  validMetrics(v.metrics,id);validReceipts(v.receipts,id)
  const e=v.surfaceEvidence
  if(!keys(e,['source','runtimeVersion','surface','nativeAliases','barrier','inventoryDigest','permissionEvidence'])||e.source!=='fixed-trusted-inert-main-before-release'||
    e.runtimeVersion!=='37.10.3'||
    !keys(e.surface,['prototypePoison','subframe','subframeParser','fsa','clipboardRead','clipboardWrite','capture','media','mediaEnumeration','wake'])||
    !keys(e.nativeAliases,NATIVE_ALIASES)||
    ![...Object.values(e.surface),...Object.values(e.nativeAliases)].every(v=>v===true))
    deny('Missing/partial fixed trusted native surface inventory')
  if(!keys(e.permissionEvidence,['requestDenied','checkDenied','deviceDenied','displayDenied'])||
    !Object.values(e.permissionEvidence).every(v=>v===true))deny('Installed session permission policy proof missing')
  const b=e.barrier
  if(!keys(b,['inventory','results','controls'])||!Array.isArray(b.inventory)||b.inventory.length>256||
    !Array.isArray(b.results)||b.results.length>512||!Array.isArray(b.controls)||b.controls.length!==4||
    !b.controls.every(v=>v===true)||e.inventoryDigest!==tree.sha(JSON.stringify(b.inventory))||
    new Set(b.inventory.map(r=>r.label)).size!==b.inventory.length||
    !b.inventory.every(r=>keys(r,['label','state'])&&typeof r.label==='string'&&r.label.length<160&&
      ['guarded','absent','absent-locked'].includes(r.state))||
    !SURFACE_LABELS.every(label=>b.inventory.some(r=>r.label===label))||
    !b.results.every(r=>keys(r,['label','state','route','outcome','denials'])&&typeof r.route==='string'&&
      r.route.length<160&&integer(r.denials,0,16)&&
      ['unavailable','denied-before-effect','native-brand-rejected','default-prevented-before-effect'].includes(r.outcome))||
    !b.inventory.filter(r=>!['input.file-color-and-select.click','input.pointer-keyboard-default-action'].includes(r.label))
      .every(r=>b.results.some(v=>v.label===r.label&&v.state===r.state&&
        (r.state==='absent'?v.outcome==='unavailable'&&v.denials===0:
          v.outcome==='denied-before-effect'&&v.denials===1)))||
    !['file','color','select'].every(kind=>['click','pointerdown','mousedown','dblclick','keydown','keyup','beforeinput'].every(
      event=>b.results.some(r=>r.label==='input.'+kind+'.'+event&&r.state==='guarded'&&r.denials>=1))))
    deny('Incomplete/forged before-effect surface or ordinary-DOM controls')
  return v
}
function exactObservation(v,{identity,manifest}={}) {
  if(!keys(v,['value','identity','assets','blocked','receipts','metrics'])||
    !keys(v.value,['complete','root','nodeAbsent'])||Object.values(v.value).some(x=>x!==true))
    deny('Unknown/truthy/counterfeit native observation')
  validIdentity(v.identity)
  if(!identity||!same(v.identity,identity)||!Array.isArray(manifest)||!manifest.length||
    !Array.isArray(v.assets)||!v.assets.length||v.assets.length>128||
    !Array.isArray(v.blocked)||!v.blocked.length||v.blocked.length>512||
    !v.blocked.every(s=>typeof s==='string'&&s.length>0&&s.length<256))deny('Unbound observation context')
  for(const a of v.assets) {
    const indexed=manifest.find(f=>f.path===a?.path)
    if(!keys(a,['path','sha256','size','pid','creationTime','windowId','webContentsId'])||
      typeof a.path!=='string'||a.path.startsWith('/')||a.path.split('/').some(p=>!p||p==='.'||p==='..')||
      /[%\\\0\r\n]/.test(a.path)||!indexed||!hex(a.sha256)||a.sha256!==indexed.sha256||
      !integer(a.size)||a.size!==indexed.size||a.pid!==identity.pid||a.creationTime!==identity.creationTime||
      a.windowId!==identity.windowId||a.webContentsId!==identity.webContentsId)deny('Unbound indexed broker bytes')
  }
  if(!manifest.every(f=>v.assets.some(a=>a.path===f.path)))deny('Incomplete actual asset consumption')
  validReceipts(v.receipts,identity);validMetrics(v.metrics,identity)
  return v
}
const QKEYS=['version','nonce','artifactDigest','policy','nativeWindow','protectedPreload','fixedBridge','rendererReady',
  'healthSamples','kernelDenials','fullAppQualified','scope','sourceDigest','rendererDigest','hostDigest','hostIdentity','runtime',
  'dependencyDigest','observationDigest','job','boundDigest','inputDigest','sourceIdentityDigest','policyDigest','guardDigest',
  'entryDigest','identity','preload','metrics','privateChannel','kernelEvidence']
function validateQualification(q) {
  if(!keys(q,QKEYS)||q.version!==VERSION||q.policy!==POLICY||!uuid(q.nonce)||
    !['artifactDigest','sourceDigest','rendererDigest','hostDigest','dependencyDigest','observationDigest','boundDigest',
      'inputDigest','sourceIdentityDigest','policyDigest','guardDigest','entryDigest'].every(k=>hex(q[k]))||
    q.scope!=='trusted-host-renderer-only'||q.fullAppQualified!==false||
    !['nativeWindow','protectedPreload','fixedBridge','rendererReady'].every(k=>q[k]===true)||
    !integer(q.healthSamples,3,64)||!canonical(q.job)||
    !keys(q.kernelDenials,['read','write','sourceWrite','fork','network'])||!Object.values(q.kernelDenials).every(x=>x===true))
    deny('Current native receipt contract required; legacy proof has no authority')
  const id=validIdentity(q.identity),rt=q.runtime,h=q.hostIdentity
  if(!keys(rt,['relativePath','sha256','pid','creationTime','executable','rendererExecutable','rendererSha256'])||
    rt.relativePath!=='electron/dist/Electron.app/Contents/MacOS/Electron'||!hex(rt.sha256)||!hex(rt.rendererSha256)||
    rt.pid!==id.browserPid||rt.creationTime!==id.browserCreationTime||
    rt.executable!==path.join(q.job,'app/node_modules',rt.relativePath)||
    rt.rendererExecutable!==path.join(q.job,'app/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)')||
    !keys(h,['codeDigest','version','origin'])||h.codeDigest!==q.hostDigest||typeof h.version!=='string'||!h.version||h.version.length>128||
    !keys(h.origin,['kind','path','archiveSha256'])||!canonical(h.origin.path)||!['directory','asar'].includes(h.origin.kind)||
    (h.origin.kind==='asar'?!hex(h.origin.archiveSha256):h.origin.archiveSha256!==null))deny('Incomplete copied host/runtime binding')
  const p=q.preload
  if(!keys(p,['path','sha256','provenance'])||p.path!==path.join(q.job,'app/electron/preload.cjs')||!hex(p.sha256)||
    p.provenance!=='actual-genuine-constructor-and-passive-bridge')deny('Missing protected preload proof')
  validMetrics(q.metrics,id)
  const pc=q.privateChannel
  if(!keys(pc,['version','kind','nonce','artifactDigest','identity','rendererInherited','observationDigest'])||
    pc.version!==1||pc.kind!=='cloexec-private-fd-v1'||pc.nonce!==q.nonce||pc.artifactDigest!==q.artifactDigest||
    !same(pc.identity,id)||pc.rendererInherited!==false||pc.observationDigest!==q.observationDigest)deny('Missing bound private channel proof')
  const k=q.kernelEvidence
  if(!keys(k,['browser','renderer','paths'])||!Array.isArray(k.paths)||!k.paths.length)deny('Missing native kernel proof')
  validKernel(k.browser,rt.executable,id.browserPid,k.paths,'browser')
  validKernel(k.renderer,rt.rendererExecutable,id.pid,k.paths,'renderer')
  for(const [v,time] of [[k.browser,id.browserCreationTime],[k.renderer,id.creationTime]])
    if(Math.round(time*1000)!==v.startSec*1000000+v.startUsec)deny('Kernel/native process creation differs')
  if(k.renderer.ppid!==id.browserPid||k.renderer.sockets.includes(k.browser.privateSocket)||
    !k.paths.every((_,i)=>denied(k.browser.paths[i]['file-read-data'])&&denied(k.renderer.paths[i]['file-read-data'])))
    deny('Protected path/private channel denial missing')
  return q
}
function assertAuthority(q) {
  if(!phase2Available())deny('Phase 2 authority is not released; historical records are read-only')
  return validateQualification(q)
}
function validateStartup(result,{qualification,nonce,artifactDigest,consumer,job}) {
  const {consumer:bound,...q}=result||{}
  validateQualification(q);validateQualification(qualification)
  if(q.job!==job||q.nonce!==nonce||q.artifactDigest!==artifactDigest||
    !keys(consumer,['targetId','versionId','nonce','artifactDigest','rendererDigest'])||
    ![consumer.targetId,consumer.versionId,consumer.nonce].every(uuid)||
    consumer.nonce!==nonce||consumer.artifactDigest!==artifactDigest||consumer.rendererDigest!==q.rendererDigest||
    !same(bound,consumer)||
    !['sourceDigest','rendererDigest','hostDigest','dependencyDigest','boundDigest','inputDigest','sourceIdentityDigest',
      'policyDigest','guardDigest'].every(k=>q[k]===qualification[k])||
    q.hostIdentity.version!==qualification.hostIdentity.version||q.runtime.sha256!==qualification.runtime.sha256||
    q.runtime.relativePath!==qualification.runtime.relativePath||q.runtime.rendererSha256!==qualification.runtime.rendererSha256||
    q.preload.sha256!==qualification.preload.sha256)deny('Versioned native startup/bridge health acknowledgment mismatch')
  return result
}
module.exports={POLICY,VERSION,NATIVE_ALIASES,SURFACE_LABELS,hex,canonical,validIdentity,validMetrics,validReceipts,validKernel,validPreflight,
  exactObservation,denied,validateQualification,validateStartup,phase2Available,assertAuthority}
