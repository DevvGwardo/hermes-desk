'use strict'
// Trusted disposable renderer-target consumer. No API is given to candidate
// code to claim idle, clear work, mint an artifact/version, or release a lease.
const fs=require('node:fs')
const path=require('node:path')
const {randomUUID}=require('node:crypto')
const tree=require('./self-modification-artifact.cjs')
const {keys,identity}=require('./self-modification-schema.cjs')
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
function work(root,targetId) {
  const value=JSON.parse(tree.readFile(path.join(root,'pending-work.json'),16384).bytes)
  if(!keys(value,['version','targetId','owner','items'])||value.version!==1||value.targetId!==targetId||
    !Array.isArray(value.items)||value.items.length>128||!value.items.every(x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(x))||
    new Set(value.items).size!==value.items.length||
    value.owner!==null&&(!keys(value.owner,['id','pid'])||!identity(value.owner.id)||!Number.isSafeInteger(value.owner.pid)||value.owner.pid<1))
    throw Error('Unknown consumer/pending work; target refused')
  return value
}
async function open(root,binding,{lock,trustedBootstrap=false}={}) {
  const supervisor=require('./self-modification-supervisor.cjs')
  const t=supervisor.target(root),rootIdentity=t.stat
  const targetBytes=tree.readFile(path.join(root,'target.json'),4096).bytes
  if(t.value.hostDigest!==binding.hostDigest||t.value.protectedDigest!==binding.protectedDigest||
    ![binding.versionId,binding.nonce].every(identity)||
    ![binding.hostDigest,binding.protectedDigest,binding.rendererDigest,binding.artifactDigest].every(hex))
    throw Error('Consumer protected host/version binding mismatch')
  let fd,owned=false,id
  const file=path.join(root,'activation.lock')
  if(lock) {fd=lock.fd;id=lock.id}
  else {supervisor.assertIdle(root);fd=fs.openSync(file,'wx',0o600);id=randomUUID();owned=true
    fs.writeFileSync(fd,JSON.stringify({id,pid:process.pid}));fs.fsyncSync(fd)}
  const pinned=fs.fstatSync(fd)
  const fence=()=>{
    if(!tree.same(rootIdentity,tree.directory(root))||!tree.same(pinned,fs.lstatSync(file))||
      !tree.same(pinned,fs.fstatSync(fd))||
      !tree.readFile(path.join(root,'target.json'),4096).bytes.equals(targetBytes))throw Error('Consumer lease/target replaced')
    const owner=JSON.parse(tree.readFile(file,4096).bytes)
    if(owner.id!==id||owner.pid!==process.pid)throw Error('Consumer lease owner mismatch')
    if(trustedBootstrap) {
      // Only an initial fixed trusted bootstrap fixture, never a way to load a
      // staged/rejected/published version without its acknowledged transaction.
      if(lock||fs.existsSync(path.join(root,'transaction.json')))throw Error('Bootstrap cannot consume an activation version')
    } else {
      const tx=supervisor.transaction(root)
      if(!['accepted',...(lock?['swapped']:[])].includes(tx.state)||
        tx.versionId!==binding.versionId||tx.nonce!==binding.nonce||
        tx.artifactDigest!==binding.artifactDigest||tx.rendererDigest!==binding.rendererDigest||
        lock&&(tx.id!==id||tx.ownerPid!==process.pid))throw Error('Consumer activation/version receipt mismatch')
    }
  }
  const update=(items)=> {
    fence()
    const now=work(root,t.value.id)
    if(now.owner&&(now.owner.id!==id||now.owner.pid!==process.pid))throw Error('Unknown pending-work owner; retained')
    if(items.length>128||!items.every(x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(x)))
      throw Error('Invalid trusted pending-work entry')
    supervisor.atomic(root,'pending-work.json',{version:1,targetId:t.value.id,owner:{id,pid:process.pid},items})
  }
  try {
    fence()
    const current=await tree.capture(path.join(root,'current'),{maxFile:16*1024*1024,check:fence})
    if(current.digest!==binding.rendererDigest)throw Error('Consumer renderer version changed')
    const lease={version:1,id,targetId:t.value.id,pid:process.pid,state:'open',binding,
      loadedRenderer:path.join(root,'current'),rendererDigest:current.digest}
    supervisor.atomic(root,`consumer-${id}.json`,lease)
    update([])
    return {binding:{targetId:t.value.id,versionId:binding.versionId,nonce:binding.nonce,
      artifactDigest:binding.artifactDigest,rendererDigest:binding.rendererDigest},
      renderer:path.join(root,'current'),snapshot:current,fence,
      begin:item=>{const s=work(root,t.value.id);if(s.items.includes(item))throw Error('Work already exists');update([...s.items,item])},
      end:item=>{const s=work(root,t.value.id);if(!s.items.includes(item))throw Error('Work was not owned');update(s.items.filter(x=>x!==item))},
      close:()=>{
        fence()
        const state=work(root,t.value.id)
        if(state.owner?.id!==id||state.owner?.pid!==process.pid)throw Error('Unknown work owner retained')
        if(state.items.length)throw Error('Pending consumer work retained; lease cannot be declared idle')
        supervisor.atomic(root,`consumer-${id}.json`,{...lease,state:'closed'})
        supervisor.atomic(root,'pending-work.json',{version:1,targetId:t.value.id,owner:null,items:[]})
        if(owned){fs.closeSync(fd);fs.unlinkSync(file)}
      },
    }
  } catch(e) {
    if(owned)fs.closeSync(fd) // retain uncertain owner/receipt, never guess cleanup
    throw e
  }
}
module.exports={open,work}
