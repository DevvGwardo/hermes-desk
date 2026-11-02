// Synthetic native health is a unit double, NOT S1/native qualification.
import {afterEach,describe,expect,it,vi} from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {setTimeout as delay} from 'node:timers/promises'
import {fixture,supervisor,tree} from './self-modification-fixture.test.support.mjs'
const roots=[]
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})})
async function setup() {const f=await fixture({currentNativeSynthetic:true});roots.push(f.root);f.seed();return f}
const run=f=>supervisor.activate(f.config,{health:f.health,idle:()=>{}})
const current=f=>fs.readFileSync(path.join(f.config.root,'current/index.html'),'utf8')
describe('external renderer supervisor failure contracts (synthetic health)',()=>{
  it('stages, swaps, binds startup nonce and retains known-good plus versioned accepted receipt',async()=>{
    const f=await setup(),health=vi.fn(f.health)
    const result=await supervisor.activate(f.config,{health,idle:()=>{}})
    expect(result.state).toBe('accepted')
    expect(current(f)).toContain('candidate')
    const tx=supervisor.transaction(f.config.root)
    expect(result.nonce).toBe(tx.nonce)
    expect(health.mock.calls[0][0].expectedArtifactDigest).toBe(f.q.artifactDigest)
    expect(fs.readFileSync(path.join(f.config.root,tx.previous,'index.html'),'utf8')).toContain('known-good')
    expect(JSON.parse(fs.readFileSync(path.join(f.config.root,`version-${f.record.versionId}.json`))).state).toBe('accepted')
    expect(fs.existsSync(path.join(f.config.root,'activation.lock'))).toBe(false)
  })
  it.each(['stage','old-renamed','swap'])('failed %s dispatch restores externally and retains partial/rejected candidate bytes',async point=>{
    const f=await setup()
    const result=await supervisor.activate(f.config,{health:f.health,idle:()=>{},fault:stage=>{
      if(stage===point)throw new Error(`owned ${point} failure`)
    }})
    expect(result.state).toBe('rolled-back')
    expect(current(f)).toContain('known-good')
    expect(supervisor.transaction(f.config.root).state).toBe('rolled-back')
    expect(fs.readdirSync(f.config.root).some(name=>name.startsWith('stage-')||name.startsWith('rejected-'))).toBe(true)
  })
  it.each(['nonce','artifact','bridge','samples','launch'])('failed native health %s never retains the candidate as accepted',async kind=>{
    const f=await setup()
    const health=async input=>{
      if(kind==='launch')throw new Error('owned launch failure')
      const r=await f.health(input)
      if(kind==='nonce')r.nonce=f.record.versionId
      if(kind==='artifact')r.artifactDigest='a'.repeat(64)
      if(kind==='bridge')r.fixedBridge=false
      if(kind==='samples')r.healthSamples=0
      return r
    }
    expect((await supervisor.activate(f.config,{health,idle:()=>{}})).state).toBe('rolled-back')
    expect(current(f)).toContain('known-good')
  })
  it.each(['before','stage','swap','health'])('cancellation at %s is fenced before acceptance',async phase=>{
    const f=await setup(),abort=new AbortController()
    f.config.signal=abort.signal
    const cancel=()=>{expect(f.controller.cancel(1,f.id,f.attemptId).ok).toBe(true);abort.abort()}
    if(phase==='before') {
      cancel()
      await expect(run(f)).rejects.toThrow(/cancelled/)
    } else {
      const result=await supervisor.activate(f.config,{idle:()=>{},fault:s=>{if(s===phase)cancel()},
        health:async input=>{if(phase==='health')cancel();return f.health(input)}})
      expect(result.state).toBe('rolled-back')
    }
    expect(current(f)).toContain('known-good')
  })
  it.each(['unapproved','expired','stale','contradictory-build','schema'])('refuses %s authority without swapping or dispatching health',async kind=>{
    const f=await setup(),health=vi.fn(f.health)
    if(kind==='unapproved'||kind==='expired') {
      const s=f.store.read()
      f.store.mutate(s.revision,records=>{
        if(kind==='unapproved'){records[0].stage='qualified';records[0].approval=null}
        else records[0].approval.expiresAt=new Date(Date.now()-1000).toISOString()
      })
    } else {
      const raw=structuredClone(f.journal)
      if(kind==='stale')raw.revision++
      if(kind==='schema')raw.version=999
      if(kind==='contradictory-build')raw.changes[0].attempts[0].validation.boundBuild.artifact.boundDigest='a'.repeat(64)
      fs.writeFileSync(f.journalPath,JSON.stringify(raw))
    }
    await expect(supervisor.activate(f.config,{health,idle:()=>{}})).rejects.toThrow()
    expect(health).not.toHaveBeenCalled()
    expect(current(f)).toContain('known-good')
  })
  it.each(['source','restored-source','renderer','protected-path','target-header','target-symlink','target-replacement'])('refuses %s mutation after approval',async kind=>{
    const f=await setup()
    const sourceFile=path.join(f.source,'src/components/Note.tsx')
    if(kind==='source')fs.appendFileSync(sourceFile,'mutation')
    if(kind==='restored-source'){const b=fs.readFileSync(sourceFile);fs.appendFileSync(sourceFile,'x');fs.writeFileSync(sourceFile,b)}
    if(kind==='renderer')fs.appendFileSync(path.join(f.renderer,'index.html'),'mutation')
    if(kind==='protected-path')fs.writeFileSync(path.join(f.source,'package.json'),'{"scripts":{"build":"unapproved"}}')
    if(kind==='target-header') {
      const p=path.join(f.config.root,'target.json'),value=JSON.parse(fs.readFileSync(p))
      value.id=f.record.versionId;fs.writeFileSync(p,JSON.stringify(value))
    }
    if(kind==='target-symlink'||kind==='target-replacement') {
      fs.renameSync(f.config.root,f.config.root+'.retained')
      if(kind==='target-symlink')fs.symlinkSync(f.config.root+'.retained',f.config.root)
      else fs.mkdirSync(f.config.root)
    }
    await expect(run(f)).rejects.toThrow()
    const oldRoot=['target-symlink','target-replacement'].includes(kind)?f.config.root+'.retained':f.config.root
    expect(fs.readFileSync(path.join(oldRoot,'current/index.html'),'utf8')).toContain('known-good')
  })
  it.each(['pending-work','migration','live-pid','in-use'])('refuses %s instead of guessing, killing or migrating',async kind=>{
    const f=await setup()
    if(kind==='in-use') {
      await expect(supervisor.activate(f.config,{health:f.health,idle:()=>{throw new Error('owned in-use fixture')}})).rejects.toThrow(/in-use/)
    } else {
      const file=path.join(f.config.root,'target.json'),v=JSON.parse(fs.readFileSync(file))
      if(kind==='pending-work')v.pendingWork=true
      if(kind==='migration')v.storagePolicy='unknown-migration-v2'
      if(kind==='live-pid')v.livePid=process.pid
      fs.writeFileSync(file,JSON.stringify(v))
      await expect(run(f)).rejects.toThrow(/pending|migration|in-use/)
    }
    expect(current(f)).toContain('known-good')
  })
  it('concurrent target ownership refuses the second activation; no duplicate swap',async()=>{
    const f=await setup()
    let release,entered
    const ready=new Promise(r=>entered=r),hold=new Promise(r=>release=r)
    const first=supervisor.activate(f.config,{idle:()=>{},health:async input=>{entered();await hold;return f.health(input)}})
    await ready
    await expect(run(f)).rejects.toThrow()
    release()
    expect((await first).state).toBe('accepted')
    expect(fs.readdirSync(f.config.root).filter(n=>n.startsWith('known-good-'))).toHaveLength(1)
  })
  it.each(['old-renamed','swap','health','accepted'])('real owned supervisor process crash at %s reconciles externally without replay',async point=>{
    const f=await setup()
    const module=path.resolve(import.meta.dirname,'self-modification-supervisor.cjs')
    const code=`
(async()=>{
const {syntheticModule,syntheticQualification}=await import(${JSON.stringify(new URL('./self-modification-native-synthetic.test.support.mjs',import.meta.url).href)})
const s=syntheticModule(${JSON.stringify(module)})
const abort=new AbortController()
s.activate({...${JSON.stringify({...f.config,signal:undefined})},signal:abort.signal},
 {idle:()=>{},fault:phase=>{if(phase===${JSON.stringify(point)}){process.stdout.write('OWNED_CRASH_READY\\\\n');process.exit(71)}},
 health:async input=>{if(${JSON.stringify(point)}==='health'){process.stdout.write('OWNED_CRASH_READY\\\\n');process.exit(71)}
 return {...syntheticQualification(${JSON.stringify(f.q)},input.job,input.startupNonce),consumer:input.consumerBinding,artifactDigest:input.expectedArtifactDigest}}})
.catch(e=>{console.error(e.stack);process.exit(72)})
})().catch(e=>{console.error(e.stack);process.exit(72)})
`
    const child=spawn(process.execPath,['-e',code],{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']})
    let output=''
    child.stdout.on('data',c=>output+=c)
    child.stderr.on('data',c=>output+=c)
    const closed=once(child,'close')
    const timer=setTimeout(()=>child.kill('SIGKILL'),10000)
    const [status]=await closed
    clearTimeout(timer)
    expect(status,output).toBe(71)
    expect(output).toContain('OWNED_CRASH_READY')
    expect((await supervisor.recover(f.config.root,f.record.versionId,{userData:f.data})).state).toBe(point==='accepted'?'accepted':'rolled-back')
    expect(current(f)).toContain(point==='accepted'?'candidate':'known-good')
    expect(fs.existsSync(path.join(f.config.root,'activation.lock'))).toBe(false)
    expect(fs.readdirSync(f.config.root).some(n=>n.startsWith(point==='accepted'?'known-good-':'stage-')||n.startsWith('rejected-'))).toBe(true)
  })
  it('terminal artifact mutation is not accepted as restart health or replay permission',async()=>{
    const f=await setup()
    await run(f)
    fs.appendFileSync(path.join(f.config.root,'current/index.html'),'changed after acceptance')
    await expect(supervisor.recover(f.config.root,f.record.versionId,{userData:f.data})).rejects.toThrow(/mutated/)
  })
  it('source mutation during health triggers external rollback even if health claims success',async()=>{
    const f=await setup()
    const result=await supervisor.activate(f.config,{idle:()=>{},health:async input=>{
      fs.appendFileSync(path.join(f.source,'src/components/Note.tsx'),'changed during health')
      return f.health(input)
    }})
    expect(result.state).toBe('rolled-back')
    expect(current(f)).toContain('known-good')
  })
  it('independent supervisor deadline aborts hung synthetic health and restores externally',async()=>{
    const f=await setup()
    let signal
    const outcome=await supervisor.activate(f.config,{idle:()=>{},healthTimeoutMs:15,
      health:input=>{signal=input.signal;return new Promise(()=>{})}})
    expect(outcome.state).toBe('rolled-back')
    expect(outcome.reason).toMatch(/deadline/)
    expect(signal.aborted).toBe(true)
    expect(current(f)).toContain('known-good')
  })
  it('a consumed external version cannot be replayed after a lost acknowledgment',async()=>{
    const f=await setup()
    await run(f)
    const health=vi.fn(f.health)
    await expect(supervisor.activate(f.config,{idle:()=>{},health})).rejects.toThrow(/duplicate|replay/)
    expect(health).not.toHaveBeenCalled()
    expect(current(f)).toContain('candidate')
  })
  it('an intent disk failure never dispatches stage, swap or native health',async()=>{
    const f=await setup(),health=vi.fn(f.health)
    vi.spyOn(fs,'fsyncSync').mockImplementationOnce(()=>{throw new Error('owned intent disk failure')})
    await expect(supervisor.activate(f.config,{idle:()=>{},health})).rejects.toThrow(/disk failure/)
    expect(health).not.toHaveBeenCalled()
    expect(current(f)).toContain('known-good')
    expect(fs.existsSync(path.join(f.config.root,'transaction.json'))).toBe(false)
    // This injected error occurs at the FIRST lock fsync, before tx exists.
    expect(fs.existsSync(path.join(f.config.root,'activation.lock'))).toBe(false)
  })
  it('unknown replacement lock is retained without guessed rollback or cleanup',async()=>{
    const f=await setup()
    await expect(supervisor.activate(f.config,{idle:()=>{},health:f.health,fault:stage=>{
      if(stage==='intent'){
        fs.renameSync(path.join(f.config.root,'activation.lock'),path.join(f.config.root,'owned-lock.retained'))
        fs.writeFileSync(path.join(f.config.root,'activation.lock'),'unknown valuable replacement')
      }
    }})).rejects.toThrow(/identity/)
    expect(current(f)).toContain('known-good')
    expect(fs.readFileSync(path.join(f.config.root,'activation.lock'),'utf8')).toBe('unknown valuable replacement')
  })
  it('a recovery request for another version cannot alter terminal target bytes',async()=>{
    const f=await setup()
    await run(f)
    await expect(supervisor.recover(f.config.root,f.id,{userData:f.data})).rejects.toThrow(/version mismatch/)
    expect(current(f)).toContain('candidate')
  })
})
