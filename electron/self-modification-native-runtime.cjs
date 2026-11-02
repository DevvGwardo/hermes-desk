'use strict'
const fs=require('node:fs'),path=require('node:path')
const tree=require('./self-modification-artifact.cjs'),seals=require('./self-modification-seal.cjs')
const RUNTIME='electron/dist/Electron.app/Contents/MacOS/Electron'
const RENDERER='electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)'
async function copy(source,destination,{check=()=>{},executable}={}) {
  const selected=path.join(destination,RUNTIME)
  if(executable!==undefined&&executable!==selected)throw Error('Only the exact copied runtime executable is permitted')
  const captured=await seals.capture(source,{allowLinks:true,check})
  // Fixed build/test caches are not provisioned runtime dependencies. They are
  // intentionally absent from the copied authority graph (no source fallback).
  // Other workstreams' typecheck/vitest cache writes cannot alter that graph.
  const manifest=captured.manifest.filter(f=>!/^(\.tmp|\.vite|\.vite-temp|\.cache)(\/|$)/.test(f.path))
  const snapshot={...captured,manifest,bytes:manifest.reduce((n,f)=>n+(f.size||0),0),digest:tree.sha(JSON.stringify(manifest))}
  const copied=await seals.copy(source,destination,snapshot,check)
  const pins=new Map()
  for(const name of [RUNTIME,RENDERER]) {
    const file=path.join(destination,name),entry=snapshot.manifest.find(f=>f.path===name)
    if(entry?.type!=='file'||!(entry.mode&0o111)||fs.realpathSync(file)!==file)throw Error('Unsafe copied native executable')
    const read=tree.readFile(file,256*1024*1024)
    if(read.stat.nlink!==1||tree.sha(read.bytes)!==entry.sha256)throw Error('Copied executable manifest mismatch')
    pins.set(name,{file,entry,stat:read.stat})
  }
  const graphIdentity=copied.identityDigest
  function fence() {
    check()
    if(seals.identity(destination,check)!==graphIdentity)throw Error('Copied runtime/framework graph identity mutated')
    for(const p of pins.values())if(!tree.same(p.stat,fs.lstatSync(p.file)))throw Error('Copied executable identity replaced')
  }
  fence()
  return {snapshot,graphIdentity,executable:selected,renderer:path.join(destination,RENDERER),
    runtimeSha256:pins.get(RUNTIME).entry.sha256,rendererSha256:pins.get(RENDERER).entry.sha256,fence}
}
module.exports={copy,RUNTIME,RENDERER}
