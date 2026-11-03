// VALID fixed trusted FAKE host/kernel/observer. All executable bytes are inert.
// Runs genuine phase1.run in a VM; NEVER spawns or compiles native code.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {EventEmitter} from 'node:events'
import {createRequire} from 'node:module'
import {kernel,metrics,contract,syntheticBarrier} from './self-modification-native-synthetic.test.support.mjs'
const require=createRequire(import.meta.url),tree=require('./self-modification-artifact.cjs')
const realPhase=require('./self-modification-native-phase1.cjs')
export async function shutdownFixture(root,{attack='abort',legacySource}={}) {
  const job=path.join(root,'run'),bp=2147483001,rp=2147483002,creation=1234561000.001
  const id={windowId:1,webContentsId:1,pid:rp,creationTime:creation,browserPid:bp,browserCreationTime:creation}
  const relative='electron/dist/Electron.app/Contents/MacOS/Electron'
  const helper='electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)'
  const abort=new AbortController(),killed=[]
  const timely=attack.startsWith('clean')||attack.endsWith('-close'),deadline=timely?2000:80
  let copied,child,nonce,digest,stopped=false,lateTimer,deadlineFired=false,stopAt
  let deadlineCallback
  function fakeTimeout(fn,ms,...args) {
    if(ms===45000) {
      const fire=()=>{deadlineFired=true;fn(...args)}
      // Explicit clock fixture: expire the genuine 45s timer AFTER stop, not
      // before schema validation and not after the competing 3s stop timer.
      if(attack==='deadline')deadlineCallback=fire
      return setTimeout(fire,attack==='deadline'?2000:deadline)
    }
    return setTimeout(fn,ms===400?0:ms===3000?60:ms,...args)
  }
  function observed(pid,paths=[]) {
    if(pid===rp&&stopped&&['clean-gone','unobserved-close'].includes(attack))
      throw Object.assign(Error('SYNTHETIC libproc image absent/error'),{status:6})
    const value=kernel(pid===bp?copied.executable:copied.renderer,pid,bp,paths)
    if(legacySource)for(const p of value.paths)delete p.pathDigest
    return value
  }
  function mockExec(file,args) {
    if(file==='/bin/ps'&&args.at(-1)==='pid='&&attack==='clean-gone')
      throw Object.assign(Error('SYNTHETIC independently absent known PID'),{status:1,stdout:Buffer.alloc(0)})
    if(file==='/usr/bin/clang'){fs.writeFileSync(args[args.indexOf('-o')+1],'INERT SYNTHETIC NEVER EXECUTED');return Buffer.alloc(0)}
    if(args[0]==='--self')return JSON.stringify({read:{rc:-1,errno:1},write:{rc:-1,errno:1},
      graphWrite:{rc:-1,errno:1},network:{rc:-1,errno:1},spawnErrno:1})
    if(args[0]==='--observe')return JSON.stringify(observed(Number(args[1]),args.slice(3)))
    if(file==='/usr/bin/sample'){fs.writeFileSync(args[args.indexOf('-file')+1],'NetworkService Chrome_InProcGpuThread');return Buffer.alloc(0)}
    if(file==='/bin/ps')return args[0]==='-p'?copied.renderer+' --type=renderer --enable-sandbox --seatbelt-client=49':
      `${bp} 42 ${bp} synthetic\n${rp} ${bp} ${bp} synthetic`+
      (stopped&&(attack==='descendant'||attack==='descendant-close'&&child?.exitCode===0)?`\n2147483003 ${bp} ${bp} unknown`:'')
    throw Error('Unexpected fake exec:'+file)
  }
  function fakeSpawn(_file,args) {
    child=new EventEmitter();child.pid=bp;child.exitCode=null;child.signalCode=null
    child.stdout=new EventEmitter();child.stderr=new EventEmitter()
    child.stdio=[null,child.stdout,child.stderr,new EventEmitter()]
    child.kill=()=>{throw Error('UNVERIFIED KILL forbidden even in fake fixture')}
    const e=fs.readFileSync(args.at(-1),'utf8')
    nonce=JSON.parse(/JSON.stringify\(\{version:1,nonce:("[^"]+")/.exec(e)[1])
    digest=JSON.parse(/,digest:("[^"]+")/.exec(e)[1])
    const emit=(type,value)=>queueMicrotask(()=>child.stdio[3].emit('data',Buffer.from(
      JSON.stringify({version:1,nonce,digest,type,...value===undefined?{}:{value}})+'\n')))
    const receipt={channel:'hd:changes:list',topFrame:true,...id,ok:true,revision:2}
    child.stdio[3].write=text=>{
      const m=JSON.parse(text)
      if(m.type==='preflight')emit('preflight',{identity:id,preferences:{sandbox:true,contextIsolation:true,
        nodeIntegration:false,disableDialogs:true,preload:path.join(job,'app/electron/preload.cjs'),
        preloadSha256:tree.sha(fs.readFileSync(path.join(job,'app/electron/preload.cjs'))),
        preloadProvenance:'actual-genuine-constructor-and-passive-bridge'},metrics:metrics(id),
        guards:['constructor:BrowserWindow','constructor:Notification','constructor:Tray','constructor:WebContentsView',
          'file-chooser:intercept-installed','document-start:native-surface-guard-observed',...Array(40).fill('synthetic-guard')],
        receipts:[receipt],...legacySource?{}:{surfaceEvidence:{
          source:'fixed-trusted-inert-main-before-release',runtimeVersion:'45.2.1',
          surface:Object.fromEntries(['prototypePoison','subframe','subframeParser','fsa','clipboardRead','clipboardWrite','capture','media','mediaEnumeration','wake'].map(k=>[k,true])),
          nativeAliases:Object.fromEntries(contract.NATIVE_ALIASES.map(k=>[k,true])),...syntheticBarrier()}}})
      if(m.type==='release')emit('released')
      if(m.type==='observe')emit('observation',{value:{complete:true,root:true,nodeAbsent:true},identity:id,
        assets:[['index.html',realPhase.HTML],['negative.js',realPhase.NEGATIVE]].map(([p,b])=>({path:p,
          sha256:tree.sha(b),size:b.length,pid:rp,creationTime:creation,windowId:1,webContentsId:1})),
        blocked:['invoke:hd:changes:create','invoke:hd:changes:prepare','invoke:hd:changes:qualify',
          'invoke:hd:changes:approve','invoke:hd:changes:activate','event:hd:rooms:save','invoke:hd:host:restartServe',
          'invoke:maia:openExternal','invoke:hd:clipboard:writeText','invoke:hd:files:pickMedia','invoke:hd:files:saveAs',
          'invoke:hd:computer:open','invoke:maia:plugins:readDir','invoke:maia:task','invoke:maia:secretsCopy'],
        receipts:[receipt],metrics:metrics(id)})
      if(m.type==='stop'){
        stopped=true;stopAt=Date.now()
        if(attack==='abort')abort.abort()
        if(attack==='deadline')setTimeout(()=>deadlineCallback(),10)
        if(attack==='output')child.stdout.emit('data',Buffer.alloc(129*1024))
        if(attack==='private-output')child.stdio[3].emit('data',Buffer.alloc(1024*1024+1))
        if(attack==='fatal')emit('fatal')
        // Late CLEAN exit must not overwrite any failure.
        if(attack!=='hang')lateTimer=setTimeout(()=>{child.exitCode=0;child.emit('close',0,null)},timely?10:160)
      }
    }
    setTimeout(()=>emit('ready'),0)
    return child
  }
  const host={inspect:async()=>({identity:{codeDigest:'c'.repeat(64),version:'synthetic'},
    packageBytes:Buffer.from('{"name":"synthetic"}'),files:[
      {path:'main.cjs',bytes:Buffer.from('INERT SOURCE NEVER EXECUTED'),mode:0o600},
      {path:'preload.cjs',bytes:Buffer.from("ipcRenderer.invoke('hd:changes:list')"),mode:0o600},
      {path:'self-modification-native-mode.cjs',bytes:Buffer.from('INERT GUARDS NEVER EXECUTED'),mode:0o600},
      {path:'self-modification-native-probe.c',bytes:Buffer.from('INERT PROBE NEVER COMPILED'),mode:0o600}]})}
  const runtime={copy:async(_origin,destination)=>{
    tree.materialize(destination,[{path:relative,bytes:Buffer.from('INERT EXE NEVER EXECUTED'),mode:0o700},
      {path:helper,bytes:Buffer.from('INERT HELPER NEVER EXECUTED'),mode:0o700}])
    return copied={executable:path.join(destination,relative),renderer:path.join(destination,helper),
      runtimeSha256:'a'.repeat(64),fence:()=>{},snapshot:{digest:'b'.repeat(64),manifest:[{path:relative},{path:helper}]}}
  }}
  const module={exports:{}},file=legacySource||require.resolve('./self-modification-native-phase1.cjs')
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,__dirname:path.dirname(require.resolve('./self-modification-native-phase1.cjs')),
    Buffer,process:{platform:'darwin',arch:'arm64',kill:pid=>killed.push(pid)},AbortController,console,
    setTimeout:fakeTimeout,
    clearTimeout,setInterval:(fn,ms)=>setInterval(fn,ms===250?5:ms),clearInterval,
    require:n=>n==='node:child_process'?{spawn:fakeSpawn,execFileSync:mockExec}:
      n==='./self-modification-native-runtime.cjs'?runtime:n==='./self-modification-host.cjs'?host:
      n==='./self-modification-native-lifecycle.cjs'?{lifecycle:(signal)=>{
        const file=require.resolve(n),m={exports:{}}
        vm.runInNewContext(fs.readFileSync(file,'utf8'),{module:m,exports:m.exports,Error,Promise,
          setTimeout:fakeTimeout,clearTimeout})
        return m.exports.lifecycle(signal)
      }}:require(n),
  })
  const running=module.exports.run({job,signal:abort.signal})
  // Old source hangs until late exit; never let a red harness hang forever.
  const report=await Promise.race([running,new Promise((_,reject)=>setTimeout(()=>reject(Error('Synthetic fixture outer deadline')),3000))])
  clearTimeout(lateTimer)
  return {report,stopped,deadlineFired,killed,shutdownMs:stopAt?Date.now()-stopAt:null,
    syntheticOnly:true,nativeExecuted:false,aborted:abort.signal.aborted}
}
