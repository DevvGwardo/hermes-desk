// Explicit synthetic guards/lifecycle/recovery; never native qualification.
import {it,expect,afterEach} from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {fixture,createDeliveryManager,productionDeliveryManager,supervisor,syntheticQualification} from './self-modification-fixture.test.support.mjs'
import {contract,kernel,metrics,syntheticModule} from './self-modification-native-synthetic.test.support.mjs'
import {shutdownFixture} from './self-modification-native-shutdown.test.support.mjs'
const require=createRequire(import.meta.url),phase=require('./self-modification-native-phase1.cjs')
const roots=[]
const fresh=()=>{const r=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hd-native-focused-contract-')));roots.push(r);return r}
async function f(){const r=await fixture({currentNativeSynthetic:true});roots.push(r.root);return r}
function inertHost(root) {
  const parent=path.join(root,'inert-host'),folder=path.join(parent,'electron')
  fs.mkdirSync(folder,{recursive:true})
  fs.writeFileSync(path.join(parent,'package.json'),'{"version":"INERT OWNED NEVER EXECUTED"}')
  for(const name of ['main.cjs','self-modification-native.cjs','self-modification-supervisor-worker.cjs'])
    fs.writeFileSync(path.join(folder,name),'// INERT OWNED NEVER EXECUTED')
  return folder
}
const workerCount=r=>fs.readdirSync(path.join(r.data,'self-modification')).filter(v=>v.startsWith('trusted-worker-')).length
afterEach(()=>{for(const r of roots.splice(0))fs.rmSync(r,{recursive:true,force:true})})
it.each(['abort','deadline','hang','output','private-output','fatal','descendant','descendant-close','unobserved-close'])(
  'VALID synthetic late shutdown %s is bounded and permanently latched',async attack=>{
    const value=await shutdownFixture(fresh(),{attack})
    expect(value.stopped).toBe(true)
    expect(value.shutdownMs).toBeLessThan(500)
    expect(value.report.failure).toBeTruthy()
    if(attack==='deadline') {
      expect(value.deadlineFired).toBe(true)
      expect(value.report.failure).toMatch(/45-second deadline/)
    }
    expect(value.report.nativeQualification).toBe(false)
    expect(value.report.artifactApproved).toBe(false)
    expect(value.killed.every(pid=>[2147483001,2147483002].includes(pid))).toBe(true)
  })
it.each(['clean','clean-gone'])('valid timely synthetic %s succeeds without disguising native qualification',async attack=>{
  const {report,stopped}=await shutdownFixture(fresh(),{attack})
  expect(stopped).toBe(true)
  expect(report.failure).toBe(null)
  expect(report.exit.code).toBe(0)
  expect(report.healthSamples).toBe(3)
  expect(report.nativeQualification).toBe(false)
})
it.each([
  ['empty paths',v=>v.paths=[]],['EINVAL read',v=>v.paths[0]['file-read-data']={rc:-1,errno:22}],
  ['negative microseconds',v=>v.startUsec=-1],['overflow microseconds',v=>v.startUsec=1000000],
  ['nonfinite start',v=>v.startSec=Infinity],['wrong path token',v=>v.paths[0].pathDigest='a'.repeat(64)],
  ['reordered paths',v=>v.paths.reverse()],['unknown Mach',v=>v.mach.extra={rc:1,errno:0}],
  ['malformed Mach',v=>v.mach['com.apple.SecurityServer']={rc:-1,errno:22}],
  ['allowed network',v=>v.generic['network-outbound']={rc:0,errno:0}],
  ['missing fork',v=>delete v.generic['process-fork']],['truthy rc',v=>v.paths[0]['file-read-data'].rc=true],
])('rejects exact nested kernel defect %s',(_name,mutate)=>{
  const paths=['/owned/a','/owned/b'],v=kernel('/owned/exe',123,122,paths)
  expect(phase.validKernel(v,'/owned/exe',123,paths,'renderer')).toBe(v)
  mutate(v)
  expect(()=>phase.validKernel(v,'/owned/exe',123,paths,'renderer')).toThrow()
})
it.each(['empty identity','empty metrics','empty receipts','truthy receipt','malformed asset','wrong asset bytes','wrong asset PID','unknown identity','nonfinite cpu'])(
  'rejects observation %s with valid surrounding context',kind=>{
    const id={windowId:1,webContentsId:1,pid:123,creationTime:1234561000.001,browserPid:122,browserCreationTime:1234561000.001}
    const manifest=[{path:'index.html',sha256:'a'.repeat(64),size:10}]
    const v={value:{complete:true,root:true,nodeAbsent:true},identity:id,
      assets:[{path:'index.html',sha256:'a'.repeat(64),size:10,pid:123,creationTime:id.creationTime,windowId:1,webContentsId:1}],
      blocked:['invoke:owned'],receipts:[{channel:'hd:changes:list',topFrame:true,...id,ok:true,revision:1}],metrics:metrics(id)}
    expect(phase.exactObservation(v,{identity:id,manifest})).toBe(v)
    const bad=structuredClone(v)
    if(kind==='empty identity')bad.identity={}
    if(kind==='empty metrics')bad.metrics=[]
    if(kind==='empty receipts')bad.receipts=[]
    if(kind==='truthy receipt')bad.receipts[0].ok='true'
    if(kind==='malformed asset')bad.assets=[{path:'unbound',sha256:'not a digest',pid:-1}]
    if(kind==='wrong asset bytes')bad.assets[0].size=11
    if(kind==='wrong asset PID')bad.assets[0].pid=122
    if(kind==='unknown identity')bad.identity.extra=true
    if(kind==='nonfinite cpu')bad.metrics[0].cpu.percentCPUUsage=Infinity
    expect(()=>phase.exactObservation(bad,{identity:id,manifest})).toThrow()
  })
it.each(['truthy bridge','truthy ready','omitted samples','infinite samples','too many samples','window','preload',
  'kernel','private channel','policy','source','runtime','consumer','nonce','start'])(
  'PUBLIC startup helper refuses %s without copying its predicate',async kind=>{
    const r=await f(),nonce=randomUUID(),job=path.join(r.root,'startup')
    const consumer={targetId:randomUUID(),versionId:r.record.versionId,nonce,artifactDigest:r.q.artifactDigest,rendererDigest:r.q.rendererDigest}
    const result={...syntheticQualification(r.q,job,nonce),consumer}
    const binding={qualification:r.q,nonce,artifactDigest:r.q.artifactDigest,consumer,job}
    const real=require('./self-modification-supervisor.cjs')
    expect(real.validateStartup(result,binding)).toBe(result)
    if(kind==='truthy bridge')result.fixedBridge='false'
    if(kind==='truthy ready')result.rendererReady='false'
    if(kind==='omitted samples')delete result.healthSamples
    if(kind==='infinite samples')result.healthSamples=Infinity
    if(kind==='too many samples')result.healthSamples=65
    if(kind==='window')delete result.nativeWindow
    if(kind==='preload')delete result.preload
    if(kind==='kernel')delete result.kernelEvidence
    if(kind==='private channel')delete result.privateChannel
    if(kind==='policy')result.policyDigest='f'.repeat(64)
    if(kind==='source')result.sourceDigest='f'.repeat(64)
    if(kind==='runtime')result.runtime.rendererSha256='f'.repeat(64)
    if(kind==='consumer')result.consumer={bound:true}
    if(kind==='nonce')result.nonce=randomUUID()
    if(kind==='start')result.kernelEvidence.renderer.startUsec++
    expect(()=>real.validateStartup(result,binding)).toThrow()
  })
it('frozen LEGACY v1 receipt remains byte-readable but NEVER review/approval/activation authority',async()=>{
  const r=await f()
  // Deliberately old literal shape, not q-current from the fixture.
  const old={version:1,revision:1,records:[{...r.record,qualification:r.legacyQ,stage:'qualified',approval:null,target:null}]}
  const file=path.join(r.data,'self-modification/deliveries.json'),bytes=Buffer.from(JSON.stringify(old))
  fs.writeFileSync(file,bytes)
  expect(r.store.read().records[0].stage).toBe('qualified')
  for(const field of ['identity','policyDigest','privateChannel','kernelEvidence'])expect(field in r.legacyQ).toBe(false)
  const manager=productionDeliveryManager(r.data,r.controller,r.workspace,r.checks)
  expect((await manager.deliveryReview(1,r.id,r.attemptId)).ok).toBe(false)
  expect((await manager.approve(1,r.id,r.attemptId,r.record.versionId,'a'.repeat(64))).ok).toBe(false)
  expect((await manager.activate(1,r.id,r.attemptId,r.record.versionId)).ok).toBe(false)
  expect((await manager.deliveryStatus(r.id,r.attemptId)).historicalReadOnly).toBe(true)
  expect(fs.readFileSync(file).equals(bytes)).toBe(true)
  expect(()=>contract.assertAuthority(r.q)).toThrow(/Phase 2/)
})
it('default fixture does NOT strengthen old receipts; even synthetic gate substitution refuses legacy authority',async()=>{
  const r=await fixture();roots.push(r.root)
  expect(r.q).toBe(r.legacyQ)
  expect(r.q.policy).toBe('native-trusted-host-renderer-v1')
  r.seed({stage:'qualified',approval:null,target:null})
  const file=path.join(r.data,'self-modification/deliveries.json'),bytes=fs.readFileSync(file)
  const manager=createDeliveryManager(r.data,r.controller,r.workspace,r.checks)
  expect((await manager.deliveryReview(1,r.id,r.attemptId)).ok).toBe(false)
  expect(fs.readFileSync(file).equals(bytes)).toBe(true)
})
it('production Phase2 gate precedes confirm/qualify/target/launch for even complete synthetic current proofs',async()=>{
  const r=await f();r.seed()
  let calls=0
  const manager=productionDeliveryManager(r.data,r.controller,r.workspace,r.checks,{
    confirm:()=>calls++,qualify:()=>calls++,chooseTarget:()=>calls++,launch:()=>calls++})
  expect((await manager.qualify(1,r.id,r.attemptId)).ok).toBe(false)
  expect((await manager.deliveryReview(1,r.id,r.attemptId)).ok).toBe(false)
  expect((await manager.selectActivationTarget(1,r.id,r.attemptId,r.record.versionId)).ok).toBe(false)
  await expect(require('./self-modification-supervisor.cjs').activate(r.config,{health:()=>calls++})).rejects.toThrow(/Phase 2/)
  expect(calls).toBe(0)
})
it('five sequential recovery reloads and manager restart admit ONE uncertain synthetic launch only',async()=>{
  const r=await f();r.seed({stage:'activating',ownerPid:2147483647})
  let calls=0
  const options={launch:async()=>{calls++;throw Error('SYNTHETIC unknown acknowledgment; no actual launch')}}
  let manager=createDeliveryManager(r.data,r.controller,r.workspace,r.checks,options)
  for(let i=0;i<5;i++)expect((await manager.deliveryStatus(r.id,r.attemptId)).ok).toBe(false)
  manager=createDeliveryManager(r.data,r.controller,r.workspace,r.checks,options)
  expect((await manager.deliveryStatus(r.id,r.attemptId)).ok).toBe(false)
  expect(calls).toBe(1)
  expect(r.store.read().records[0].stage).toBe('activating')
})
it('durable queued targets stay blocked by unknown work; known failure frees global slot but never retries version',async()=>{
  const r=await f(),{admission}=require('./self-modification-recovery-admission.cjs')
  const a=admission(r.data),first=a.reserve(r.record)
  const second={...r.record,versionId:randomUUID(),target:{...r.target,identityDigest:'f'.repeat(64)}}
  expect(()=>admission(r.data).reserve(second)).toThrow(/pending/)
  a.finish(first,Error('SYNTHETIC known launch refused before dispatch'))
  expect(()=>admission(r.data).reserve(r.record)).toThrow(/never retries/)
  expect(admission(r.data).reserve(second).state).toBe('pending')
  expect(a.read().attempts).toHaveLength(2)
})
it('uncertain durable admission write retains ONE reservation, no later queued/version retry',async()=>{
  const r=await f(),{admission}=require('./self-modification-recovery-admission.cjs')
  const io=Object.create(fs);let syncs=0
  io.fsyncSync=fd=>{if(++syncs===4)throw Error('SYNTHETIC ledger acknowledgment lost');fs.fsyncSync(fd)}
  expect(()=>admission(r.data,io).reserve(r.record)).toThrow(/lost/)
  for(let i=0;i<5;i++)expect(()=>admission(r.data).reserve(r.record)).toThrow()
  expect(fs.readdirSync(path.join(r.data,'self-modification')).filter(v=>v.startsWith('recovery-reservation-'))).toHaveLength(1)
  expect(fs.existsSync(path.join(r.data,'self-modification/recovery-pending.json'))).toBe(true)
})
it('content-keyed trusted worker staging reuses exact sealed bytes and has TWO retained-copy hard budget',async()=>{
  const r=await f(),host=require('./self-modification-host.cjs')
  r.host=inertHost(r.root)
  const first=await host.stageWorker(r.data,r.host)
  for(let i=0;i<5;i++)expect((await host.stageWorker(r.data,r.host)).entry).toBe(first.entry)
  fs.appendFileSync(path.join(r.host,'self-modification-native.cjs'),'\n// OWNED synthetic fixture revision 2')
  const second=await host.stageWorker(r.data,r.host)
  expect(second.entry).not.toBe(first.entry)
  fs.appendFileSync(path.join(r.host,'self-modification-native.cjs'),'\n// OWNED synthetic fixture revision 3')
  await expect(host.stageWorker(r.data,r.host)).rejects.toThrow(/budget/)
  expect(workerCount(r)).toBe(2)
})
it('mutated retained worker is neither reused nor replaced/deleted',async()=>{
  const r=await f(),host=require('./self-modification-host.cjs')
  r.host=inertHost(r.root)
  const staged=await host.stageWorker(r.data,r.host)
  fs.appendFileSync(staged.entry,'\n// OWNED test mutation')
  const bytes=fs.readFileSync(staged.entry)
  await expect(host.stageWorker(r.data,r.host)).rejects.toThrow(/sealed|mutated/)
  expect(fs.readFileSync(staged.entry).equals(bytes)).toBe(true)
  expect(workerCount(r)).toBe(1)
})
it('simultaneous trusted worker staging cannot create duplicate retained copies',async()=>{
  const r=await f(),host=require('./self-modification-host.cjs')
  r.host=inertHost(r.root)
  const outcomes=await Promise.allSettled([host.stageWorker(r.data,r.host),host.stageWorker(r.data,r.host)])
  expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1)
  expect(workerCount(r)).toBe(1)
})
it('concurrent recovery before awaiting uses one durable global slot, across managers',async()=>{
  const r=await f();r.seed({stage:'activating',ownerPid:2147483647})
  let calls=0,release
  const options={launch:()=>{calls++;return new Promise(resolve=>release=resolve)}}
  const first=createDeliveryManager(r.data,r.controller,r.workspace,r.checks,options)
  const second=createDeliveryManager(r.data,r.controller,r.workspace,r.checks,options)
  const waiting=first.deliveryStatus(r.id,r.attemptId)
  expect((await second.deliveryStatus(r.id,r.attemptId)).ok).toBe(false)
  expect(calls).toBe(1)
  release(null)
  expect((await waiting).ok).toBe(true)
})
it('unknown live owner PID does not dispatch recovery',async()=>{
  const r=await f();r.seed({stage:'activating',ownerPid:process.ppid})
  let calls=0
  const manager=createDeliveryManager(r.data,r.controller,r.workspace,r.checks,{launch:()=>calls++})
  expect((await manager.deliveryStatus(r.id,r.attemptId)).ok).toBe(true)
  expect(calls).toBe(0)
})
it('missing admission acknowledgment refuses dispatch and preserves activating bytes',async()=>{
  const r=await f();r.seed({stage:'activating',ownerPid:2147483647})
  const io=Object.create(fs);let calls=0
  io.fsyncSync=()=>{throw Error('SYNTHETIC lost admission ack')}
  const manager=createDeliveryManager(r.data,r.controller,r.workspace,r.checks,{io,launch:()=>calls++})
  expect((await manager.deliveryStatus(r.id,r.attemptId)).ok).toBe(false)
  expect(calls).toBe(0)
  expect(r.store.read().records[0].stage).toBe('activating')
})
it('SYNTHETIC accelerated clock exercises genuine 300s recovery deadline; restart never retries uncertain work',async()=>{
  const r=await f();r.seed({stage:'activating',ownerPid:2147483647})
  let calls=0
  const options={launch:()=>{calls++;return new Promise(()=>{})}}
  const delays=[]
  const timed=syntheticModule(require.resolve('./self-modification-delivery.cjs'),{},{
    setTimeout:(fn,ms,...args)=>{delays.push(ms);return setTimeout(fn,ms===300000?30:ms,...args)},clearTimeout,
  }).createDeliveryManager
  const manager=timed(r.data,r.controller,r.workspace,r.checks,options)
  const result=await manager.deliveryStatus(r.id,r.attemptId)
  expect(result.ok).toBe(false)
  expect(result.error).toMatch(/deadline/)
  expect(delays).toContain(300000)
  expect((await createDeliveryManager(r.data,r.controller,r.workspace,r.checks,options).deliveryStatus(r.id,r.attemptId)).ok).toBe(false)
  expect(calls).toBe(1)
  expect(r.store.read().records[0].stage).toBe('activating')
})
