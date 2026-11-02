'use strict'
// Durable one-attempt budget per version, one global pending/unknown slot.
// Status reloads are NOT a retry authorization. Uncertain work is never removed.
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto')
const tree=require('./self-modification-artifact.cjs'),{keys,identity}=require('./self-modification-schema.cjs')
function admission(userData,io=fs) {
  const parent=path.join(userData,'self-modification'),pinned=tree.directory(parent)
  const file=path.join(parent,'recovery-admission.json'),lock=path.join(parent,'recovery-admission.lock')
  const pending=path.join(parent,'recovery-pending.json')
  const guard=()=>{if(!tree.same(pinned,io.lstatSync(parent)))throw Error('Recovery storage replaced')}
  function read() {
    guard()
    let s
    try {s=JSON.parse(tree.readFile(file,128*1024).bytes)}
    catch(e){if(e.code==='ENOENT')return {version:1,attempts:[]};throw e}
    if(!keys(s,['version','attempts'])||s.version!==1||!Array.isArray(s.attempts)||s.attempts.length>200||
      new Set(s.attempts.map(a=>a.versionId)).size!==s.attempts.length||
      !s.attempts.every(a=>keys(a,['versionId','operationId','targetDigest','ownerPid','state','error'])&&
        identity(a.versionId)&&identity(a.operationId)&&/^[a-f0-9]{64}$/.test(a.targetDigest)&&
        Number.isSafeInteger(a.ownerPid)&&a.ownerPid>0&&['pending','completed','failed'].includes(a.state)&&
        (a.error===null||typeof a.error==='string'&&a.error.length<=500)))
      throw Error('Unknown recovery admission retained; manual recovery required')
    return s
  }
  function mutate(fn) {
    guard()
    const fd=io.openSync(lock,'wx',0o600),stat=io.fstatSync(fd)
    try {
      io.writeFileSync(fd,JSON.stringify({pid:process.pid}));io.fsyncSync(fd)
      const s=read(),value=fn(s)
      const temp=path.join(parent,`.recovery-${randomUUID()}`)
      const out=io.openSync(temp,'wx',0o600)
      try {io.writeFileSync(out,JSON.stringify(s));io.fsyncSync(out)}finally{io.closeSync(out)}
      guard();io.renameSync(temp,file)
      const dir=io.openSync(parent,'r');try{io.fsyncSync(dir)}finally{io.closeSync(dir)}
      return value
    } finally {
      io.closeSync(fd)
      if(tree.same(stat,io.lstatSync(lock)))io.unlinkSync(lock)
    }
  }
  return {
    reserve(r) {return mutate(s=>{
      const old=s.attempts.find(a=>a.versionId===r.versionId)
      if(old)throw Error(`Manual recovery required: retained ${old.state} attempt; status never retries`)
      if(s.attempts.some(a=>a.state==='pending'))throw Error('Recovery slot contains unknown/pending work; no queued dispatch')
      if(s.attempts.length>=200)throw Error('Recovery attempt budget exhausted; retained work requires manual recovery')
      if(io.existsSync(pending))throw Error('Unknown pending recovery reservation retained; no queued dispatch')
      const a={versionId:r.versionId,operationId:randomUUID(),targetDigest:r.target.identityDigest,
        ownerPid:process.pid,state:'pending',error:null}
      // Fixed per-version reservation + global slot survive even an uncertain
      // ledger write. Neither is cleaned on failed admission.
      for(const name of [path.join(parent,`recovery-reservation-${r.versionId}.json`),pending]) {
        const fd=io.openSync(name,'wx',0o600)
        try{io.writeFileSync(fd,JSON.stringify(a));io.fsyncSync(fd)}finally{io.closeSync(fd)}
      }
      s.attempts.push(a);return a
    })},
    finish(a,error) {
      const original=tree.readFile(pending,4096)
      if(!original.bytes.equals(Buffer.from(JSON.stringify(a))))throw Error('Unknown recovery reservation retained')
      const value=mutate(s=>{
      const owned=s.attempts.find(v=>v.operationId===a.operationId)
      if(!owned||owned.state!=='pending'||owned.ownerPid!==process.pid)throw Error('Recovery admission acknowledgment unknown')
      owned.state=error?'failed':'completed';owned.error=error?String(error.message||error).slice(0,500):null
      })
      guard()
      if(!tree.same(original.stat,io.lstatSync(pending))||!tree.readFile(pending,4096).bytes.equals(original.bytes))
        throw Error('Recovery slot identity changed; retained')
      io.unlinkSync(pending)
      return value
    },
    read,
  }
}
module.exports={admission}
