'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {randomUUID} = require('node:crypto')
const tree = require('./self-modification-artifact.cjs')
const {identity, keys} = require('./self-modification-schema.cjs')
const contract=require('./self-modification-native-contract.cjs')
const stages = ['qualifying','qualified','failed','approved','rejected','activating','accepted','rolled-back','cancelled']
const hex = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
function decode(raw) {
  const state = JSON.parse(raw)
  if(!keys(state,['version','revision','records']) || ![1,2].includes(state.version) || !Number.isSafeInteger(state.revision) ||
    state.revision < 0 || !Array.isArray(state.records) || state.records.length > 200) throw new Error('Unsupported frontend delivery journal; retained unchanged')
  const ids = new Set()
  for(const r of state.records) {
    if(!keys(r,['versionId','changeId','attemptId','epoch','journalRevision','stage','scope','ownerPid','createdAt',
      'updatedAt','qualification','reviewDigest','approval','target','outcome','error']) ||
      ![r.versionId,r.changeId,r.attemptId].every(identity) || ids.has(r.versionId) || r.scope !== 'frontend-only-v1' ||
      ![r.epoch,r.journalRevision,r.ownerPid].every(v=>Number.isSafeInteger(v)&&v>=0) ||
      !stages.includes(r.stage) || !Number.isFinite(Date.parse(r.createdAt)) || !Number.isFinite(Date.parse(r.updatedAt)) ||
      (r.error !== null && (typeof r.error !== 'string' || r.error.length > 500)) ||
      (r.reviewDigest !== null && !hex(r.reviewDigest))) throw new Error('Invalid frontend delivery record')
    ids.add(r.versionId)
    if(r.qualification !== null) {
      const q = r.qualification
      if(q.version===2)contract.validateQualification(q)
      else {
      if(!keys(q,['version','nonce','artifactDigest','policy','nativeWindow','protectedPreload','fixedBridge',
        'rendererReady','healthSamples','kernelDenials','fullAppQualified','scope','sourceDigest','rendererDigest',
        'hostDigest','hostIdentity','runtime','dependencyDigest','observationDigest','job','boundDigest','inputDigest','sourceIdentityDigest']) ||
        q.version !== 1 || !identity(q.nonce) || q.policy !== 'native-trusted-host-renderer-v1' ||
        ![q.artifactDigest,q.sourceDigest,q.rendererDigest,q.hostDigest,q.dependencyDigest,q.observationDigest,q.boundDigest,q.inputDigest,q.sourceIdentityDigest].every(hex) ||
        q.fullAppQualified !== false || q.scope !== 'trusted-host-renderer-only' ||
        q.nativeWindow!==true || q.protectedPreload!==true || q.fixedBridge!==true || q.rendererReady!==true ||
        !Number.isSafeInteger(q.healthSamples) || q.healthSamples < 3 ||
        !keys(q.kernelDenials,['read','write','sourceWrite','fork','network']) ||
        !Object.values(q.kernelDenials).every(v=>v===true) || typeof q.job !== 'string' || !path.isAbsolute(q.job))
        throw new Error('Invalid native qualification')
      if(!keys(q.runtime,['relativePath','sha256','pid'])||
        q.runtime.relativePath!=='electron/dist/Electron.app/Contents/MacOS/Electron'||!hex(q.runtime.sha256)||
        !Number.isSafeInteger(q.runtime.pid)||q.runtime.pid<1||
        !keys(q.hostIdentity,['codeDigest','version','origin'])||q.hostIdentity.codeDigest!==q.hostDigest||
        typeof q.hostIdentity.version!=='string'||!q.hostIdentity.version||q.hostIdentity.version.length>128||
        !keys(q.hostIdentity.origin,['kind','path','archiveSha256'])||
        !['directory','asar'].includes(q.hostIdentity.origin.kind)||!path.isAbsolute(q.hostIdentity.origin.path)||
        (q.hostIdentity.origin.kind==='asar'?!hex(q.hostIdentity.origin.archiveSha256):q.hostIdentity.origin.archiveSha256!==null))
        throw new Error('Missing verified copied-runtime or actual protected-host identity; legacy qualification cannot grant authority')
      }
    }
    if(r.approval !== null && (!keys(r.approval,['id','artifactDigest','reviewDigest','expiresAt']) ||
      !identity(r.approval.id) || !hex(r.approval.artifactDigest) || r.approval.artifactDigest !== r.qualification?.artifactDigest ||
      r.approval.reviewDigest !== r.reviewDigest || !Number.isFinite(Date.parse(r.approval.expiresAt)))) throw new Error('Invalid exact-artifact approval')
    if(r.target !== null && (!keys(r.target,['root','dev','ino','identityDigest']) || typeof r.target.root !== 'string' ||
      !path.isAbsolute(r.target.root) || !hex(r.target.identityDigest) ||
      ![r.target.dev,r.target.ino].every(v=>Number.isSafeInteger(v)&&v>=0))) throw new Error('Invalid target')
    if(r.outcome !== null && (!keys(r.outcome,['state','nonce','artifactDigest','reason']) ||
      !['accepted','rolled-back','failed'].includes(r.outcome.state) || !identity(r.outcome.nonce) ||
      !hex(r.outcome.artifactDigest) || typeof r.outcome.reason !== 'string' || r.outcome.reason.length > 500)) throw new Error('Invalid delivery outcome')
    if(['qualified','approved','activating','accepted','rolled-back','rejected'].includes(r.stage) && !r.qualification) throw new Error('Missing qualification')
    if(['approved','activating','accepted'].includes(r.stage) && !r.approval) throw new Error('Missing approval')
    if(['activating','accepted','rolled-back'].includes(r.stage) && !r.target) throw new Error('Missing activation target')
    if(['accepted','rolled-back'].includes(r.stage) && (r.outcome?.state!==r.stage ||
      r.outcome.artifactDigest!==r.qualification.artifactDigest)) throw new Error('Contradictory terminal outcome')
    if(!['accepted','rolled-back','failed'].includes(r.stage) && r.outcome!==null) throw new Error('Unexpected outcome')
  }
  return state
}
function createStore(userData, io = fs) {
  const parent = path.join(userData,'self-modification')
  const file = path.join(parent,'deliveries.json'), lock = path.join(parent,'delivery.lock')
  const root = io.lstatSync(userData), folder = io.lstatSync(parent)
  let knownFile = io.existsSync(file)
  function guard() {
    for(const [p,s] of [[userData,root],[parent,folder]]) {
      const now = io.lstatSync(p)
      if(!now.isDirectory() || now.isSymbolicLink() || !tree.same(s,now)) throw new Error('Delivery storage identity changed')
    }
  }
  function read() {
    guard()
    try {
      const fd = io.openSync(file,io.constants.O_RDONLY|io.constants.O_NOFOLLOW|io.constants.O_NONBLOCK)
      try {
        const s = io.fstatSync(fd)
        if(!s.isFile() || s.nlink !== 1 || s.size > 4*1024*1024 || !tree.same(s,io.lstatSync(file))) throw new Error('Unsafe delivery journal')
        const bytes = io.readFileSync(fd)
        if(!tree.same(s,io.lstatSync(file)) || s.size !== bytes.length) throw new Error('Delivery journal changed')
        knownFile = true
        return decode(bytes)
      } finally {io.closeSync(fd)}
    } catch(e) {if(e.code === 'ENOENT' && !knownFile) return {version:2,revision:0,records:[]};throw e}
  }
  function mutate(revision, change) {
    guard()
    let fd, temp
    try {
      try {fd = io.openSync(lock,'wx',0o600)} catch(e) {
        if(e.code !== 'EEXIST') throw e
        const oldFd = io.openSync(lock,io.constants.O_RDONLY|io.constants.O_NOFOLLOW|io.constants.O_NONBLOCK)
        try {
          const stat = io.fstatSync(oldFd)
          if(!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error('Unknown delivery lock retained')
          const owner = JSON.parse(io.readFileSync(oldFd))
          if(!keys(owner,['version','id','pid']) || owner.version !== 1 || !identity(owner.id) ||
            !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Unknown delivery lock retained')
          try {process.kill(owner.pid,0);throw new Error('Delivery writer may still be active')} catch(error) {
            if(error.code !== 'ESRCH') throw error
          }
          guard()
          if(!tree.same(stat,io.lstatSync(lock))) throw new Error('Delivery lock identity changed')
          io.renameSync(lock,path.join(parent,`delivery-lock-${owner.id}.interrupted`))
        } finally {io.closeSync(oldFd)}
        fd = io.openSync(lock,'wx',0o600)
      }
      io.writeFileSync(fd,JSON.stringify({version:1,id:randomUUID(),pid:process.pid}));io.fsyncSync(fd)
      const current = read()
      if(current.version===1)throw Error('Legacy delivery journal is read-only; bytes retained')
      if(current.revision !== revision) throw new Error('Stale delivery revision')
      const legacy=current.records.filter(r=>r.qualification?.version===1).map(r=>JSON.stringify(r))
      change(current.records)
      if(legacy.some(bytes=>!current.records.some(r=>JSON.stringify(r)===bytes)))
        throw Error('Historical legacy receipt is read-only; bytes retained')
      current.revision++
      const bytes = Buffer.from(JSON.stringify(current))
      decode(bytes)
      if(bytes.length > 4*1024*1024) throw new Error('Delivery journal full; records retained')
      temp = path.join(parent,`.delivery-${randomUUID()}`)
      const output = io.openSync(temp,'wx',0o600)
      try {io.writeFileSync(output,bytes);io.fsyncSync(output)} finally {io.closeSync(output)}
      guard();io.renameSync(temp,file)
      knownFile = true
      const directory = io.openSync(parent,'r')
      try {io.fsyncSync(directory)} finally {io.closeSync(directory)}
      return current
    } finally {
      if(fd !== undefined) {io.closeSync(fd);io.unlinkSync(lock)}
      // An uncertain write is retained. Never replay automatically.
    }
  }
  return {read,mutate}
}
module.exports = {decode, createStore, stages}
