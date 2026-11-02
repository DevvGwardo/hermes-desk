// Real files/process leases and default macOS lsof. Health remains synthetic.
import {afterEach,describe,expect,it} from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {fixture,supervisor,tree} from './self-modification-fixture.test.support.mjs'
const require=createRequire(import.meta.url),consumer=require('./self-modification-consumer.cjs')
const roots=[]
afterEach(()=>{for(const r of roots.splice(0))fs.rmSync(r,{recursive:true,force:true})})
async function setup(){const f=await fixture({currentNativeSynthetic:true});roots.push(f.root);f.seed();return f}
const binding=async f=>({versionId:f.record.versionId,nonce:randomUUID(),artifactDigest:f.q.artifactDigest,
  rendererDigest:(await tree.capture(path.join(f.config.root,'current'))).digest,
  hostDigest:f.q.hostDigest,protectedDigest:supervisor.target(f.config.root).value.protectedDigest})
describe('actionable owned renderer-target consumption/lease integration',()=>{
  it('default idle route accepts and records actual consumed version/nonce (synthetic native health)',async()=>{
    const f=await setup()
    const result=await supervisor.activate(f.config,{health:async input=>{
      const pending=consumer.work(f.config.root,JSON.parse(fs.readFileSync(path.join(f.config.root,'target.json'))).id)
      expect(pending.items).toEqual(['native-health'])
      expect(input.expectedHostIdentity).toEqual(f.q.hostIdentity)
      expect(input.consumerBinding.versionId).toBe(f.record.versionId)
      expect(input.renderer).toBe(path.join(f.config.root,'current'))
      const receipt=JSON.parse(fs.readFileSync(path.join(f.config.root,`consumer-${pending.owner.id}.json`)))
      expect(receipt.binding.rendererDigest).toBe(f.q.rendererDigest)
      return f.health(input)
    }})
    expect(result.state).toBe('accepted')
    expect(fs.existsSync(path.join(f.config.root,'activation.lock'))).toBe(false)
    expect(consumer.work(f.config.root,JSON.parse(fs.readFileSync(path.join(f.config.root,'target.json'))).id).items).toEqual([])
    const tx=supervisor.transaction(f.config.root)
    const foreground=await consumer.open(f.config.root,{...await binding(f),nonce:tx.nonce,versionId:tx.versionId,
      artifactDigest:tx.artifactDigest,rendererDigest:tx.rendererDigest})
    expect(fs.readFileSync(path.join(foreground.renderer,'index.html'),'utf8')).toContain('candidate')
    expect(foreground.binding.nonce).toBe(result.nonce)
    foreground.close()
  })
  it('live owned consumer refuses activation without killing it; explicit release permits default activation',async()=>{
    const f=await setup(),lease=await consumer.open(f.config.root,await binding(f),{trustedBootstrap:true})
    const bytes=fs.readFileSync(path.join(lease.renderer,'index.html'),'utf8')
    expect(bytes).toContain('known-good')
    await expect(supervisor.activate(f.config,{health:f.health})).rejects.toThrow(/pending|exist|use|lock/)
    expect(()=>process.kill(process.pid,0)).not.toThrow()
    lease.close()
    expect((await supervisor.activate(f.config,{health:f.health})).state).toBe('accepted')
  })
  it('trusted pending-work prevents idle/release even with an empty-looking renderer',async()=>{
    const f=await setup(),lease=await consumer.open(f.config.root,await binding(f),{trustedBootstrap:true})
    lease.begin('owned-unsaved-draft')
    expect(()=>supervisor.target(f.config.root)).toThrow(/pending/)
    expect(()=>lease.close()).toThrow(/Pending/)
    expect(fs.existsSync(path.join(f.config.root,'activation.lock'))).toBe(true)
    lease.end('owned-unsaved-draft');lease.close()
    expect(supervisor.target(f.config.root).value.pendingWork).toBe(false)
  })
  it.each(['runtime','host-version','consumer-version','consumer-nonce'])('refuses unbound %s health even with a matching artifact claim',async field=>{
    const f=await setup()
    const result=await supervisor.activate(f.config,{health:async input=>{
      const r=structuredClone(await f.health(input))
      if(field==='runtime')r.runtime.sha256='9'.repeat(64)
      if(field==='host-version')r.hostIdentity.version='different'
      if(field==='consumer-version')r.consumer.versionId=randomUUID()
      if(field==='consumer-nonce')r.consumer.nonce=randomUUID()
      return r
    }})
    expect(result.state).toBe('rolled-back')
    expect(fs.readFileSync(path.join(f.config.root,'current/index.html'),'utf8')).toContain('known-good')
  })
})
