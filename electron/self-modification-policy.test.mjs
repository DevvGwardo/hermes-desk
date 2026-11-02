import {afterEach,describe,expect,it} from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {setTimeout as delay} from 'node:timers/promises'
const require=createRequire(import.meta.url)
const policy=require('./self-modification-policy.cjs')
const {createChangeController}=require('./self-modification.cjs')
const {createWorkspaceManager}=require('./self-modification-workspace.cjs')
const roots=[]
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})})
function fixture() {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hd-selfedit-policy-')))
  roots.push(root)
  const repo=path.join(root,'repo'),data=path.join(root,'data')
  fs.mkdirSync(repo);fs.mkdirSync(data);fs.mkdirSync(path.join(repo,'src/components'),{recursive:true})
  const git=(args,input)=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',repo,...args],{encoding:'utf8',input}).trim()
  git(['init','-q'])
  const blob=git(['hash-object','-w','--stdin'],'export const Note = () => <p>baseline</p>\n')
  const components=git(['mktree'],`100644 blob ${blob}\tNote.tsx\n`)
  const src=git(['mktree'],`040000 tree ${components}\tcomponents\n`)
  const tree=git(['mktree'],`040000 tree ${src}\tsrc\n`)
  const head=git(['commit-tree',tree,'-m','Disposable frontend policy fixture'])
  git(['update-ref','HEAD',head]);git(['read-tree','HEAD'])
  fs.writeFileSync(path.join(repo,'src/components/Note.tsx'),'export const Note = () => <p>baseline</p>\n')
  const controller=createChangeController(data),saved=controller.create(0,{request:'Presentation only',acceptanceCriteria:'No host or storage changes.'})
  const id=saved.changes[0].id,attemptId=saved.changes[0].attempts[0].id
  const workspace=createWorkspaceManager(data,controller)
  async function settle() {
    for(let i=0;i<200;i++){const a=controller.list().changes[0].attempts[0];if(a.state!=='preparing')return a;await delay(5)}
    throw new Error('Preparation timeout')
  }
  async function prepare(kind='head',selection) {
    selection ||= (await workspace.selectRepository(repo)).selection
    const started=await workspace.prepare(controller.list().revision,id,attemptId,{selectionId:selection.id,baseline:kind})
    expect(started.ok).toBe(true)
    const a=await settle()
    expect(a.state,JSON.stringify(a)).toBe('prepared')
    const source=path.join(data,'self-modification/workspaces',a.preparation.workspace.id,'source')
    return {a,source}
  }
  return {root,repo,data,git,head,controller,workspace,id,attemptId,prepare}
}
describe('frontend v1 authority policy and explicit baseline',()=>{
  it('excludes committed FAKE sensitive blobs before cat-file batches while retaining protected auth source',async()=>{
    const f=fixture(),privateBlob=f.git(['hash-object','-w','--stdin'],'OWNED FAKE DATA - NOT A CREDENTIAL\n')
    const code=f.git(['hash-object','-w','--stdin'],'// genuine protected auth/security source\n')
    const names=['auth.json','auth.json.bak','credentials.json','tokens.json','.netrc','state.db','id_ed25519']
    const electron=f.git(['mktree'],[...names.map(n=>`100644 blob ${privateBlob}\t${n}`),`100644 blob ${code}\tauth.cjs`].join('\n')+'\n')
    const source=f.git(['rev-parse','HEAD:src'])
    const commitTree=f.git(['mktree'],`040000 tree ${electron}\telectron\n040000 tree ${source}\tsrc\n`)
    const head=f.git(['commit-tree',commitTree,'-m','Owned fake sensitive committed fixture'])
    f.git(['update-ref','HEAD',head]);f.git(['read-tree','HEAD'])
    fs.mkdirSync(path.join(f.repo,'electron'))
    for(const name of names)fs.writeFileSync(path.join(f.repo,'electron',name),'OWNED FAKE DATA - NOT A CREDENTIAL\n')
    fs.writeFileSync(path.join(f.repo,'electron/auth.cjs'),'// genuine protected auth/security source\n')
    const batches=[]
    const w=createWorkspaceManager(f.data,f.controller,{git:async(root,args,opts={})=>{
      try {
      if(args[0]==='cat-file') {
        batches.push(opts.input)
        expect(opts.input?.toString()||'').not.toContain(privateBlob)
        expect(args.join(' ')).not.toContain(privateBlob)
      }
      return execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',root,...args],
        {input:opts.input,encoding:null,timeout:20000})
      }catch(error){error.workspaceCode='test';throw error}
    }})
    const selection=await w.selectRepository(f.repo)
    expect(selection.ok,JSON.stringify(selection)).toBe(true)
    expect(selection.selection.workingTree.changes.map(c=>c.path).some(p=>p==='electron/auth.json')).toBe(false)
    expect((await w.prepare(f.controller.list().revision,f.id,f.attemptId,{selectionId:selection.selection.id,baseline:'head'})).ok).toBe(true)
    let a
    for(let i=0;i<200;i++){a=f.controller.list().changes[0].attempts[0];if(a.state!=='preparing')break;await delay(5)}
    expect(a.state,JSON.stringify(a)).toBe('prepared')
    expect(batches.length).toBeGreaterThan(0)
    const snapshot=path.join(f.data,'self-modification/workspaces',a.preparation.workspace.id,'source')
    for(const name of names)expect(fs.existsSync(path.join(snapshot,'electron',name))).toBe(false)
    expect(fs.readFileSync(path.join(snapshot,'electron/auth.cjs'),'utf8')).toContain('auth/security source')
  })
  it.each(['electron/main.cjs','electron/preload.cjs','electron/local/boot.cjs','package.json','package-lock.json',
    'vite.config.ts','tsconfig.json','src/lib/self-modification.ts','src/lib/storage.ts',
    'src/components/StorageEditor.tsx','src/components/SessionRoom.tsx','src/components/GenUI.tsx',
    'src/components/migrations/New.tsx','src/components/bridge/New.tsx','src/components/permissions/New.tsx',
    '../src/components/New.tsx','src/components/../New.tsx','src/components\\New.tsx','/src/components/New.tsx',
    'src/components/.env','public/secrets.json'])('protects %s, including new paths',name=>{
    expect(policy.editable(name)).toBe(false)
    expect(()=>policy.assertEditable(name)).toThrow(/Protected path/)
  })
  it('allows only presentation components/styles and visual assets',()=>{
    for(const name of ['src/components/Note.tsx','src/components/layout/Card.tsx','src/components/Card.css','src/index.css','public/mark.svg'])
      expect(policy.editable(name)).toBe(true)
  })
  it('binds reviewed dirty bytes and preserves original HEAD/index/source',async()=>{
    const f=fixture()
    fs.writeFileSync(path.join(f.repo,'src/components/Note.tsx'),'export const Note = () => <p>reviewed dirty work</p>\n')
    fs.writeFileSync(path.join(f.repo,'src/components/New.tsx'),'export const New = () => null\n')
    const selection=(await f.workspace.selectRepository(f.repo)).selection
    expect(selection.workingTree.changes.map(f=>f.path)).toEqual(['src/components/New.tsx','src/components/Note.tsx'])
    expect(selection.workingTree.changes[1].diff).toContain('+export const Note = () => <p>reviewed dirty work</p>')
    const before=f.git(['status','--porcelain=v1'])
    const {a,source}=await f.prepare('working-tree',selection)
    expect(a.preparation.source.kind).toBe('working-tree')
    expect(a.preparation.source.dirtyExcluded).toBe(false)
    expect(fs.readFileSync(path.join(source,'src/components/Note.tsx'),'utf8')).toContain('reviewed dirty work')
    expect(f.git(['status','--porcelain=v1'])).toBe(before)
    expect(f.git(['rev-parse','HEAD'])).toBe(f.head)
    expect(createChangeController(f.data).list()).toEqual(f.controller.list())
  })
  it('excludes ignored content, secret paths and tooling rather than silently including dirty work',async()=>{
    const f=fixture()
    fs.writeFileSync(path.join(f.repo,'.git/info/exclude'),'src/components/Ignored.tsx\n')
    for(const [name,content] of [['.env','owned fake secret'],['build-script.sh','must not execute'],
      ['src/components/Ignored.tsx','ignored fixture'],['src/components/private.key','owned fake key']])
      fs.writeFileSync(path.join(f.repo,name),content)
    const result=await f.workspace.selectRepository(f.repo)
    expect(result.ok).toBe(true)
    expect(result.selection.workingTree.fileCount).toBe(1)
    const {source}=await f.prepare('working-tree',result.selection)
    for(const name of ['.env','build-script.sh','src/components/Ignored.tsx','src/components/private.key'])
      expect(fs.existsSync(path.join(source,name))).toBe(false)
  })
  it.each(['content','same-bytes-replacement','mode','symlink'])('invalidates a reviewed baseline after %s mutation before intent',async kind=>{
    const f=fixture(),selection=(await f.workspace.selectRepository(f.repo)).selection
    const file=path.join(f.repo,'src/components/Note.tsx')
    if(kind==='content')fs.appendFileSync(file,'changed\n')
    if(kind==='same-bytes-replacement'){fs.renameSync(file,file+'.retained');fs.copyFileSync(file+'.retained',file)}
    if(kind==='mode')fs.chmodSync(file,0o700)
    if(kind==='symlink'){fs.renameSync(file,file+'.retained');fs.symlinkSync(file+'.retained',file)}
    expect((await f.workspace.prepare(1,f.id,f.attemptId,{selectionId:selection.id,baseline:'working-tree'})).ok).toBe(false)
    expect(f.controller.list().changes[0].attempts[0].state).toBe('requested')
    expect(fs.existsSync(path.join(f.data,'self-modification/workspaces'))).toBe(false)
  })
  it.each(['electron/main.cjs','package.json','src/lib/storage.ts','src/components/ImproveHermesDesk.tsx',
    'src/components/GenUICatalog.tsx','src/components/MessageBody.tsx'])('rejects protected proposal %s before the first otherwise-valid write',async protectedPath=>{
    const f=fixture(),{source}=await f.prepare()
    const context=await f.workspace.context(f.id,f.attemptId,['src/components/Note.tsx'])
    let writes=0
    await expect(f.workspace.applyProposal(f.id,f.attemptId,context,{changes:[
      {op:'write',path:'src/components/Note.tsx',content:'must not be applied'},
      {op:'write',path:protectedPath,content:'unauthorized native or persistence'}
    ]},()=>{writes++})).rejects.toThrow(/Protected path/)
    expect(writes).toBe(0)
    expect(fs.readFileSync(path.join(source,'src/components/Note.tsx'),'utf8')).toContain('baseline')
    expect(fs.existsSync(path.join(source,protectedPath))).toBe(false)
  })
  it('rejects out-of-band protected mutation at qualification entry, not just model instructions',async()=>{
    const f=fixture(),{source}=await f.prepare()
    fs.writeFileSync(path.join(source,'package.json'),'{"name":"hermes-desk","scripts":{"build":"unsafe"}}')
    await expect(f.workspace.candidateRoot(f.id,f.attemptId)).rejects.toThrow(/Protected path/)
  })
  it('does not send protected files as model context',async()=>{
    const f=fixture();await f.prepare()
    await expect(f.workspace.context(f.id,f.attemptId,['package.json'])).rejects.toThrow(/Protected path/)
  })
  it('independent default-deny baseline refusal leaves intent and original work unchanged',async()=>{
    const f=fixture()
    let reviewed
    const workspace=createWorkspaceManager(f.data,f.controller,{confirmBaseline:async input=>{reviewed=input;return false}})
    const selection=(await workspace.selectRepository(f.repo)).selection
    const result=await workspace.prepare(1,f.id,f.attemptId,{selectionId:selection.id,baseline:'working-tree'})
    expect(result.ok).toBe(true)
    expect(result.revision).toBe(1)
    expect(reviewed.source.kind).toBe('working-tree')
    expect(reviewed.workingTree.digest).toBe(selection.workingTree.digest)
    expect(f.controller.list().changes[0].attempts[0].state).toBe('requested')
    expect(fs.existsSync(path.join(f.data,'self-modification/workspaces'))).toBe(false)
  })
  it.each(['source','caller'])('baseline %s mutation during independent native review prevents intent and copy',async kind=>{
    const f=fixture()
    let moved=false
    const workspace=createWorkspaceManager(f.data,f.controller,{confirmBaseline:async()=>{
      if(kind==='source')fs.appendFileSync(path.join(f.repo,'src/components/Note.tsx'),'changed during consent')
      else moved=true
      return true
    }})
    const selection=(await workspace.selectRepository(f.repo)).selection
    const result=await workspace.prepare(1,f.id,f.attemptId,{selectionId:selection.id,baseline:'working-tree'},()=>{
      if(moved)throw new Error('Caller navigated')
    })
    expect(result.ok).toBe(false)
    expect(f.controller.list().changes[0].attempts[0].state).toBe('requested')
    expect(fs.existsSync(path.join(f.data,'self-modification/workspaces'))).toBe(false)
  })
})
