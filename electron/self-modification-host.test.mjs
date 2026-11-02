import {afterEach,describe,expect,it} from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url),host=require('./self-modification-host.cjs'),tree=require('./self-modification-artifact.cjs')
const roots=[]
afterEach(()=>{for(const r of roots.splice(0))fs.rmSync(r,{recursive:true,force:true})})
function fixture() {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hd-selfedit-host-')));roots.push(root)
  fs.mkdirSync(path.join(root,'data'));fs.mkdirSync(path.join(root,'data/self-modification'))
  fs.writeFileSync(path.join(root,'package.json'),'{"version":"owned-host-fixture"}')
  tree.materialize(path.join(root,'electron'),[
    {path:'main.cjs',mode:0o600,bytes:Buffer.from('// FIXED INERT HOST')},
    {path:'self-modification-supervisor-worker.cjs',mode:0o600,bytes:Buffer.from('// FIXED INERT WORKER')},
    {path:'auth.cjs',mode:0o600,bytes:Buffer.from('// Genuine protected source')},
    {path:'main.test.mjs',mode:0o600,bytes:Buffer.from('// not a runtime input')},
  ])
  fs.writeFileSync(path.join(root,'electron/auth.json'),'OWNED FAKE DATA - NEVER A CREDENTIAL')
  return root
}
describe('actual protected host/version identity and physical external dispatch',()=>{
  it('reads genuine protected source, not sensitive-shaped data or test files',async()=>{
    const root=fixture(),s=await host.inspect(path.join(root,'electron'))
    expect(s.identity.version).toBe('owned-host-fixture')
    expect(s.files.map(f=>f.path)).toEqual(['auth.cjs','main.cjs','self-modification-supervisor-worker.cjs'])
    expect(s.identity.codeDigest).toBe(host.fingerprint(s.files))
    expect(s.identity.origin.kind).toBe('directory')
  })
  it('stages a physical identical host closure with original protected version for external Node',async()=>{
    const root=fixture(),stage=await host.stageWorker(path.join(root,'data'),path.join(root,'electron'))
    expect(stage.entry).toBe(path.join(stage.folder,'electron/self-modification-supervisor-worker.cjs'))
    expect((await host.inspect(path.join(stage.folder,'electron'))).identity.codeDigest).toBe(stage.identity.codeDigest)
    expect(fs.existsSync(path.join(stage.folder,'electron/auth.json'))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(stage.folder,'package.json'))).version).toBe('owned-host-fixture')
  })
  it('physical ASAR hash refuses changed bytes, symlink or hardlink archives (owned inert bytes)',()=>{
    const root=fixture(),file=path.join(root,'owned.asar')
    fs.writeFileSync(file,'INERT OWNED ARCHIVE PLACEHOLDER; NEVER EXECUTED')
    const before=host.archiveIdentity(file)
    expect(before.sha256).toBe(tree.sha(fs.readFileSync(file)))
    const identity={origin:{kind:'asar',path:file,archiveSha256:before.sha256}}
    host.verifyOrigin(identity)
    fs.appendFileSync(file,'OWNED CHANGE')
    expect(()=>host.verifyOrigin(identity)).toThrow(/mutated/)
    const link=path.join(root,'link.asar');fs.symlinkSync(file,link)
    expect(()=>host.archiveIdentity(link)).toThrow()
    fs.linkSync(file,path.join(root,'hardlink.asar'))
    expect(()=>host.archiveIdentity(file)).toThrow(/Unsafe/)
  })
})
