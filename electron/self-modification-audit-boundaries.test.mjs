// Owned fake bytes / synthetic child protocol only. Not native qualification.
import {afterEach,describe,expect,it,vi} from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import {once} from 'node:events'
import {spawn} from 'node:child_process'
const require=createRequire(import.meta.url)
const tree=require('./self-modification-artifact.cjs'),seals=require('./self-modification-seal.cjs')
const policy=require('./self-modification-policy.cjs'),baseline=require('./self-modification-baseline.cjs')
const supervisor=require('./self-modification-supervisor.cjs')
const roots=[]
afterEach(()=>{vi.restoreAllMocks();for(const r of roots.splice(0))fs.rmSync(r,{recursive:true,force:true})})
const runtimeRelative='electron/dist/Electron.app/Contents/MacOS/Electron'
function root(){const r=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hd-selfedit-audit-unit-')));roots.push(r);return r}
async function nativeFixture(mutate=()=>{}) {
  const r=root(),source=path.join(r,'origin'),job=path.join(r,'job'),destination=path.join(job,'app/node_modules')
  fs.mkdirSync(path.dirname(destination),{recursive:true})
  const runtime=require('./self-modification-native-runtime.cjs')
  tree.materialize(source,[{path:runtime.RUNTIME,mode:0o700,bytes:Buffer.from('INERT OWNED BINARY; NEVER EXECUTED\n')},
    {path:runtime.RENDERER,mode:0o700,bytes:Buffer.from('INERT OWNED HELPER; NEVER EXECUTED\n')}])
  const origin=path.join(source,runtime.RUNTIME),copied=path.join(destination,runtime.RUNTIME)
  const module={exports:{}}
  vm.runInNewContext(fs.readFileSync(require.resolve('./self-modification-native-runtime.cjs'),'utf8'),{
    module,exports:module.exports,require:name=>name==='./self-modification-seal.cjs'?{...seals,copy:async(...args)=>{
      const result=await seals.copy(...args);mutate({origin,copied,at:'copied'});return result}}:require(name),
  })
  let dispatched
  const fakeSpawn=vi.fn(file=>{dispatched=file})
  return {origin,copied,job,fakeSpawn,get dispatched(){return dispatched},qualify:async options=>{
    const graph=await module.exports.copy(source,destination,options)
    graph.fence();fakeSpawn(graph.executable);mutate({origin,copied,at:'dispatch'});graph.fence()
    return {runtime:{sha256:graph.runtimeSha256}}
  }}
}
describe('critic P1 runtime-origin boundary (synthetic only)',()=>{
  it.each(['mutation','replacement'])('origin %s never becomes the dispatched runtime',async kind=>{
    const f=await nativeFixture(({origin,at})=>{
      if(at!=='copied')return
      if(kind==='replacement')fs.renameSync(origin,origin+'.retained')
      fs.writeFileSync(origin,'DIFFERENT INERT OWNED ORIGIN; NEVER EXECUTED\n',{mode:0o700})
    })
    const result=await f.qualify()
    expect(f.dispatched).toBe(f.copied)
    expect(fs.readFileSync(f.copied,'utf8')).toContain('INERT OWNED BINARY')
    expect(result.runtime.sha256).toBe(tree.sha(fs.readFileSync(f.copied)))
  })
  it.each(['origin','outside'])('rejects %s executable override without launch',async where=>{
    const f=await nativeFixture()
    await expect(f.qualify({executable:where==='origin'?f.origin:process.execPath})).rejects.toThrow(/copied|override/)
    expect(f.fakeSpawn).not.toHaveBeenCalled()
  })
  it('copied runtime mutation at dispatch cannot produce accepted provenance',async()=>{
    const f=await nativeFixture(({copied,at})=>{if(at==='dispatch')fs.appendFileSync(copied,'OWNED MUTATION')})
    await expect(f.qualify()).rejects.toThrow(/mutat|identity/)
  })
  it('same-byte copied runtime replacement at dispatch cannot restore identity',async()=>{
    const f=await nativeFixture(({copied,at})=>{
      if(at==='dispatch'){const retained=path.join(path.dirname(f.job),'retained-runtime');fs.renameSync(copied,retained);fs.copyFileSync(retained,copied)}
    })
    await expect(f.qualify()).rejects.toThrow(/mutat|identity/)
  })
})
describe('critic P1 known sensitive baseline paths (owned FAKE only)',()=>{
  it.each(['electron/auth.json','src/auth.json','electron/auth.json.bak','electron/state.db','electron/credentials.json',
    'electron/tokens.json','electron/.netrc','electron/id_ed25519'])('excludes %s before working snapshot/review content access',async name=>{
    const r=root();fs.mkdirSync(path.dirname(path.join(r,name)),{recursive:true})
    fs.writeFileSync(path.join(r,name),'OWNED FAKE NOT A CREDENTIAL')
    const opened=[],realOpen=fs.openSync
    vi.spyOn(fs,'openSync').mockImplementation((file,...args)=>{
      if(file===path.join(r,name)){opened.push(file);throw Error('Sensitive fixture must not be opened')}
      return realOpen(file,...args)
    })
    const snap=await baseline.snapshot(r,async()=>Buffer.from(name+'\0'))
    const calls=[]
    const review=await baseline.review(r,'a'.repeat(40),snap,async(_root,args)=>{
      calls.push(args);return Buffer.from(`100644 blob ${'b'.repeat(40)}\t${name}\0`)
    })
    expect(policy.sourcePath(name)).toBe(false);expect(opened).toEqual([])
    expect(snap.files).toEqual([]);expect(review).toEqual([])
    expect(calls.some(args=>args[0]==='cat-file')).toBe(false)
  })
  it('preserves genuine protected auth/security source modules',()=>{
    for(const name of ['electron/auth.cjs','electron/security.cjs','electron/credentials.cjs','src/lib/auth.ts','src/lib/secrets.ts']){
      expect(policy.sourcePath(name)).toBe(true);expect(policy.editable(name)).toBe(false)
    }
  })
})
describe('SE-INTEGRATION-001 actual default lsof idle guard',()=>{
  it.each([
    {status:0,stdout:'',stderr:''},
    {status:0,stdout:'p9\0\n',stderr:'owned synthetic diagnostic'},
    {status:1,stdout:'p9\0\n',stderr:''},
    {status:1,stdout:'p9\0\nf8\0tREG\0',stderr:''},
    {status:2,stdout:'',stderr:''},
    {status:null,stdout:'',stderr:'',signal:'SIGTERM'},
    {status:1,stdout:'',stderr:'',error:{code:'ENOBUFS'}},
  ])('fails closed for unknown/partial/timeout lsof evidence %# (synthetic)',result=>{
    const module={exports:{}}
    vm.runInNewContext(fs.readFileSync(require.resolve('./self-modification-supervisor.cjs'),'utf8'),{
      module,exports:module.exports,process,Buffer,console,setTimeout,clearTimeout,__dirname:import.meta.dirname,
      require:name=>name==='node:child_process'?{spawnSync:()=>result}:require(name),
    })
    expect(()=>module.exports.assertIdle(root())).toThrow()
  })
  it('allows only the exact expected owned activation lock on actual lsof exit1/stdout',()=>{
    const r=root(),file=path.join(r,'activation.lock'),fd=fs.openSync(file,'wx',0o600),stat=fs.fstatSync(fd)
    try {fs.writeFileSync(fd,JSON.stringify({id:'owned-test',pid:process.pid}))
      expect(()=>supervisor.assertIdle(r,{lock:{fd,path:file,dev:stat.dev,ino:stat.ino}})).not.toThrow()
    } finally {fs.closeSync(fd)}
  })
  it('does not exempt another self-owned open renderer file',()=>{
    const r=root(),file=path.join(r,'index.html'),fd=fs.openSync(file,'wx',0o600)
    try {expect(()=>supervisor.assertIdle(r)).toThrow()} finally {fs.closeSync(fd)}
  })
  it('refuses an independent owned consumer without killing it',async()=>{
    const r=root(),file=path.join(r,'index.html');fs.writeFileSync(file,'owned consumer fixture')
    const child=spawn(process.execPath,['-e',`const fs=require('fs');const fd=fs.openSync(process.argv[1],'r');process.stdout.write('READY');setInterval(()=>{},1000)` ,file],{stdio:['ignore','pipe','pipe']})
    const close=once(child,'close')
    try {await once(child.stdout,'data');expect(()=>supervisor.assertIdle(r)).toThrow();expect(()=>process.kill(child.pid,0)).not.toThrow()}
    finally {child.kill('SIGTERM');await close}
  })
})
