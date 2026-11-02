'use strict'
// The virtual ASAR view is used ONLY for already trusted host code, anchored to
// the exact physical archive bytes before/after reading. Never for candidate
// provenance or its dependency graph.
const fs=require('node:fs')
const physical=process.versions.electron?require('original-fs'):fs
const path=require('node:path')
const tree=require('./self-modification-artifact.cjs')
const policy=require('./self-modification-policy.cjs')
const crypto=require('node:crypto')
const runtimeFile=name=>!name.includes('.test.')&&!policy.sensitivePath(name)
const fingerprint=manifest=>tree.sha(JSON.stringify(manifest.filter(f=>runtimeFile(f.path))
  .map(f=>[f.path,f.sha256,f.size,!!(f.mode&0o111)]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)))
function archiveFile(root) {
  const match=/^(.*?\.asar)(?:\/|$)/.exec(root)
  return match?.[1]??null
}
function archiveIdentity(file,check=()=>{}) {
  const fd=physical.openSync(file,physical.constants.O_RDONLY|physical.constants.O_NOFOLLOW|physical.constants.O_NONBLOCK)
  try {
    const before=physical.fstatSync(fd)
    if(!before.isFile()||before.nlink!==1||before.size>2*1024*1024*1024)throw Error('Unsafe physical trusted-host archive')
    const h=crypto.createHash('sha256'),buffer=Buffer.alloc(256*1024)
    let length
    while((length=physical.readSync(fd,buffer,0,buffer.length,null))){check();h.update(buffer.subarray(0,length))}
    const after=physical.fstatSync(fd),named=physical.lstatSync(file)
    const metadata=s=>[s.dev,s.ino,s.size,s.mode,s.mtimeMs,s.ctimeMs,s.nlink]
    if(JSON.stringify(metadata(before))!==JSON.stringify(metadata(after))||
      JSON.stringify(metadata(before))!==JSON.stringify(metadata(named)))throw Error('Trusted-host physical archive changed')
    return {sha256:h.digest('hex'),dev:before.dev,ino:before.ino,size:before.size,mtimeMs:before.mtimeMs,ctimeMs:before.ctimeMs}
  } finally {physical.closeSync(fd)}
}
async function inspect(root=__dirname,check=()=>{}) {
  const archive=archiveFile(root),before=archive?archiveIdentity(archive,check):null
  const files=[]
  let bytes=0,count=0
  function walk(folder,relative='') {
    check()
    const parent=fs.lstatSync(folder)
    if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('Unsafe trusted-host code directory')
    for(const name of fs.readdirSync(folder).sort()) {
      const rel=relative+name
      if(!runtimeFile(rel))continue // before any sensitive content read
      if(++count>5000||rel.split('/').length>32)throw Error('Trusted host exceeds bounded closure')
      const file=path.join(folder,name),stat=fs.lstatSync(file)
      if(stat.isDirectory()){walk(file,rel+'/');continue}
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw Error('Unsafe trusted-host module')
      const data=fs.readFileSync(file)
      if(data.length!==stat.size||(bytes+=data.length)>128*1024*1024)throw Error('Trusted-host closure changed')
      files.push({path:rel,bytes:data,size:data.length,sha256:tree.sha(data),mode:stat.mode&0o111?0o700:0o600})
    }
  }
  walk(root)
  const packageBytes=fs.readFileSync(path.join(root,'../package.json'))
  if(packageBytes.length>256*1024)throw Error('Trusted package metadata exceeds bound')
  const pkg=JSON.parse(packageBytes)
  if(typeof pkg.version!=='string'||!pkg.version||pkg.version.length>128)throw Error('Missing actual protected-host version')
  if(archive&&JSON.stringify(archiveIdentity(archive,check))!==JSON.stringify(before))throw Error('Physical host archive replaced')
  const codeDigest=fingerprint(files)
  return {files,packageBytes,identity:{codeDigest,version:pkg.version,
    origin:{kind:archive?'asar':'directory',path:archive||fs.realpathSync(root),archiveSha256:before?.sha256??null}}}
}
function verifyOrigin(identity) {
  if(identity.origin.kind==='asar'&&archiveIdentity(identity.origin.path).sha256!==identity.origin.archiveSha256)
    throw Error('Actual protected host archive mutated')
}
async function stageWorker(userData,root=__dirname) {
  const host=await inspect(root)
  const parent=path.join(userData,'self-modification'),pinned=tree.directory(parent)
  const seals=require('./self-modification-seal.cjs')
  const key=tree.sha(JSON.stringify([host.identity.codeDigest,tree.sha(host.packageBytes)]))
  const folder=path.join(parent,`trusted-worker-${key}`),receipt=path.join(parent,`worker-seal-${key}.json`)
  // One exclusive staging slot, even across managers. Unknown/stale locks and
  // partial copies are retained, never guessed safe or deleted.
  const lock=path.join(parent,'worker-staging.lock'),fd=fs.openSync(lock,'wx',0o600),stat=fs.fstatSync(fd)
  try {
    fs.writeFileSync(fd,JSON.stringify({pid:process.pid,key}));fs.fsyncSync(fd)
    if(fs.existsSync(folder)) {
      const saved=JSON.parse(tree.readFile(receipt,4096).bytes)
      if(!require('./self-modification-schema.cjs').keys(saved,['version','identity','digest'])||saved.version!==1||
        saved.identity!==seals.identity(folder)||(await seals.capture(folder)).digest!==saved.digest)
        throw Error('Unknown/mutated retained trusted worker; manual recovery required')
    } else {
      if(fs.readdirSync(parent).filter(name=>name.startsWith('trusted-worker-')).length>=2)
        throw Error('Two retained trusted worker copies exhaust staging budget; no automatic cleanup')
      fs.mkdirSync(folder,{mode:0o700})
      tree.materialize(path.join(folder,'electron'),host.files)
      fs.writeFileSync(path.join(folder,'package.json'),host.packageBytes,{flag:'wx',mode:0o600})
      const capture=await seals.capture(folder)
      fs.writeFileSync(receipt,JSON.stringify({version:1,identity:seals.identity(folder),digest:capture.digest}),{flag:'wx',mode:0o600})
    }
  const staged=await inspect(path.join(folder,'electron'))
  if(!tree.same(pinned,tree.directory(parent))||staged.identity.codeDigest!==host.identity.codeDigest||
    staged.identity.version!==host.identity.version)throw Error('Trusted external worker staging identity changed')
  verifyOrigin(host.identity)
  const entry=path.join(folder,'electron/self-modification-supervisor-worker.cjs')
  tree.readFile(entry)
  return {folder,identity:host.identity,entry}
  } finally {
    fs.closeSync(fd)
    if(tree.same(stat,fs.lstatSync(lock)))fs.unlinkSync(lock)
  }
}
module.exports={inspect,fingerprint,archiveIdentity,verifyOrigin,runtimeFile,stageWorker}
