'use strict'
// ONLY fixed trusted bootstrap + fixed negative HTML/JS. No source/renderer/
// script/policy overrides and no generated-candidate qualification or grants.
const fs=require('node:fs'),path=require('node:path')
const {spawn,execFileSync}=require('node:child_process')
const {randomUUID}=require('node:crypto')
const tree=require('./self-modification-artifact.cjs'),seals=require('./self-modification-seal.cjs')
const trusted=require('./self-modification-host.cjs'),runtime=require('./self-modification-native-runtime.cjs')
const {policy}=require('./self-modification-native-policy.cjs')
const {keys}=require('./self-modification-schema.cjs')
const VERSION='native-fixed-phase1-v1'
const FLAGS=['--in-process-gpu','--enable-features=NetworkServiceInProcess2','--disable-gpu',
  '--disable-background-networking','--disable-component-update','--disable-breakpad',
  '--disable-domain-reliability','--disable-sync','--no-first-run',
  '--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication']
const HTML=Buffer.from('<!doctype html><meta charset="utf-8"><title>FIXED TRUSTED PHASE 1</title><div id="root">FIXED TRUSTED NEGATIVE TEST</div><script src="negative.js"></script>')
const NEGATIVE=Buffer.from(`
'use strict'
// Immutable synthetic negative tests only, not generated model output.
Document.prototype.querySelector=()=>null
Object.defineProperty(Document.prototype,'readyState',{get:()=> 'counterfeit'})
console.log('HD_NATIVE_RESULT:{"nativeWindow":true,"fixedBridge":true,"fullAppQualified":true}')
const id='11111111-1111-4111-8111-111111111111'
const a=window.nubAgent
const calls=[
 ()=>a.changes.create(1,{request:'Owned synthetic negative',acceptanceCriteria:'No effects'}),
 ()=>a.changes.prepare(1,id,id,{selectionId:id,baseline:'head'}),
 ()=>a.changes.qualify(1,id,id),()=>a.changes.approve(1,id,id,'a'.repeat(64),'b'.repeat(64)),
 ()=>a.changes.activate(1,id,id,'a'.repeat(64)),()=>a.host.restartServe(),()=>a.host.setConfig({}),
 ()=>a.host.revokeOrigin('https://example.invalid'),()=>a.host.setProfileSoul('synthetic','never written'),
 ()=>a.roomJournal.save(0,{version:1,rooms:[]}),
 ()=>a.workspace.stopAll(),()=>a.workspace.openTab('synthetic','https://example.invalid'),
 ()=>a.openExternal('https://example.invalid'),()=>a.clipboard.writeText('OWNED SYNTHETIC NEVER WRITTEN'),
 ()=>a.localFiles.pickMedia(),()=>a.localFiles.saveAs('/private/tmp/OWNED-NOT-READ'),
 ()=>a.computer.open('synthetic'),()=>a.plugins.readDir('/private/tmp/OWNED-NOT-READ'),
 ()=>a.task(['list']),()=>a.secretsCopy('op://OWNED-SYNTHETIC/item/value')
]
for(const call of calls)try{Promise.resolve(call()).catch(()=>{})}catch{}
for(const url of ['file:///private/tmp/never-read','https://example.invalid/','hd-native://sealed/entry.cjs','hd-native://sealed/../entry.cjs'])
  fetch(url).catch(()=>{})
try{window.open('https://example.invalid/')}catch{}
try{alert('No native JS dialog')}catch{}
window.nubAgent.changes.list().catch(()=>{})
`)
let slots=0
const {exactObservation,validKernel,validPreflight,denied}=require('./self-modification-native-contract.cjs')
const {lifecycle}=require('./self-modification-native-lifecycle.cjs')
function entry({appRoot,control,renderer,manifest,preload,channels,executable,hash,nonce,digest}) {
  return `'use strict'
const fs=require('node:fs'),crypto=require('node:crypto'),net=require('node:net')
const {app}=require('electron')
process.on('uncaughtException',error=>{console.error('FIXED_BOOTSTRAP_FAILURE',error.stack);app.exit(86)})
process.on('unhandledRejection',error=>{console.error('FIXED_BOOTSTRAP_REJECTION',String(error));app.exit(87)})
if(fs.realpathSync(process.execPath)!==${JSON.stringify(executable)}||
 crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex')!==${JSON.stringify(hash)})throw Error('Copied runtime identity mismatch')
if(require(${JSON.stringify(path.join(control,'private-fd.node'))}).securePrivateFd()!==true)throw Error('Private fd guard missing')
const channel=new net.Socket({fd:3,readable:true,writable:true})
const send=message=>channel.write(JSON.stringify({version:1,nonce:${JSON.stringify(nonce)},digest:${JSON.stringify(digest)},...message})+'\\n')
for(const name of ['userData','appData','sessionData','logs','crashDumps'])app.setPath(name,${JSON.stringify(path.join(path.dirname(control),'home'))}+'/'+name)
const mode=require(${JSON.stringify(path.join(appRoot,'electron/self-modification-native-mode.cjs'))}).install({
 renderer:${JSON.stringify(renderer)},manifest:${JSON.stringify(manifest)},preload:${JSON.stringify(preload)},channels:${JSON.stringify(channels)},send})
require(${JSON.stringify(path.join(appRoot,'electron/main.cjs'))})
mode.finalizeIpc()
let buffer='',busy=false,count=0
channel.on('data',chunk=>{
 buffer+=chunk.toString();if(buffer.length>65536){app.exit(82);return}
 while(buffer.includes('\\n')){
  const index=buffer.indexOf('\\n'),line=buffer.slice(0,index);buffer=buffer.slice(index+1)
  const message=JSON.parse(line)
  if(busy||++count>8||message.nonce!==${JSON.stringify(nonce)}||!['preflight','release','observe','stop'].includes(message.type)){app.exit(83);return}
  busy=true
  Promise.resolve().then(async()=>{
   if(message.type==='preflight')send({type:'preflight',value:await mode.preflight()})
   if(message.type==='release'){await mode.release(message.identity);send({type:'released'})}
   if(message.type==='observe')send({type:'observation',value:await mode.observe()})
   if(message.type==='stop')mode.stop()
  }).catch(error=>{send({type:'fatal',message:error.message});app.exit(84)}).finally(()=>busy=false)
 }
})
setTimeout(()=>app.exit(85),60000).unref()
setTimeout(()=>send({type:'ready'}),1500)
`
}
async function run({job,signal=new AbortController().signal}={}) {
  if(slots||process.platform!=='darwin'||process.arch!=='arm64')throw Error('One owned macOS arm64 Phase 1 slot required')
  if(!job||!path.isAbsolute(job)||fs.existsSync(job))throw Error('Fresh explicit owned Phase 1 job required')
  slots++
  const report={scope:'frontend-only-v1',phase:'fixed-trusted-phase1-only',nativeQualification:false,artifactApproved:false,
    fullAppQualified:false,activationEligible:false,phase2Released:false,generatedExecuted:false,job,checks:[],failure:null}
  let child,monitor,life,ownedBrowserExecutable
  const owned=new Map()
  try {
    fs.mkdirSync(job,{mode:0o700})
    if(fs.realpathSync(job)!==job)throw Error('Canonical phase1 root required')
    const rootStat=tree.directory(job),started=Date.now()
    const check=()=>{if(signal.aborted||Date.now()-started>300000||!tree.same(rootStat,tree.directory(job)))throw Error('Phase1 cancelled/deadline/root replaced')}
    const control=path.join(job,'control'),home=path.join(job,'home'),tmp=path.join(job,'tmp')
    for(const dir of [control,home,tmp])fs.mkdirSync(dir,{mode:0o700})
    for(const dir of ['userData','appData','sessionData','logs','crashDumps'])fs.mkdirSync(path.join(home,dir),{mode:0o700})
    const controller=require('./self-modification.cjs').createChangeController(path.join(home,'userData'))
    const synthetic=controller.create(0,{request:'Owned fixed Phase1 synthetic state',acceptanceCriteria:'Passive receipt only; no candidate'})
    if(!synthetic.ok)throw Error('Could not initialize owned synthetic journal')
    const selected=synthetic.changes[0],pending=controller.beginPreparation(1,selected.id,selected.attempts[0].id,{
      operationId:randomUUID(),ownerPid:9999999,source:{root:job,dev:rootStat.dev,ino:rootStat.ino,
        gitDev:rootStat.dev,gitIno:rootStat.ino,head:'a'.repeat(40),statusDigest:'b'.repeat(64),dirtyEntries:0,kind:'head',dirtyExcluded:true},
      workspace:{id:randomUUID(),token:randomUUID(),dev:null,ino:null},manifestDigest:null,fileCount:null,error:null})
    if(!pending.ok)throw Error('Could not create owned interrupted synthetic preparation')
    const journal=path.join(home,'userData/self-modification/changes.json'),journalBytes=tree.readFile(journal).bytes
    const host=await trusted.inspect(__dirname,check)
    const appRoot=path.join(job,'app');fs.mkdirSync(appRoot,{mode:0o700})
    tree.materialize(path.join(appRoot,'electron'),host.files)
    fs.writeFileSync(path.join(appRoot,'package.json'),host.packageBytes,{flag:'wx',mode:0o600})
    const renderer=path.join(appRoot,'dist')
    tree.materialize(renderer,[{path:'index.html',bytes:HTML,mode:0o600},{path:'negative.js',bytes:NEGATIVE,mode:0o600}])
    const assets=await tree.capture(renderer)
    const copied=await runtime.copy(path.join(__dirname,'../node_modules'),path.join(appRoot,'node_modules'),{check})
    ownedBrowserExecutable=copied.executable
    const electronRoot=path.resolve(copied.executable,'../../..')
    const probe=path.join(control,'observe'),addon=path.join(control,'private-fd.node')
    execFileSync('/usr/bin/clang',['-O2',path.join(appRoot,'electron/self-modification-native-probe.c'),'-o',probe,'-lproc'],
      {timeout:30000,maxBuffer:65536})
    execFileSync('/usr/bin/clang',['-O2','-bundle','-undefined','dynamic_lookup','-I/opt/homebrew/include/node',
      path.join(appRoot,'electron/self-modification-native-fd.c'),'-o',addon],{timeout:30000,maxBuffer:65536})
    const sentinel=path.join(job,'protected.txt');fs.writeFileSync(sentinel,'OWNED FIXED PROTECTED SENTINEL',{flag:'wx',mode:0o600})
    const homeSentinel=path.join(home,'ordinary-owned-private.txt');fs.writeFileSync(homeSentinel,'OWNED FIXED ORDINARY HOME SENTINEL',{flag:'wx',mode:0o600})
    const graphPaths=[...host.files.map(f=>path.join(appRoot,'electron',f.path)),
      ...copied.snapshot.manifest.map(f=>path.join(appRoot,'node_modules',f.path))]
    const p=policy(job,electronRoot,copied.executable)
    const policyPath=path.join(control,'policy.sb');fs.writeFileSync(policyPath,p,{flag:'wx',mode:0o600})
    const nonce=randomUUID(),digest=tree.sha(JSON.stringify({version:VERSION,host:host.identity,assets:assets.digest,
      runtime:copied.snapshot.digest,policy:tree.sha(p)}))
    const entryPath=path.join(control,'entry.cjs')
    const channels=[...tree.readFile(path.join(appRoot,'electron/preload.cjs')).bytes.toString()
      .matchAll(/ipcRenderer\.(invoke|sendSync|send)\('([^']+)'/g)].map(m=>[m[1],m[2]])
    fs.writeFileSync(entryPath,entry({appRoot,control,renderer,manifest:assets.manifest,channels,preload:path.join(appRoot,'electron/preload.cjs'),
      executable:copied.executable,hash:copied.runtimeSha256,nonce,digest}),{flag:'wx',mode:0o600})
    const controlCapture=await seals.capture(control),hostCapture=await seals.capture(path.join(appRoot,'electron'))
    graphPaths.push(...controlCapture.manifest.map(f=>path.join(control,f.path)))
    const controlIdentity=seals.identity(control),hostIdentity=seals.identity(path.join(appRoot,'electron'))
    const fence=()=>{
      check();copied.fence()
      if(seals.identity(control)!==controlIdentity||seals.identity(path.join(appRoot,'electron'))!==hostIdentity)
        throw Error('Entry/policy/observer/host graph identity changed')
    }
    report.digests={source:host.identity.codeDigest,hostVersion:host.identity.version,runtime:copied.snapshot.digest,
      renderer:assets.digest,policy:tree.sha(p),guards:tree.sha(tree.readFile(path.join(appRoot,'electron/self-modification-native-mode.cjs')).bytes),
      probeSource:tree.sha(tree.readFile(path.join(appRoot,'electron/self-modification-native-probe.c')).bytes),
      observer:tree.sha(tree.readFile(probe).bytes),privateFd:tree.sha(tree.readFile(addon).bytes),entry:tree.sha(tree.readFile(entryPath).bytes),
      controlGraph:controlCapture.digest,hostGraph:hostCapture.digest,artifact:digest}
    const self=JSON.parse(execFileSync(probe,['--self',policyPath,sentinel,path.join(appRoot,'electron/main.cjs')],
      {encoding:'utf8',timeout:10000,maxBuffer:65536,env:{HOME:home,TMPDIR:tmp,PATH:'/usr/bin:/bin'}}))
    report.actualSelfProbe=self
    for(const name of ['read','write','graphWrite','network'])if(self[name]?.rc!==-1||![1,13].includes(self[name].errno))throw Error('Actual self denial missing:'+name)
    if(self.spawnErrno!==1)throw Error('Actual fixed true spawn was not EPERM')
    fence()
    const argv=['-f',policyPath,copied.executable,...FLAGS,entryPath]
    report.launch={argv,env:{HOME:home,TMPDIR:tmp,PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},nonce,digest}
    child=spawn(probe,['--launch',policyPath,copied.executable,entryPath],{cwd:job,env:{...report.launch.env,HERMES_DESK_E2E_BACKGROUND:'1',HERMES_DISABLE_LAZY_INSTALLS:'1'},
      detached:true,stdio:['ignore','pipe','pipe','pipe']})
    report.launch.pid=child.pid
    report.launch.launcher={path:probe,sha256:report.digests.observer,args:['--launch',policyPath,copied.executable,entryPath]}
    report.launch.argv=['-D','BROWSER_PID='+child.pid,...argv]
    const stderr=[],stdout=[]
    let bytes=0,privateBuffer='',privateBytes=0,rejectWait,resolveWait,expectedType,closed=false,monitorError=null
    const messages=[]
    life=lifecycle(signal)
    function reject(error){life.fail(error);monitorError=life.failure;rejectWait?.(monitorError)}
    let closeResolve
    const closePromise=new Promise(resolve=>closeResolve=resolve)
    for(const [stream,records] of [[child.stdout,stdout],[child.stderr,stderr]])stream.on('data',chunk=>{
      bytes+=chunk.length;if(bytes>128*1024){reject(Error('Native output bound'));return}records.push(chunk.toString())
      report.stdout=stdout.join('');report.stderr=stderr.join('')
    })
    child.on('error',reject)
    child.on('close',(code,signalName)=>{closed=true;report.exit={code,signal:signalName};closeResolve(report.exit);if(expectedType)reject(Error('Owned native child exited before private acknowledgment'))})
    child.stdio[3].on('data',chunk=>{
      privateBytes+=chunk.length;privateBuffer+=chunk.toString()
      if(privateBytes>1024*1024||privateBuffer.length>256*1024){reject(Error('Private channel bound'));return}
      while(privateBuffer.includes('\n')) {
        const i=privateBuffer.indexOf('\n'),line=privateBuffer.slice(0,i);privateBuffer=privateBuffer.slice(i+1)
        try {
          const m=JSON.parse(line),extra=m.type==='fatal'?['message']:['preflight','observation'].includes(m.type)?['value']:[]
          if(!keys(m,['version','nonce','digest','type',...extra])||m.version!==1||m.nonce!==nonce||m.digest!==digest)
            throw Error('Unknown/replayed private observation')
          if(m.type==='fatal')throw Error('Native guard fatal: '+m.message)
          if(m.type!==expectedType)throw Error('Unexpected private-channel phase')
          messages.push(m);const fn=resolveWait;expectedType=null;resolveWait=null;rejectWait=null;fn?.(m)
        }catch(error){reject(error)}
      }
    })
    function wait(type,command) {
      if(monitorError)return Promise.reject(monitorError)
      if(closed)return Promise.reject(Error('Native child already closed'))
      expectedType=type
      return life.race(new Promise((resolve,reject)=>{resolveWait=resolve;rejectWait=reject;
        if(command)child.stdio[3].write(JSON.stringify({nonce,...command})+'\n')}))
    }
    function inspect(pid,paths=[]) {
      return JSON.parse(execFileSync(probe,['--observe',String(pid),String(child.pid),...paths],{encoding:'utf8',timeout:3000,maxBuffer:1024*1024}))
    }
    let browserKernel,rendererKernel
    let initial
    report.launcherObservations=[]
    // exec-launch briefly passes through the system sandbox trampoline. Never
    // grant cleanup ownership to that unverified image: boundedly wait for the
    // sealed probe/copied Browser, with the SAME kernel creation identity.
    for(let i=0;i<20;i++) {
      life.check()
      const observed=inspect(child.pid)
      if(observed.pid!==child.pid||!Number.isSafeInteger(observed.startSec)||observed.startSec<1||
        !Number.isSafeInteger(observed.startUsec)||observed.startUsec<0||observed.startUsec>999999||
        initial&&(observed.startSec!==initial.startSec||observed.startUsec!==initial.startUsec))
        throw Error('Unknown/rotated owned launcher identity')
      initial=observed
      report.launcherObservations.push({pid:observed.pid,executable:observed.executable,
        startSec:observed.startSec,startUsec:observed.startUsec})
      if([probe,copied.executable].includes(observed.executable)){owned.set(child.pid,observed);break}
      await life.race(new Promise(resolve=>setTimeout(resolve,10)))
    }
    if(!owned.has(child.pid))throw Error('Unknown owned launcher image retained after bounded observation')
    await wait('ready')
    const preflight=(await wait('preflight',{type:'preflight'})).value
    validPreflight(preflight,{browserPid:child.pid,preload:path.join(appRoot,'electron/preload.cjs'),
      preloadSha256:tree.sha(tree.readFile(path.join(appRoot,'electron/preload.cjs')).bytes)})
    const id=preflight.identity
    browserKernel=validKernel(inspect(child.pid,[sentinel,entryPath,policyPath]),copied.executable,child.pid,[sentinel,entryPath,policyPath],'browser')
    rendererKernel=validKernel(inspect(id.pid,[sentinel,entryPath,policyPath,homeSentinel]),copied.renderer,id.pid,[sentinel,entryPath,policyPath,homeSentinel],'renderer')
    for(const [kernel,creation] of [[browserKernel,id.browserCreationTime],[rendererKernel,id.creationTime]]) {
      if(!Number.isFinite(creation)||Math.round(creation*1000)!==kernel.startSec*1000000+kernel.startUsec)
        throw Error('Actual kernel/Electron process creation binding differs')
    }
    owned.set(child.pid,browserKernel);owned.set(id.pid,rendererKernel)
    // Policy queries ONLY: never stat/open/read original userData or contents.
    // Only opaque digests/labels enter evidence, not private path names.
    const originalHome=require('node:os').homedir()
    const outsidePaths=[path.join(originalHome,'Library/Application Support/Hermes Desk'),
      path.join(originalHome,'Library/Application Support/hermes-desk'),path.resolve(__dirname,'..')]
    const outsideBrowser=validKernel(inspect(child.pid,outsidePaths),copied.executable,child.pid,outsidePaths,'browser')
    const outsideRenderer=validKernel(inspect(id.pid,outsidePaths),copied.renderer,id.pid,outsidePaths,'renderer')
    if(!outsideBrowser.paths.every(v=>denied(v['file-read-data']))||!outsideRenderer.paths.every(v=>denied(v['file-read-data'])))
      throw Error('Original userData/source policy query not denied')
    report.originalAuthorityQueries={kind:'kernel-policy-only-no-content-access',
      browser:outsideBrowser.paths,renderer:outsideRenderer.paths}
    const actualRendererCommand=execFileSync('/bin/ps',['-p',String(id.pid),'-o','command='],
      {encoding:'utf8',timeout:2000,maxBuffer:65536}).trim()
    if(!actualRendererCommand.startsWith(copied.renderer+' '))throw Error('Actual renderer command executable differs')
    const actualRendererArguments=actualRendererCommand.slice(copied.renderer.length+1).split(/\s+/)
    if(!actualRendererArguments.includes('--type=renderer')||!actualRendererArguments.includes('--enable-sandbox')||
      !actualRendererArguments.some(arg=>/^--seatbelt-client=[1-9][0-9]*$/.test(arg))||
      actualRendererArguments.some(arg=>/^--(?:no-sandbox|disable-sandbox|disable-setuid-sandbox|disable-gpu-sandbox)(?:=|$)/.test(arg)))
      throw Error('Actual renderer Chromium routing switches invalid:'+actualRendererCommand)
    const afterCommand=inspect(id.pid)
    if(afterCommand.startSec!==rendererKernel.startSec||afterCommand.startUsec!==rendererKernel.startUsec)
      throw Error('Renderer identity rotated during external command observation')
    report.actualRendererCommand=actualRendererCommand
    if(rendererKernel.ppid!==child.pid||!denied(rendererKernel.generic['process-fork'])||
      !denied(rendererKernel.mach['com.apple.coreservices.launchservicesd']))throw Error('Renderer native routing authority invalid')
    if(!browserKernel.privateSocket||browserKernel.privateSocket==='0'||rendererKernel.sockets.includes(browserKernel.privateSocket))
      throw Error('Private outcome channel inherited by renderer')
    if(!denied(browserKernel.rendezvous.registerUnrelated)||browserKernel.rendezvous.registerBrowser.rc!==0||
      !denied(rendererKernel.rendezvous.registerBrowser)||!denied(rendererKernel.rendezvous.lookupUnrelated)||
      rendererKernel.rendezvous.lookupBrowser.rc!==0)throw Error('Rendezvous namespace/collision restriction failed')
    if(!denied(browserKernel.paths[0]['file-read-data'])||!denied(rendererKernel.paths[0]['file-read-data'])||
      !denied(rendererKernel.paths[1]['file-read-data'])||!denied(rendererKernel.paths[3]['file-read-data']))
      throw Error('Protected sentinel/entry/ordinary HOME reads not denied')
    // ALL frozen host/runtime file mutation probes, not a sentinel-only claim.
    const graphChecks=[]
    for(let offset=0;offset<graphPaths.length;offset+=256) {
      life.check()
      const batch=graphPaths.slice(offset,offset+256)
      const b=validKernel(inspect(child.pid,batch),copied.executable,child.pid,batch,'browser')
      const r=validKernel(inspect(id.pid,batch),copied.renderer,id.pid,batch,'renderer')
      if(b.startSec!==browserKernel.startSec||b.startUsec!==browserKernel.startUsec||
        r.startSec!==rendererKernel.startSec||r.startUsec!==rendererKernel.startUsec)throw Error('Kernel PID creation rotated')
      graphChecks.push({offset,count:batch.length,browser:b.paths,renderer:r.paths})
    }
    report.preflight={...preflight,browserKernel,rendererKernel,graphPaths,graphChecks}
    report.checks.push('External live PID/creation/executable/kernel and genuine preferences/metrics/readonly bridge preflight before fixed asset release')
    owned.set(child.pid,browserKernel);owned.set(id.pid,rendererKernel)
    // Abort unexpected descendants; never assume future helper kinds from one run.
    let stopping=false
    function descendants() {
      const text=execFileSync('/bin/ps',['-axo','pid=,ppid=,pgid=,args='],{encoding:'utf8',timeout:3000,maxBuffer:2*1024*1024})
      const list=text.split('\n').map(line=>line.trim().split(/\s+/,4)).filter(p=>Number(p[2])===child.pid)
      for(const [pidText] of list) {
        const pid=Number(pidText)
        if(pid===child.pid)continue
        if(pid!==id.pid)throw Error('Unauthorized native descendant')
        let v
        try{v=inspect(pid)}catch(error) {
          // During requested shutdown ONLY, ps/libproc may race the known
          // Renderer exiting. Independently require an absent PID (not a
          // recycled PID, malformed observer, permission failure or timeout).
          if(!stopping||error.status!==6)throw error
          let absent=false
          try{execFileSync('/bin/ps',['-p',String(pid),'-o','pid='],{encoding:'utf8',timeout:2000,maxBuffer:4096})}
          catch(query){absent=query.status===1&&String(query.stdout||'').trim()===''}
          if(!absent)throw error
          report.shutdownExited ||= []
          report.shutdownExited.push(pid)
          continue
        }
        if(v.executable!==copied.renderer||v.startSec!==rendererKernel.startSec||v.startUsec!==rendererKernel.startUsec)
          throw Error('Unauthorized/rotated native descendant')
        if(v.sockets.includes(browserKernel.privateSocket))throw Error('Outcome channel inherited by helper')
      }
      return list
    }
    descendants()
    monitor=setInterval(()=>{try{descendants()}catch(error){reject(error)}},250)
    fence()
    await wait('released',{type:'release',identity:id})
    const observations=[]
    for(let i=0;i<3;i++){
      await life.race(new Promise(r=>setTimeout(r,400)))
      const value=exactObservation((await wait('observation',{type:'observe'})).value,{identity:id,manifest:assets.manifest})
      if(JSON.stringify(value.identity)!==JSON.stringify(id))throw Error('Observation PID binding rotated')
      observations.push(value)
    }
    const final=observations.at(-1)
    report.observations=observations;report.privateMessages=messages
    if(!['invoke:hd:changes:create','invoke:hd:changes:prepare','invoke:hd:changes:qualify','invoke:hd:changes:approve',
      'invoke:hd:changes:activate','event:hd:rooms:save','invoke:hd:host:restartServe','invoke:maia:openExternal',
      'invoke:hd:clipboard:writeText','invoke:hd:files:pickMedia','invoke:hd:files:saveAs','invoke:hd:computer:open',
      'invoke:maia:plugins:readDir','invoke:maia:task','invoke:maia:secretsCopy'].every(k=>final.blocked.includes(k)))
      throw Error('Fixed genuine negative bridge calls did not hit qualification fence:'+JSON.stringify(final.blocked))
    if(!['index.html','negative.js'].every(n=>final.assets.some(a=>a.path===n&&a.pid===id.pid&&a.sha256===assets.manifest.find(f=>f.path===n).sha256)))
      throw Error('Actual broker consumed bytes mismatch')
    const sampleFile=path.join(job,'main-thread-sample.txt')
    execFileSync('/usr/bin/sample',[String(child.pid),'1','1','-file',sampleFile],{timeout:5000,maxBuffer:65536})
    const sample=tree.readFile(sampleFile,4*1024*1024).bytes.toString()
    if(!sample.includes('NetworkService')||!sample.includes('Chrome_InProcGpuThread'))throw Error('Actual in-main network/GPU topology missing')
    report.observations=observations;report.privateMessages=messages;report.threadSampleSha256=tree.sha(sample)
    report.checks.push('Fixed negative invoke/sync paths rejected; protected isolated observer survives mainworld prototype counterfeit; actual indexed bytes and private channel')
    if(!tree.readFile(journal).bytes.equals(journalBytes))throw Error('Passive genuine bridge mutated/recovered journal')
    const rendererFinal=await tree.capture(renderer)
    if(rendererFinal.digest!==assets.digest)throw Error('Frozen renderer source changed')
    fence()
    await life.shutdown(closePromise,()=>{stopping=true;child.stdio[3].write(JSON.stringify({nonce,type:'stop'})+'\n')})
    descendants()
    life.check()
    report.stdout=stdout.join('');report.stderr=stderr.join('')
    if(report.exit.code!==0)throw Error('Native lifecycle did not close cleanly')
    report.checks.push('Read-only owned journal unchanged; frozen runtime/host/entry/policy/probe and asset identities unchanged; no backend startup or provider route')
    report.healthSamples=3
  }catch(error){report.failure=error.stack}
  finally {
    clearInterval(monitor);life?.dispose()
    // Kill only PIDs whose libproc creation/executable identity still matches.
    for(const [pid,v] of owned)try{
      const current=JSON.parse(execFileSync(path.join(job,'control/observe'),['--observe',String(pid),String(child.pid)],{encoding:'utf8',timeout:2000}))
      const sameExecutable=current.executable===v.executable||
        pid===child.pid&&v.executable===path.join(job,'control/observe')&&current.executable===ownedBrowserExecutable
      if(current.pid===pid&&current.startSec===v.startSec&&current.startUsec===v.startUsec&&sameExecutable)process.kill(pid,'SIGKILL')
    }catch(error){if(error.code!=='ESRCH'&&error.status===undefined)report.cleanupError=String(error)}
    // Never use ChildProcess.kill as an unverified PID-reuse fallback.
    if(child&&!owned.has(child.pid)&&child.exitCode===null&&child.signalCode===null)
      report.cleanupError='Unobserved child identity retained; no unverified kill'
    slots--
    fs.writeFileSync(path.join(job,'report.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600})
  }
  return report
}
module.exports={run,HTML,NEGATIVE,FLAGS,VERSION,exactObservation,validKernel,denied}
