'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {randomUUID} = require('node:crypto')
const {spawn} = require('node:child_process')
const tree = require('./self-modification-artifact.cjs')
const native = require('./self-modification-native.cjs')
const supervisor = require('./self-modification-supervisor.cjs')
const {createStore} = require('./self-modification-delivery-store.cjs')
const {identity} = require('./self-modification-schema.cjs')
const governance = require('./self-modification-policy.cjs')
const contract=require('./self-modification-native-contract.cjs')
const fail = message => {throw Object.assign(new Error(message),{deliveryCode:'stale'})}
function createDeliveryManager(userData, controller, workspace, validation, {confirm, chooseTarget,
  qualify=native.qualify, launch=launchSupervisor, io=fs}={}) {
  const store=createStore(userData,io), active=new Map()
  const recovery=require('./self-modification-recovery-admission.cjs').admission(userData,io)
  let pending=false
  function current(revision,id,attemptId) {
    const s=controller.list(),c=s.changes?.find(c=>c.id===id),a=c?.attempts.at(-1)
    if(!s.ok || s.revision!==revision || !identity(id) || !identity(attemptId) || a?.id!==attemptId ||
      a.state!=='checked' || a.epoch!==c.cancellationEpoch) fail('Reload the exact checked attempt. Cancellation invalidates all authority.')
    return {s,c,a}
  }
  function records(id,attemptId) {return store.read().records.filter(r=>r.changeId===id&&r.attemptId===attemptId)}
  function latest(id,attemptId) {return records(id,attemptId).at(-1)}
  function update(versionId,patch) {
    const s=store.read()
    return store.mutate(s.revision,records=>{
      const r=records.find(r=>r.versionId===versionId)
      if(!r) fail('Delivery identity disappeared')
      Object.assign(r,patch,{updatedAt:new Date().toISOString()})
    })
  }
  function fence(r,authorize=()=>{}) {
    authorize()
    if(r.qualification)contract.assertAuthority(r.qualification)
    else if(!contract.phase2Available())fail('Phase 2 authority is not released')
    const {a}=current(r.journalRevision,r.changeId,r.attemptId)
    const now=latest(r.changeId,r.attemptId)
    if(now?.versionId!==r.versionId || now.epoch!==a.epoch || ['cancelled','failed','rejected'].includes(now.stage))
      fail('Delivery was cancelled or superseded')
  }
  async function inputs(r,authorize=()=>{}) {
    fence(r,authorize)
    if(r.qualification) {
      const root=await workspace.candidateRoot(r.changeId,r.attemptId)
      if(governance.sourceIdentity(root)!==r.qualification.sourceIdentityDigest) {
        update(r.versionId,{stage:'failed',reviewDigest:null,approval:null,target:null,error:'Candidate identity/metadata changed after qualification. All review/approval authority was invalidated.'})
        fail('Candidate identity changed after qualification; restored bytes do not restore approval')
      }
    }
    const inputs=await validation.qualificationInputs(r.journalRevision,r.changeId,r.attemptId,()=>fence(r,authorize))
    if(r.qualification && (inputs.sourceDigest!==r.qualification.sourceDigest ||
      inputs.rendererDigest!==r.qualification.rendererDigest || inputs.boundDigest!==r.qualification.boundDigest ||
      inputs.inputDigest!==r.qualification.inputDigest)) fail('Qualified artifact mutated; review and approval are invalid')
    fence(r,authorize)
    return inputs
  }
  async function reviewRecord(r,authorize) {
    if(!['qualified','approved'].includes(r?.stage)) fail('An acknowledged native-qualified artifact is required')
    contract.assertAuthority(r.qualification)
    const input=await inputs(r,authorize),review=await workspace.review(r.changeId,r.attemptId)
    if(!review.ok) fail(review.error)
    governance.verifyDiff(review.files)
    const changed=review.files.filter(f=>f.status!=='unchanged')
    if(!changed.length || changed.some(f=>f.binary||f.truncated||f.diff===null))
      fail('Exact complete textual diff is required; binary, truncated or empty proposals cannot be approved')
    const {c,a}=current(r.journalRevision,r.changeId,r.attemptId)
    const detail={versionId:r.versionId,changeId:r.changeId,attemptId:r.attemptId,request:c.request,acceptanceCriteria:c.acceptanceCriteria,
      scope:r.scope,artifactDigest:r.qualification.artifactDigest,
      journalRevision:r.journalRevision,epoch:r.epoch,baseline:a.preparation.source,
      changes:changed,checks:['fixed TypeScript','fixed syntax','fixed Vite','copied graph binding','native hardened window',
        'actual fixed primary-frame bridge','multiple disposable renderer health samples','kernel isolation denial probes'],
      qualification:r.qualification,healthScope:'Disposable native UI and fixed bridge. Not user acceptance criteria, live provider, live storage or full application qualification.',
      storageScope:'Immutable protected persistence/native/dependency/build identities; unknown migrations refused.',
      catalogScope:'Generated UI uses a trusted data-only catalog, not JavaScript extension, plugin or activation permissions.'}
    const digest=tree.sha(JSON.stringify(detail))
    fence(r,authorize)
    return {detail,digest,input}
  }
  async function result(action) {
    try {return {ok:true,...await action()}} catch(e) {
      return {ok:false,code:e.deliveryCode||'storage',error:e.deliveryCode?e.message:
        `Frontend delivery refused: ${e.message}`.slice(0,500)}
    }
  }
  async function exclusive(action) {
    if(pending||active.size) fail('One delivery operation is already active; unknown work is never replayed')
    pending=true
    try {return await action()} finally {pending=false}
  }
  const manager={
    deliveryStatus:(id,attemptId,authorize=()=>{})=>result(async()=>{
      authorize()
      if(!identity(id)||!identity(attemptId)) fail('Invalid attempt identity')
      for(const r of records(id,attemptId)) {
        if(!['qualifying','activating'].includes(r.stage)||active.has(r.versionId)) continue
        // Historical proofs remain visible, never dispatch/rewrite them.
        if(!contract.phase2Available()||r.qualification?.version===1)continue
        let dead=r.ownerPid===process.pid
        try {process.kill(r.ownerPid,0)} catch(e) {dead=e.code==='ESRCH'}
        if(!dead) continue
        if(r.stage==='activating' && r.target) {
          // Recovery dispatch is trusted and bounded; never replay activation.
          authorize()
          contract.assertAuthority(r.qualification)
          if(pending||active.size)fail('Recovery is already pending; status never queues repeated dispatch')
          const admission=recovery.reserve(r) // Durable BEFORE launch/await.
          const abort=new AbortController()
          let recovered,timer
          pending=true
          try {
            const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{
              abort.abort();reject(Error('Recovery acknowledgment deadline; uncertain work retained'))
            },300000)})
            recovered=await Promise.race([launch({action:'recover',root:r.target.root,userData,versionId:r.versionId},abort.signal),deadline])
          } catch(error) {
            if(error.dispatchNotStarted===true)recovery.finish(admission,error)
            update(r.versionId,{error:'Manual recovery required: dispatch/acknowledgment failed; no status retry.'})
            throw error
          } finally {clearTimeout(timer);pending=false}
          authorize()
          if(recovered && (recovered.versionId!==r.versionId||recovered.artifactDigest!==r.qualification.artifactDigest))
            fail('Recovery receipt belongs to a different version or artifact; unknown work retained')
          if(recovered?.state==='accepted') update(r.versionId,{stage:'accepted',outcome:{state:'accepted',
            nonce:recovered.nonce,artifactDigest:recovered.artifactDigest,reason:'Durably accepted external supervisor record reconciled; no replay'}})
          else if(recovered?.state==='rolled-back') update(r.versionId,{stage:'rolled-back',outcome:{state:'rolled-back',
            nonce:recovered.nonce,artifactDigest:recovered.artifactDigest,reason:recovered.reason}})
          else update(r.versionId,{stage:'failed',approval:null,error:'Activation intent had no acknowledged external transaction. Nothing was replayed.'})
          recovery.finish(admission,null)
        } else update(r.versionId,{stage:'failed',approval:null,error:'Native qualification acknowledgment was lost; retained work was not replayed.'})
      }
      authorize()
      return {records:records(id,attemptId),authorityAvailable:contract.phase2Available(),
        historicalReadOnly:!contract.phase2Available()}
    }),
    qualify:(revision,id,attemptId,authorize=()=>{})=>result(()=>exclusive(async()=>{
      if(!contract.phase2Available())fail('Phase 2 authority is not released')
      const {a}=current(revision,id,attemptId)
      if(latest(id,attemptId)) fail('A delivery intent already exists for this attempt. Reopen a cancelled attempt to make a new version.')
      authorize()
      const allowed=await confirm({kind:'qualify',scope:'frontend-only-v1',sourceDigest:a.validation.sourceDigest})
      current(revision,id,attemptId);authorize()
      if(!allowed) return {records:records(id,attemptId)}
      const now=new Date().toISOString()
      const r={versionId:randomUUID(),changeId:id,attemptId,epoch:a.epoch,journalRevision:revision,stage:'qualifying',
        scope:'frontend-only-v1',ownerPid:process.pid,createdAt:now,updatedAt:now,qualification:null,
        reviewDigest:null,approval:null,target:null,outcome:null,error:null}
      const s=store.read()
      store.mutate(s.revision,records=>records.push(r)) // Intent BEFORE copying or native dispatch.
      const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),240000)
      active.set(r.versionId,abort)
      try {
        const input=await inputs(r,authorize)
        const candidateRoot=await workspace.candidateRoot(id,attemptId),sourceIdentityDigest=governance.sourceIdentity(candidateRoot)
        let lastFence=0
        const q=await qualify({...input,job:path.join(userData,'self-modification',`native-${r.versionId}`),
          protectedProbe:path.join(userData,'self-modification','changes.json'),signal:abort.signal,check:(force=false)=>{
            if(force||Date.now()-lastFence>=50){lastFence=Date.now();fence(r,authorize)}
          }})
        await inputs(r,authorize)
        if(governance.sourceIdentity(candidateRoot)!==sourceIdentityDigest) fail('Candidate identity changed during native qualification')
        if(abort.signal.aborted) fail('Native qualification was cancelled or expired')
        update(r.versionId,{stage:'qualified',qualification:{...q,boundDigest:input.boundDigest,inputDigest:input.inputDigest,sourceIdentityDigest}})
      } catch(e) {
        const now=latest(id,attemptId)
        if(now?.stage==='qualifying') update(r.versionId,{stage:abort.signal.aborted?'cancelled':'failed',error:e.message.slice(0,500)})
        throw e
      } finally {clearTimeout(timer);active.delete(r.versionId)}
      return {records:records(id,attemptId)}
    })),
    deliveryReview:(revision,id,attemptId,authorize=()=>{})=>result(async()=>{
      if(!contract.phase2Available())fail('Phase 2 authority is not released')
      current(revision,id,attemptId)
      const r=latest(id,attemptId),review=await reviewRecord(r,authorize)
      update(r.versionId,{reviewDigest:review.digest,approval:null,stage:'qualified'})
      return {review:{...review.detail,reviewDigest:review.digest},records:records(id,attemptId)}
    }),
    approve:(revision,id,attemptId,versionId,reviewDigest,authorize=()=>{})=>result(()=>exclusive(async()=>{
      if(!contract.phase2Available())fail('Phase 2 authority is not released')
      current(revision,id,attemptId)
      const r=latest(id,attemptId)
      if(r?.versionId!==versionId||r.reviewDigest!==reviewDigest||r.stage!=='qualified') fail('Review the exact version and complete diff first')
      const review=await reviewRecord(r,authorize)
      if(review.digest!==reviewDigest) fail('Review identity changed')
      const approved=await confirm({kind:'approve',review:review.detail,reviewDigest})
      const again=await reviewRecord(r,authorize)
      if(again.digest!==reviewDigest) fail('Artifact/review changed during native consent')
      update(versionId,approved?{stage:'approved',approval:{id:randomUUID(),artifactDigest:r.qualification.artifactDigest,
        reviewDigest,expiresAt:new Date(Date.now()+15*60*1000).toISOString()}}:{stage:'rejected',approval:null})
      return {records:records(id,attemptId)}
    })),
    selectActivationTarget:(revision,id,attemptId,versionId,authorize=()=>{})=>result(()=>exclusive(async()=>{
      if(!contract.phase2Available())fail('Phase 2 authority is not released')
      current(revision,id,attemptId)
      const r=latest(id,attemptId)
      if(r?.versionId!==versionId||r.stage!=='approved'||Date.parse(r.approval.expiresAt)<=Date.now()) fail('Unexpired exact-artifact native approval is required')
      const input=await inputs(r,authorize),root=await chooseTarget()
      fence(r,authorize)
      if(!root) return {records:records(id,attemptId)}
      const t=supervisor.target(root)
      if(t.value.hostDigest!==r.qualification.hostDigest ||
        t.value.protectedDigest!==governance.protectedDigest((await tree.capture(input.source,{exclude:['dist','node_modules']})).manifest))
        fail('Target protected host/persistence/build compatibility does not match the artifact')
      supervisor.assertIdle(root);fence(r,authorize)
      update(versionId,{target:{root,dev:t.stat.dev,ino:t.stat.ino,identityDigest:tree.sha(JSON.stringify(t.value))}})
      return {records:records(id,attemptId)}
    })),
    activate:(revision,id,attemptId,versionId,authorize=()=>{})=>result(()=>exclusive(async()=>{
      if(!contract.phase2Available())fail('Phase 2 authority is not released')
      if(store.read().records.some(record=>record.stage==='activating'))
        fail('A prior activation outcome is unknown; explicitly reconcile it before any new activation')
      current(revision,id,attemptId)
      const r=latest(id,attemptId)
      if(r?.versionId!==versionId||r.stage!=='approved'||!r.target||Date.parse(r.approval.expiresAt)<=Date.now()) fail('Select an idle compatible target for this exact approved artifact')
      const input=await inputs(r,authorize)
      const allowed=await confirm({kind:'activate',record:r})
      await inputs(r,authorize)
      if(!allowed) return {records:records(id,attemptId)}
      update(versionId,{stage:'activating',ownerPid:process.pid})
      const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),300000)
      active.set(versionId,abort)
      try {
        const candidateRoot=await workspace.candidateRoot(id,attemptId)
        const outcome=await launch({action:'activate',userData,versionId,root:r.target.root,source:input.source,
          renderer:input.renderer,candidateRoot},abort.signal)
        update(versionId,{stage:outcome.state==='accepted'?'accepted':'rolled-back',outcome,error:null})
      } catch(e) {
        // Never convert an unknown swap into success, and never replay it.
        update(versionId,{error:`External supervisor acknowledgment unknown: ${e.message}`.slice(0,500)})
        throw e
      } finally {clearTimeout(timer);active.delete(versionId)}
      return {records:records(id,attemptId)}
    })),
    cancel(id,attemptId) {
      const r=latest(id,attemptId)
      if(!r) return
      if(!contract.phase2Available()||r.qualification?.version===1)return
      active.get(r.versionId)?.abort()
      // Activation retains its recovery intent until external rollback finishes.
      if(!['accepted','rolled-back','activating'].includes(r.stage)) update(r.versionId,{stage:'cancelled',approval:null})
    },
  }
  return manager
}
async function launchSupervisor(input,signal) {
  if(!contract.phase2Available())throw Error('Phase 2 authority is not released; no external worker dispatch')
  const bin=require('./bin-guard.cjs').resolveTrustedBin('node',{extraDirs:['/opt/homebrew/bin','/usr/local/bin']})
  if(!bin.ok) throw new Error('A trusted external Node supervisor runtime is required; no install or fallback')
  const worker=await require('./self-modification-host.cjs').stageWorker(input.userData,__dirname)
  if(signal.aborted)throw Error('External dispatch cancelled before trusted worker launch')
  const child=spawn(bin.bin,[worker.entry],{
    cwd:worker.folder,env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},stdio:['pipe','pipe','pipe'],detached:true})
  let out='',diagnostic='',size=0,expired=false
  const cancel=()=>{if(child.exitCode===null) child.kill('SIGTERM')}
  const timer=setTimeout(()=>{expired=true;cancel()},310000)
  const killTimer=setTimeout(()=>{if(child.exitCode===null) child.kill('SIGKILL')},330000)
  signal.addEventListener('abort',cancel,{once:true})
  child.stdout.on('data',c=>{size+=c.length;if(size>65536) cancel();else out+=c})
  child.stderr.on('data',c=>{if(diagnostic.length<65536) diagnostic+=c})
  child.stdin.on('error',()=>{})
  child.stdin.end(JSON.stringify(input))
  try {
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
    const reply=JSON.parse(out)
    if(code!==0||!reply.ok||expired||size>65536) throw new Error(reply.error||'External supervisor failed')
    return reply.result
  } finally {clearTimeout(timer);clearTimeout(killTimer);signal.removeEventListener('abort',cancel)}
}
module.exports={createDeliveryManager,launchSupervisor}
