'use strict'

// This module runs in a separate trusted Node process. Candidate renderer code
// cannot read/write its journal, lock or installation target under native policy.
const fs = require('node:fs')
const path = require('node:path')
const {randomUUID} = require('node:crypto')
const {spawnSync} = require('node:child_process')
const tree = require('./self-modification-artifact.cjs')
const {keys,identity,decodeJournal} = require('./self-modification-schema.cjs')
const {createStore} = require('./self-modification-delivery-store.cjs')
const native = require('./self-modification-native.cjs')
const governance = require('./self-modification-policy.cjs')
const contract = require('./self-modification-native-contract.cjs')
const hex = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
function atomic(root,name,value) {
  tree.directory(root)
  const tmp = path.join(root,`.supervisor-${randomUUID()}`)
  const fd = fs.openSync(tmp,'wx',0o600)
  try {fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd)} finally {fs.closeSync(fd)}
  fs.renameSync(tmp,path.join(root,name))
  const dir = fs.openSync(root,'r')
  try {fs.fsyncSync(dir)} finally {fs.closeSync(dir)}
}
function target(root,{pendingOwner}={}) {
  if(!path.isAbsolute(root) || fs.realpathSync(root) !== root || root.split(path.sep).some(p=>p.endsWith('.app')))
    throw new Error('Only an explicit regular renderer target is supported; packaged/live app bundles are not modified')
  const stat = tree.directory(root)
  const value = JSON.parse(tree.readFile(path.join(root,'target.json'),4096).bytes)
  if(!keys(value,['version','kind','id','hostDigest','protectedDigest','storagePolicy','pendingWork','livePid']) ||
    value.version !== 1 || value.kind !== 'hermes-desk-renderer-target' || !identity(value.id) ||
    !hex(value.hostDigest) || !hex(value.protectedDigest) || value.storagePolicy !== 'immutable-compatibility-v1' ||
    value.pendingWork !== false || value.livePid !== null) throw new Error('Unknown migrations, pending work, or an in-use target are refused')
  const pending=require('./self-modification-consumer.cjs').work(root,value.id)
  if((pending.items.length||pending.owner!==null)&&(!pendingOwner||pending.owner?.id!==pendingOwner.id||pending.owner?.pid!==pendingOwner.pid||
    pending.items.some(item=>item!=='native-health')))
    throw new Error('Trusted consumer has pending work; target is not idle')
  return {value,stat}
}
function assertIdle(root,{lock}={}) {
  // Structured fd/inode evidence, not "-t" PID-only evidence. Exempt precisely
  // the supervisor's pinned activation.lock; never all files held by this PID.
  const result=spawnSync('/usr/sbin/lsof',['-nP','-F0pftDin','+D',root],
    {timeout:10000,encoding:'utf8',maxBuffer:65536,stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C'}})
  const {status,stdout:output}=result
  if(![0,1].includes(status)||result.signal||result.error||result.stderr||typeof output!=='string'||
    output&&!output.endsWith('\0\n'))throw new Error('Unknown/partial lsof idle evidence; target refused')
  if(!output) {if(status===1)return;throw new Error('Unknown empty lsof result')}
  let pid,entry
  const observed=[]
  function finish(){if(!entry)return
    if(!pid||!entry.f||entry.t!=='REG'||!/^(?:0x)?[a-f0-9]+$/i.test(entry.D||'')||
      !/^[0-9]+$/.test(entry.i||'')||!entry.n)throw new Error('Partial lsof file evidence; target refused')
    observed.push({pid,...entry});entry=null
  }
  for(const field of output.split('\0')){
    const value=field.replace(/^\n/,'')
    if(!value)continue
    const code=value[0],body=value.slice(1)
    if(code==='p'){finish();if(!/^[1-9][0-9]*$/.test(body))throw new Error('Invalid lsof PID');pid=Number(body)}
    else if(code==='f'){finish();entry={f:body}}
    else if(['t','D','i','n'].includes(code)&&entry&&entry[code]===undefined)entry[code]=body
    else throw new Error('Unknown lsof evidence; target refused')
  }
  finish()
  if(!observed.length)throw new Error('Partial lsof process evidence; target refused')
  for(const f of observed) {
    if(!lock||f.pid!==process.pid||f.f!==String(lock.fd)||f.n!==path.join(root,'activation.lock')||f.n!==lock.path||
      BigInt(f.D)!==BigInt(lock.dev)||BigInt(f.i)!==BigInt(lock.ino)||
      !tree.same(fs.fstatSync(lock.fd),fs.lstatSync(lock.path)))
      throw new Error('Renderer target is in use; no process was killed')
  }
}
async function initializeTarget(root, renderer, {hostDigest,protectedDigest}) {
  // Packaging/owned fixture primitive, deliberately not an IPC or auto-installer.
  if(!hex(hostDigest) || !hex(protectedDigest)) throw new Error('Missing protected compatibility identities')
  fs.mkdirSync(root,{mode:0o700})
  const current = await tree.capture(renderer,{maxFile:16*1024*1024})
  tree.materialize(path.join(root,'current'),current.files)
  atomic(root,'target.json',{version:1,kind:'hermes-desk-renderer-target',id:randomUUID(),hostDigest,protectedDigest,
    storagePolicy:'immutable-compatibility-v1',pendingWork:false,livePid:null})
  const id=JSON.parse(tree.readFile(path.join(root,'target.json'),4096).bytes).id
  atomic(root,'pending-work.json',{version:1,targetId:id,owner:null,items:[]})
}
function transaction(root) {
  const r = JSON.parse(tree.readFile(path.join(root,'transaction.json'),8192).bytes)
  const base=['version','id','versionId','state','nonce','artifactDigest','rendererDigest','previousDigest','targetDev','targetIno',
    'stage','previous','ownerPid','reason']
  const binding=['previousDev','previousIno','previousIdentityDigest','targetId','targetDigest','qualificationDigest','qualificationNonce','journalRevision','epoch','consumer']
  if(!keys(r,r.version===2?[...base,...binding]:base) || ![1,2].includes(r.version) || ![r.id,r.versionId,r.nonce].every(identity) ||
    !['intent','staged','swapped','accepted','rolled-back'].includes(r.state) ||
    ![r.artifactDigest,r.rendererDigest,r.previousDigest].every(hex) || r.stage !== `stage-${r.id}` ||
    r.previous !== `known-good-${r.id}` || ![r.targetDev,r.targetIno,r.ownerPid].every(Number.isSafeInteger) ||
    typeof r.reason !== 'string' || r.reason.length > 500) throw new Error('Unknown activation transaction; no replay')
  if(r.version===2&&(![r.previousDev,r.previousIno,r.journalRevision,r.epoch].every(v=>Number.isSafeInteger(v)&&v>=0)||
    ![r.targetId,r.qualificationNonce].every(identity)||![r.previousIdentityDigest,r.targetDigest,r.qualificationDigest].every(hex)||
    !keys(r.consumer,['targetId','versionId','nonce','artifactDigest','rendererDigest'])||
    r.consumer.targetId!==r.targetId||r.consumer.versionId!==r.versionId||r.consumer.nonce!==r.nonce||
    r.consumer.artifactDigest!==r.artifactDigest||r.consumer.rendererDigest!==r.rendererDigest))
    throw new Error('Unknown current recovery binding')
  return r
}
function recoveryAuthority(root,versionId,{userData}={}) {
  // CLOSED before filesystem authority, even at this direct exported boundary.
  if(!contract.phase2Available())throw new Error('Phase 2 recovery authority is not released')
  if(!contract.canonical(userData)||!identity(versionId))throw new Error('Current bound recovery admission required')
  const tx=transaction(root)
  if(tx.versionId!==versionId)throw new Error('Recovery version mismatch; no competing rollback or replay')
  const r=createStore(userData).read().records.find(r=>r.versionId===versionId)
  contract.assertAuthority(r?.qualification)
  const t=target(root,{pendingOwner:{id:tx.id,pid:tx.ownerPid}})
  const journal=decodeJournal(tree.readFile(path.join(userData,'self-modification/changes.json'),2*1024*1024).bytes)
  const c=journal.changes.find(c=>c.id===r.changeId),a=c?.attempts.at(-1),q=r.qualification
  if(tx.version!==2||tx.versionId!==versionId||!['approved','activating','accepted','rolled-back'].includes(r.stage)||
    !r.target||r.target.root!==root||!tree.same(t.stat,r.target)||!tree.same(t.stat,{dev:tx.targetDev,ino:tx.targetIno})||
    tx.targetId!==t.value.id||tx.targetDigest!==r.target.identityDigest||tx.targetDigest!==tree.sha(JSON.stringify(t.value))||
    tx.qualificationDigest!==tree.sha(JSON.stringify(q))||tx.qualificationNonce!==q.nonce||
    tx.artifactDigest!==q.artifactDigest||tx.rendererDigest!==q.rendererDigest||t.value.hostDigest!==q.hostDigest||
    tx.journalRevision!==r.journalRevision||journal.revision!==r.journalRevision||tx.epoch!==r.epoch||
    c?.cancellationEpoch!==r.epoch||a?.id!==r.attemptId||a?.epoch!==r.epoch||a?.state!=='checked'||
    a.validation?.sourceDigest!==q.sourceDigest||a.validation?.boundBuild?.artifact?.boundDigest!==q.boundDigest||
    a.validation?.seal?.artifact?.digest!==q.inputDigest||a.validation?.seal?.dependencyDigest!==q.dependencyDigest)
    throw new Error('Recovery version/target/revision/current proof binding mismatch')
  return {tx,t}
}
function treeIdentity(root) {
  const pinned=tree.directory(root),rows=[]
  function walk(folder,prefix,depth) {
    if(depth>24||rows.length>5000)throw Error('Known-good identity bounds exceeded')
    const parent=tree.directory(folder)
    for(const entry of fs.readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const name=prefix+entry.name,p=path.join(folder,entry.name),s=fs.lstatSync(p)
      if(s.isSymbolicLink()||!s.isDirectory()&&!s.isFile()||s.isFile()&&s.nlink!==1)
        throw Error('Unknown known-good tree identity')
      rows.push({path:name,dev:s.dev,ino:s.ino,mode:s.mode,size:s.isFile()?s.size:0})
      if(s.isDirectory())walk(p,name+'/',depth+1)
      if(!tree.same(s,fs.lstatSync(p)))throw Error('Known-good entry replaced')
    }
    if(!tree.same(parent,tree.directory(folder)))throw Error('Known-good directory replaced')
  }
  walk(root,'',0)
  if(!tree.same(pinned,tree.directory(root)))throw Error('Known-good root replaced')
  return tree.sha(JSON.stringify(rows))
}
async function knownGood(root,tx,name,check=()=>{}) {
  check()
  if(fs.realpathSync(root)!==root||!tree.same(tree.directory(root),{dev:tx.targetDev,ino:tx.targetIno}))
    throw new Error('Target was replaced; valuable state retained')
  const captured=await tree.capture(name,{maxFile:16*1024*1024,check})
  if(captured.digest!==tx.previousDigest||tx.version===2&&
    (!tree.same(captured.root,{dev:tx.previousDev,ino:tx.previousIno})||treeIdentity(name)!==tx.previousIdentityDigest))
    throw new Error('Known-good bytes/identity changed; manual recovery required')
  check()
  if(!tree.same(captured.root,tree.directory(name)))throw new Error('Known-good tree replaced')
  return captured
}
async function rollback(root, tx, reason,check=()=>{}) {
  const current = path.join(root,'current'), old = path.join(root,tx.previous)
  if(fs.realpathSync(root)!==root || !tree.same(tree.directory(root),{dev:tx.targetDev,ino:tx.targetIno}))
    throw new Error('Target was replaced; valuable state retained')
  if(fs.existsSync(old)) {
    await knownGood(root,tx,old,check)
    check()
    if(fs.existsSync(current)) {
      tree.directory(current)
      const rejected=path.join(root,`rejected-${tx.id}`)
      if(fs.existsSync(rejected))throw new Error('Unknown rejected bytes retained; no replacement')
      fs.renameSync(current,rejected)
    }
    fs.renameSync(old,current)
  } else if(!fs.existsSync(current)) throw new Error('Known-good target unavailable; no guessed cleanup')
  // Existence/state is NEVER a known-good acknowledgment, including an
  // interrupted intent with no old directory, and after both rename steps.
  await knownGood(root,tx,current,check)
  check()
  atomic(root,'transaction.json',{...tx,state:'rolled-back',reason:reason.slice(0,500)})
  atomic(root,`version-${tx.versionId}.json`,{...tx,state:'rolled-back',reason:reason.slice(0,500)})
}
async function recover(root,versionId,admission) {
  const {tx,t}=recoveryAuthority(root,versionId,admission)
  if(versionId!==undefined&&tx.versionId!==versionId) throw new Error('Recovery version mismatch; no competing rollback or replay')
  if(['accepted','rolled-back'].includes(tx.state)) {
    const versionReceipt=JSON.parse(tree.readFile(path.join(root,`version-${tx.versionId}.json`),8192).bytes)
    if(tree.sha(JSON.stringify(versionReceipt))!==tree.sha(JSON.stringify(tx)))
      throw new Error('Terminal transaction/version acknowledgment uncertain; manual recovery required')
    const expected=tx.state==='accepted'?tx.rendererDigest:tx.previousDigest
    if((await tree.capture(path.join(root,'current'),{maxFile:16*1024*1024})).digest!==expected)
      throw new Error('Terminal renderer bytes mutated; retained records do not authorize replay')
    if(tx.state==='rolled-back')await knownGood(root,tx,path.join(root,'current'))
    const lock=path.join(root,'activation.lock')
    if(fs.existsSync(lock)) {
      const owned=tree.readFile(lock,4096),owner=JSON.parse(owned.bytes)
      if(owner.id!==tx.id||owner.pid!==tx.ownerPid) throw new Error('Unknown terminal activation lock retained')
      try {process.kill(owner.pid,0);throw new Error('Terminal activation owner may still be alive')} catch(e) {
        if(e.code!=='ESRCH') throw e
      }
      if(!tree.same(owned.stat,fs.lstatSync(lock))) throw new Error('Terminal lock replaced')
      const receipt=path.join(root,`activation-lock-${tx.id}.completed`)
      if(fs.existsSync(receipt)) throw new Error('Existing terminal lock receipt retained')
      fs.renameSync(lock,receipt)
    }
    return tx
  }
  try {process.kill(tx.ownerPid,0);throw new Error('Activation owner may still be alive; no competing recovery')} catch(e) {
    if(e.code !== 'ESRCH') throw e
  }
  const lock = path.join(root,'activation.lock'), ownedLock=tree.readFile(lock,4096)
  const owner = JSON.parse(ownedLock.bytes)
  if(owner.id !== tx.id || owner.pid !== tx.ownerPid) throw new Error('Unknown activation lock retained; no competing rollback')
  const check=()=>{
    if(!tree.same(t.stat,tree.directory(root))||!tree.same(ownedLock.stat,fs.lstatSync(lock))||
      !tree.readFile(lock,4096).bytes.equals(ownedLock.bytes))throw new Error('Recovery target/lock changed; uncertain work retained')
    recoveryAuthority(root,versionId,admission)
  }
  await knownGood(root,tx,fs.existsSync(path.join(root,tx.previous))?path.join(root,tx.previous):path.join(root,'current'),check)
  const pending=require('./self-modification-consumer.cjs').work(root,t.value.id)
  if(pending.owner!==null) {
    // Only the interrupted fixed native-health work for this dead transaction
    // is known; never clear arbitrary user/application work.
    atomic(root,`consumer-work-${tx.id}.interrupted`,pending)
    atomic(root,'pending-work.json',{version:1,targetId:t.value.id,owner:null,items:[]})
  }
  // Never run unknown work. Any uncertain swap restores independently.
  await rollback(root,tx,'Supervisor restart: uncertain activation rolled back without replay',check)
  await knownGood(root,tx,path.join(root,'current'),check)
  if(!tree.same(ownedLock.stat,fs.lstatSync(lock))||!tree.readFile(lock,4096).bytes.equals(ownedLock.bytes))
    throw new Error('Recovery lock changed; retained without guessed cleanup')
  fs.unlinkSync(lock)
  return transaction(root)
}
async function activate(config, {health = native.qualify, idle = assertIdle, fault = () => {}, healthTimeoutMs = 240000} = {}) {
  const {userData,versionId,root,source,renderer,candidateRoot,signal} = config
  const store = createStore(userData)
  if(!Number.isSafeInteger(healthTimeoutMs)||healthTimeoutMs<1||healthTimeoutMs>240000)
    throw new Error('Unsupported supervisor health deadline')
  const journalPath = path.join(userData,'self-modification/changes.json')
  function fence() {
    if(signal.aborted) throw new Error('Activation cancelled')
    const r = store.read().records.find(r=>r.versionId===versionId)
    const journal = decodeJournal(tree.readFile(journalPath,2*1024*1024).bytes)
    const c = journal.changes.find(c=>c.id===r?.changeId), a = c?.attempts.at(-1)
    if(!r || !['approved','activating'].includes(r.stage) || !r.approval || Date.parse(r.approval.expiresAt)<=Date.now() ||
      r.approval.artifactDigest !== r.qualification?.artifactDigest || r.approval.reviewDigest !== r.reviewDigest ||
      journal.revision !== r.journalRevision || a?.id !== r.attemptId || a.state !== 'checked' ||
      c.cancellationEpoch !== r.epoch || a.epoch !== r.epoch) throw new Error('Stale, expired, cancelled or unapproved activation')
    const q=r.qualification,v=a.validation
    require('./self-modification-native-contract.cjs').assertAuthority(q)
    if(v?.stage!=='checked'||!v.checksPassed||v.sourceDigest!==q.sourceDigest||
      v.seal?.stage!=='sealed'||v.seal.artifact.digest!==q.inputDigest||
      v.boundBuild?.stage!=='passed'||v.boundBuild.artifact.boundDigest!==q.boundDigest||
      v.boundBuild.artifact.rendererDigest!==q.rendererDigest||v.seal.dependencyDigest!==q.dependencyDigest)
      throw new Error('Delivery qualification contradicts the acknowledged checks/build journal')
    return r
  }
  function journalCommit(action) {
    // Share the existing controller's exclusive writer lock. A cancellation
    // acknowledged before this linearization point always prevents the swap/
    // acceptance; competing journal writers cannot slip between its fence and
    // the synchronous consequential dispatch.
    const lock=path.join(userData,'self-modification/writer.lock')
    const fd=fs.openSync(lock,'wx',0o600),stat=fs.fstatSync(fd)
    try {
      fs.writeFileSync(fd,JSON.stringify({pid:process.pid,nonce:randomUUID()}));fs.fsyncSync(fd)
      fence()
      return action()
    } finally {
      fs.closeSync(fd)
      if(tree.same(stat,fs.lstatSync(lock))) fs.unlinkSync(lock)
    }
  }
  const r = fence(), t = target(root)
  try {
    const previous=transaction(root)
    if(previous.versionId===versionId) throw new Error('This version already has an external transaction; no duplicate activation or unknown-work replay')
    if(!['accepted','rolled-back'].includes(previous.state)) throw new Error('Unknown prior activation must be externally reconciled first')
    if(fs.existsSync(path.join(root,'activation.lock'))) await recover(root,previous.versionId,{userData})
  } catch(e) {if(e.code!=='ENOENT')throw e}
  if(!r.target || r.target.root !== root || !tree.same(t.stat,r.target) ||
    tree.sha(JSON.stringify(t.value))!==r.target.identityDigest) throw new Error('Exact selected target identity changed')
  if(t.value.hostDigest !== r.qualification.hostDigest) throw new Error('Protected native host identity mismatch')
  const protectedSource = await tree.capture(source,{exclude:['dist','node_modules']})
  if(governance.protectedDigest(protectedSource.manifest) !== t.value.protectedDigest)
    throw new Error('Persistence/build/native compatibility is immutable; unknown migrations refused')
  if((await tree.capture(candidateRoot)).digest !== r.qualification.sourceDigest ||
    protectedSource.digest !== r.qualification.sourceDigest ||
    governance.sourceIdentity(candidateRoot)!==r.qualification.sourceIdentityDigest) throw new Error('Candidate/source mutated after approval')
  const output = await tree.capture(renderer,{maxFile:16*1024*1024})
  if(output.digest !== r.qualification.rendererDigest) throw new Error('Approved renderer mutated')
  idle(root);fence()
  const id = randomUUID(), lock = path.join(root,'activation.lock')
  const lockFd = fs.openSync(lock,'wx',0o600)
  const lockIdentity=fs.fstatSync(lockFd)
  const lockOwned=()=>{
    if(!tree.same(t.stat,tree.directory(root))||!tree.same(lockIdentity,fs.lstatSync(lock)))
      throw new Error('Activation target or lock identity changed; no guessed cleanup')
    const owner=JSON.parse(tree.readFile(lock,4096).bytes)
    if(owner.id!==id||owner.pid!==process.pid) throw new Error('Activation lock contents changed')
  }
  let tx, swapped = false
  try {
    fs.writeFileSync(lockFd,JSON.stringify({id,pid:process.pid}));fs.fsyncSync(lockFd)
    const previous = await tree.capture(path.join(root,'current'),{maxFile:16*1024*1024})
    tx={version:2,id,versionId,state:'intent',nonce:randomUUID(),artifactDigest:r.qualification.artifactDigest,
      rendererDigest:output.digest,previousDigest:previous.digest,targetDev:t.stat.dev,targetIno:t.stat.ino,
      stage:`stage-${id}`,previous:`known-good-${id}`,ownerPid:process.pid,reason:'',
      previousDev:previous.root.dev,previousIno:previous.root.ino,previousIdentityDigest:treeIdentity(path.join(root,'current')),
      targetId:t.value.id,targetDigest:r.target.identityDigest,
      qualificationDigest:tree.sha(JSON.stringify(r.qualification)),qualificationNonce:r.qualification.nonce,
      journalRevision:r.journalRevision,epoch:r.epoch,consumer:null}
    tx.consumer={targetId:tx.targetId,versionId,nonce:tx.nonce,artifactDigest:tx.artifactDigest,rendererDigest:tx.rendererDigest}
    atomic(root,'transaction.json',tx) // Durable BEFORE stage or swap.
    fault('intent')
    lockOwned()
    tree.materialize(path.join(root,tx.stage),output.files)
    tx.state='staged';atomic(root,'transaction.json',tx);fault('stage')
    if((await tree.capture(path.join(root,tx.stage),{maxFile:16*1024*1024})).digest!==output.digest) throw new Error('Staged package mutation')
    fence();idle(root,{lock:{fd:lockFd,path:lock,dev:lockIdentity.dev,ino:lockIdentity.ino}})
    if(!tree.same(target(root).stat,t.stat) || tree.sha(JSON.stringify(target(root).value))!==r.target.identityDigest ||
      (await tree.capture(path.join(root,'current'),{maxFile:16*1024*1024})).digest!==previous.digest ||
      (await tree.capture(candidateRoot)).digest!==r.qualification.sourceDigest ||
      governance.sourceIdentity(candidateRoot)!==r.qualification.sourceIdentityDigest) throw new Error('Pre-swap source/target replacement')
    journalCommit(()=>{
      lockOwned()
      fs.renameSync(path.join(root,'current'),path.join(root,tx.previous))
      swapped=true
      fault('old-renamed')
      fs.renameSync(path.join(root,tx.stage),path.join(root,'current'))
      tx.state='swapped';atomic(root,'transaction.json',tx)
    })
    fault('swap')
    fence()
    const consumer=await require('./self-modification-consumer.cjs').open(root,{
      versionId,nonce:tx.nonce,artifactDigest:tx.artifactDigest,rendererDigest:output.digest,
      hostDigest:r.qualification.hostDigest,protectedDigest:t.value.protectedDigest},
      {lock:{fd:lockFd,id}})
    consumer.begin('native-health')
    const healthAbort=new AbortController()
    let timer, rejectHealth, lastFence=0
    const cancelHealth=()=>{
      healthAbort.abort()
      rejectHealth?.(new Error('Native health cancelled'))
    }
    signal.addEventListener('abort',cancelHealth,{once:true})
    let result
    try {
      const deadline=new Promise((_,reject)=>{
        rejectHealth=reject
        timer=setTimeout(()=>{healthAbort.abort();reject(new Error('Independent supervisor native health deadline expired'))},healthTimeoutMs)
      })
      result=await Promise.race([health({source,renderer:consumer.renderer,job:path.join(root,`health-${id}`),
        protectedProbe:path.join(root,'target.json'),signal:healthAbort.signal,startupNonce:tx.nonce,
        expectedArtifactDigest:tx.artifactDigest,expectedHostIdentity:r.qualification.hostIdentity,
        consumerBinding:consumer.binding,check:(force=false)=>{
          consumer.fence()
          lockOwned()
          if(force||Date.now()-lastFence>=50){lastFence=Date.now();fence()}
        }}),deadline])
    } finally {clearTimeout(timer);signal.removeEventListener('abort',cancelHealth);consumer.end('native-health');consumer.close()}
    fence()
    require('./self-modification-native-contract.cjs').validateStartup(result,{
      qualification:r.qualification,nonce:tx.nonce,artifactDigest:tx.artifactDigest,
      consumer:consumer.binding,job:path.join(root,`health-${id}`)})
    if(
      (await tree.capture(path.join(root,'current'),{maxFile:16*1024*1024})).digest!==output.digest ||
      governance.sourceIdentity(candidateRoot)!==r.qualification.sourceIdentityDigest)
      throw new Error('Versioned native startup/bridge health acknowledgment mismatch')
    journalCommit(()=>{
      lockOwned()
      if(tree.sha(JSON.stringify(target(root).value))!==r.target.identityDigest) throw new Error('Target metadata mutated during health')
      tx.state='accepted';atomic(root,'transaction.json',tx)
      atomic(root,`version-${tx.versionId}.json`,tx)
    })
    fault('accepted')
    return {state:'accepted',nonce:tx.nonce,artifactDigest:tx.artifactDigest,reason:'Exact qualified renderer retained; immutable protected host/persistence. Disposable native health only.'}
  } catch(e) {
    lockOwned()
    if(tx) {
      await rollback(root,tx,e.message,lockOwned)
      if((await tree.capture(path.join(root,'current'),{maxFile:16*1024*1024})).digest!==tx.previousDigest)
        throw new Error('Rollback identity mismatch; retained transaction requires manual recovery')
      return {state:'rolled-back',nonce:tx.nonce,artifactDigest:tx.artifactDigest,reason:e.message.slice(0,500)}
    }
    throw e
  } finally {
    fs.closeSync(lockFd)
    try {
      lockOwned()
      if(!tx)fs.unlinkSync(lock)
      else {
        const terminal=transaction(root)
        if(terminal.state==='rolled-back')await knownGood(root,terminal,path.join(root,'current'),lockOwned)
        else if(terminal.state==='accepted') {
          if((await tree.capture(path.join(root,'current'),{check:lockOwned})).digest!==terminal.rendererDigest)
            throw new Error('Terminal accepted bytes changed')
        } else throw new Error('Uncertain transaction retains lock')
        lockOwned();fs.unlinkSync(lock)
      }
    } catch { /* Unknown/replaced authority and uncertain transactions are retained. */ }
  }
}
module.exports = {activate,recover,recoveryAuthority,initializeTarget,target,assertIdle,atomic,transaction,treeIdentity,
  validateStartup:require('./self-modification-native-contract.cjs').validateStartup}
