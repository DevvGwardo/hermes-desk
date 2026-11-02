// Unit contracts use explicit synthetic native observations. S1 remains blocked
// until the separate real Electron/no-live-authority fixture passes.
import {afterEach,describe,expect,it,vi} from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {fixture,createDeliveryManager,createStore,decode,syntheticQualification} from './self-modification-fixture.test.support.mjs'
const roots=[]
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})})
async function setup(options={}) {
  const f=await fixture({currentNativeSynthetic:true});roots.push(f.root)
  const confirm=options.confirm||vi.fn(async()=>true)
  const qualify=options.qualify||vi.fn(async input=>{
    expect(f.store.read().records.at(-1).stage).toBe('qualifying')
    const {boundDigest,inputDigest,sourceIdentityDigest,...q}=syntheticQualification(f.q,input.job)
    return q
  })
  const manager=createDeliveryManager(f.data,f.controller,f.workspace,f.checks,{confirm,qualify,
    chooseTarget:async()=>f.config.root,...options})
  return {...f,manager,qualify,confirm}
}
describe('durable frontend delivery controller contracts (not native acceptance)',()=>{
  it('persists intent before qualification, exact version review before native approval, with immutable scope',async()=>{
    const f=await setup()
    expect((await f.manager.qualify(1,f.id,f.attemptId)).ok).toBe(true)
    expect(f.qualify).toHaveBeenCalledOnce()
    const r=f.store.read().records[0]
    expect(r.stage).toBe('qualified')
    expect(r.versionId).not.toBe(r.qualification.nonce)
    expect(r.scope).toBe('frontend-only-v1')
    expect((await f.manager.approve(1,f.id,f.attemptId,r.versionId,'a'.repeat(64))).ok).toBe(false)
    const reviewed=await f.manager.deliveryReview(1,f.id,f.attemptId)
    expect(reviewed.ok).toBe(true)
    expect(reviewed.review.healthScope).toMatch(/not.*live.*full application/i)
    expect(reviewed.review.changes[0].diff).toContain('+candidate')
    expect((await f.manager.approve(1,f.id,f.attemptId,r.versionId,reviewed.review.reviewDigest)).ok).toBe(true)
    expect(f.store.read().records[0].stage).toBe('approved')
    expect(f.store.read().records[0].approval.expiresAt).toBeTruthy()
  })
  it('declined independent native approval is a retained rejected version, not activation authority',async()=>{
    const f=await setup({confirm:async input=>input.kind!=='approve'})
    await f.manager.qualify(1,f.id,f.attemptId)
    const review=await f.manager.deliveryReview(1,f.id,f.attemptId),r=f.store.read().records[0]
    await f.manager.approve(1,f.id,f.attemptId,r.versionId,review.review.reviewDigest)
    expect(f.store.read().records[0]).toMatchObject({stage:'rejected',approval:null})
    expect((await f.manager.activate(1,f.id,f.attemptId,r.versionId)).ok).toBe(false)
  })
  it('does not dispatch when initial delivery intent fails to persist',async()=>{
    const f=await setup(),io=Object.create(fs)
    io.writeFileSync=(fd,bytes,...rest)=>{
      if(String(bytes).includes('\"records\":'))throw new Error('owned fixture disk failure')
      return fs.writeFileSync(fd,bytes,...rest)
    }
    const manager=createDeliveryManager(f.data,f.controller,f.workspace,f.checks,{io,confirm:async()=>true,qualify:f.qualify})
    expect((await manager.qualify(1,f.id,f.attemptId)).ok).toBe(false)
    expect(f.qualify).not.toHaveBeenCalled()
    expect(f.store.read().records).toEqual([])
  })
  it('lost qualification final acknowledgment reconciles as failed without dispatch replay',async()=>{
    const f=await setup(),io=Object.create(fs)
    io.writeFileSync=(fd,bytes,...rest)=>{
      if(/\"stage\":\"(?:qualified|failed)\"/.test(String(bytes)))throw new Error('lost fixture acknowledgment')
      return fs.writeFileSync(fd,bytes,...rest)
    }
    const manager=createDeliveryManager(f.data,f.controller,f.workspace,f.checks,{io,confirm:async()=>true,qualify:f.qualify})
    expect((await manager.qualify(1,f.id,f.attemptId)).ok).toBe(false)
    expect(f.store.read().records[0].stage).toBe('qualifying')
    const restarted=createDeliveryManager(f.data,f.controller,f.workspace,f.checks,{qualify:f.qualify})
    expect((await restarted.deliveryStatus(f.id,f.attemptId)).records[0].stage).toBe('failed')
    expect(f.qualify).toHaveBeenCalledOnce()
  })
  it('cancellation fences a late native result and never creates a qualified grant',async()=>{
    let release,entered
    const ready=new Promise(r=>entered=r),hold=new Promise(r=>release=r)
    const f=await setup({qualify:async()=>{entered();await hold;return f.q}})
    const running=f.manager.qualify(1,f.id,f.attemptId)
    await ready
    expect(f.controller.cancel(1,f.id,f.attemptId).ok).toBe(true)
    f.manager.cancel(f.id,f.attemptId)
    release()
    expect((await running).ok).toBe(false)
    expect(f.store.read().records[0]).toMatchObject({stage:'cancelled',qualification:null,approval:null})
  })
  it.each(['bytes','restored-bytes','replacement'])('candidate %s mutation permanently invalidates review/approval',async kind=>{
    const f=await setup();await f.manager.qualify(1,f.id,f.attemptId)
    const review=await f.manager.deliveryReview(1,f.id,f.attemptId),r=f.store.read().records[0]
    await f.manager.approve(1,f.id,f.attemptId,r.versionId,review.review.reviewDigest)
    const file=path.join(f.source,'src/components/Note.tsx'),before=fs.readFileSync(file)
    if(kind==='replacement'){fs.renameSync(file,file+'.retained');fs.writeFileSync(file,before,{mode:0o600});fs.unlinkSync(file+'.retained')}
    else {fs.appendFileSync(file,'changed');if(kind==='restored-bytes')fs.writeFileSync(file,before)}
    expect((await f.manager.selectActivationTarget(1,f.id,f.attemptId,r.versionId)).ok).toBe(false)
    expect(f.store.read().records[0]).toMatchObject({stage:'failed',approval:null,reviewDigest:null,target:null})
  })
  it('navigation during independent native approval prevents the grant',async()=>{
    let navigated=false
    const f=await setup({confirm:async input=>{if(input.kind==='approve')navigated=true;return true}})
    await f.manager.qualify(1,f.id,f.attemptId)
    const reviewed=await f.manager.deliveryReview(1,f.id,f.attemptId),r=f.store.read().records[0]
    expect((await f.manager.approve(1,f.id,f.attemptId,r.versionId,reviewed.review.reviewDigest,
      ()=>{if(navigated)throw new Error('owned caller navigated')})).ok).toBe(false)
    expect(f.store.read().records[0].approval).toBeNull()
  })
  it('unknown delivery schema preserves its exact bytes and cannot mint authority',async()=>{
    const f=await setup(),file=path.join(f.data,'self-modification/deliveries.json')
    const raw='{\"version\":999,\"revision\":0,\"records\":[]}'
    fs.writeFileSync(file,raw)
    expect((await f.manager.qualify(1,f.id,f.attemptId)).ok).toBe(false)
    expect(fs.readFileSync(file,'utf8')).toBe(raw)
    expect(f.qualify).not.toHaveBeenCalled()
  })
  it.each([q=>{q.nativeWindow='yes'},q=>{q.fullAppQualified=true},q=>{q.kernelDenials.fork=false},
    q=>{q.scope='full-app'},q=>{q.healthSamples=0},q=>{q.sourceIdentityDigest=null}])('strict schema rejects invented native/expanded authority',async corrupt=>{
    const f=await setup(),record=structuredClone(f.record)
    corrupt(record.qualification)
    expect(()=>decode(JSON.stringify({version:1,revision:1,records:[record]}))).toThrow()
  })
  it('refuses concurrent qualification and duplicate or unknown intent replay',async()=>{
    let entered,release
    const ready=new Promise(r=>entered=r),hold=new Promise(r=>release=r)
    const f=await setup({qualify:async input=>{entered();await hold;const {boundDigest,inputDigest,sourceIdentityDigest,...q}=f.q;return {...q,job:input.job}}})
    const running=f.manager.qualify(1,f.id,f.attemptId);await ready
    expect((await f.manager.qualify(1,f.id,f.attemptId)).ok).toBe(false)
    release();await running
    expect((await f.manager.qualify(1,f.id,f.attemptId)).ok).toBe(false)
    expect(f.store.read().records).toHaveLength(1)
  })
  it('preserves dead writer receipt and reconciles without losing records or replay',async()=>{
    const f=await setup(),id=randomUUID()
    fs.writeFileSync(path.join(f.data,'self-modification/delivery.lock'),JSON.stringify({version:1,id,pid:2147483647}))
    const store=createStore(f.data)
    store.mutate(0,()=>{})
    expect(fs.existsSync(path.join(f.data,'self-modification',`delivery-lock-${id}.interrupted`))).toBe(true)
    expect(store.read().revision).toBe(1)
  })
})
