// Synthetic controller/health contracts only. Never a native acceptance proof.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {syntheticModule,syntheticQualification} from './self-modification-native-synthetic.test.support.mjs'
const require=createRequire(import.meta.url)
export const tree=require('./self-modification-artifact.cjs')
export const governance=require('./self-modification-policy.cjs')
export const supervisor=syntheticModule('./self-modification-supervisor.cjs')
export const {createStore,decode}=require('./self-modification-delivery-store.cjs')
export const {createDeliveryManager}=syntheticModule('./self-modification-delivery.cjs')
export const productionDeliveryManager=require('./self-modification-delivery.cjs').createDeliveryManager
export {syntheticQualification}
const {createChangeController}=require('./self-modification.cjs')
const h=c=>c.repeat(64)
// Default remains the EXACT pre-repair legacy qualification shape. New synthetic
// mechanism tests must opt in visibly; never upgrade the old red reproduction.
export async function fixture({currentNativeSynthetic=false}={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hd-selfedit-delivery-contract-')))
  const data=path.join(root,'data'),source=path.join(root,'candidate'),renderer=path.join(root,'renderer'),old=path.join(root,'old')
  for(const p of [data,source,renderer,old])fs.mkdirSync(p,{mode:0o700})
  fs.mkdirSync(path.join(source,'src/components'),{recursive:true})
  fs.writeFileSync(path.join(source,'package.json'),'{"name":"hermes-desk","version":"synthetic-fixture"}',{mode:0o600})
  fs.writeFileSync(path.join(source,'src/components/Note.tsx'),'export const Note=()=> <p>candidate</p>\n',{mode:0o600})
  fs.writeFileSync(path.join(renderer,'index.html'),'<p>candidate</p>',{mode:0o600})
  fs.writeFileSync(path.join(old,'index.html'),'<p>known-good</p>',{mode:0o600})
  const sourceCapture=await tree.capture(source),output=await tree.capture(renderer),stat=fs.statSync(source),renderStat=fs.statSync(renderer)
  const id=randomUUID(),attemptId=randomUUID(),now=new Date().toISOString()
  const artifact={id:randomUUID(),token:randomUUID(),dev:renderStat.dev,ino:renderStat.ino,digest:output.digest,
    sourceDigest:sourceCapture.digest,toolchainDigest:h('a'),fileCount:1,scope:'renderer-only',activationEligible:false}
  const validation={operationId:randomUUID(),ownerPid:process.pid,scope:'renderer-only',stage:'checked',
    sourceDigest:sourceCapture.digest,toolchainDigest:h('a'),checksPassed:true,artifact,preview:null,error:null,
    authority:{operationId:randomUUID(),ownerPid:process.pid,scope:'main-preload-test-doubles',stage:'passed',
      sourceDigest:sourceCapture.digest,rendererDigest:output.digest,definitionDigest:h('b'),observationDigest:h('b'),
      checks:6,nativeBehaviorVerified:false,fullAppQualified:false,error:null},
    seal:{operationId:randomUUID(),ownerPid:process.pid,scope:'full-app-inputs',stage:'sealed',
      sourceDigest:sourceCapture.digest,rendererDigest:output.digest,toolchainDigest:h('a'),dependencyDigest:h('c'),
      fullAppQualified:false,error:null,artifact:{id:randomUUID(),token:randomUUID(),dev:stat.dev,ino:stat.ino,
        digest:h('d'),provenanceDigest:h('e'),entries:2,bytes:100,activationEligible:false}},
    boundBuild:{operationId:randomUUID(),ownerPid:process.pid,scope:'sealed-graph-renderer',stage:'passed',
      inputDigest:h('d'),sourceDigest:sourceCapture.digest,dependencyDigest:h('c'),toolchainDigest:h('a'),
      fullAppQualified:false,error:null,artifact:{id:randomUUID(),token:randomUUID(),dev:renderStat.dev,ino:renderStat.ino,
        rendererDigest:output.digest,boundDigest:h('f'),fileCount:1,activationEligible:false}}}
  const a={id:attemptId,state:'checked',epoch:0,requestedAt:now,cancelledAt:null,statusAt:now,
    preparation:{operationId:randomUUID(),ownerPid:process.pid,source:{root:source,dev:stat.dev,ino:stat.ino,
      gitDev:stat.dev,gitIno:stat.ino,head:'a'.repeat(40),statusDigest:h('a'),dirtyEntries:0,kind:'head',dirtyExcluded:true},
      workspace:{id:randomUUID(),token:randomUUID(),dev:stat.dev,ino:stat.ino},manifestDigest:h('b'),fileCount:2,error:null},
    execution:{operationId:randomUUID(),ownerPid:process.pid,stage:'implemented',port:8080,model:'contract-only',
      files:['src/components/Note.tsx'],inputDigest:h('a'),calls:1,outputDigest:h('b'),error:null},validation}
  fs.mkdirSync(path.join(data,'self-modification'))
  const journal={version:7,lifecycleVersion:7,revision:1,changes:[{id,request:'Contract presentation',
    acceptanceCriteria:'No live authority.',createdAt:now,updatedAt:now,cancellationEpoch:0,attempts:[a]}]}
  const journalPath=path.join(data,'self-modification/changes.json')
  fs.writeFileSync(journalPath,JSON.stringify(journal),{mode:0o600})
  const controller=createChangeController(data),store=createStore(data)
  if(!controller.list().ok)throw new Error('Invalid synthetic fixture journal')
  const legacyQ={version:1,nonce:randomUUID(),artifactDigest:h('e'),policy:'native-trusted-host-renderer-v1',
    nativeWindow:true,protectedPreload:true,fixedBridge:true,rendererReady:true,healthSamples:3,
    kernelDenials:{read:true,write:true,sourceWrite:true,fork:true,network:true},fullAppQualified:false,
    scope:'trusted-host-renderer-only',sourceDigest:sourceCapture.digest,rendererDigest:output.digest,
    hostDigest:h('b'),hostIdentity:{codeDigest:h('b'),version:'synthetic-fixture',origin:{kind:'directory',path:source,archiveSha256:null}},
    runtime:{relativePath:'electron/dist/Electron.app/Contents/MacOS/Electron',sha256:h('a'),pid:process.pid},
    dependencyDigest:h('c'),observationDigest:h('d'),job:path.join(root,'synthetic-native-proof'),
    boundDigest:h('f'),inputDigest:h('d'),sourceIdentityDigest:governance.sourceIdentity(source)}
  const q=currentNativeSynthetic?syntheticQualification(legacyQ):legacyQ
  const targetRoot=path.join(root,'target')
  await supervisor.initializeTarget(targetRoot,old,{hostDigest:q.hostDigest,protectedDigest:governance.protectedDigest(sourceCapture.manifest)})
  const target=supervisor.target(targetRoot)
  const record={versionId:randomUUID(),changeId:id,attemptId,epoch:0,journalRevision:1,stage:'approved',
    scope:'frontend-only-v1',ownerPid:process.pid,createdAt:now,updatedAt:now,qualification:q,reviewDigest:h('a'),
    approval:{id:randomUUID(),artifactDigest:q.artifactDigest,reviewDigest:h('a'),expiresAt:new Date(Date.now()+900000).toISOString()},
    target:{root:targetRoot,dev:target.stat.dev,ino:target.stat.ino,identityDigest:tree.sha(JSON.stringify(target.value))},outcome:null,error:null}
  const workspace={candidateRoot:async()=>source,review:async()=>({ok:true,workspaceId:a.preparation.workspace.id,
    baselineHead:a.preparation.source.head,files:[{path:'src/components/Note.tsx',status:'modified',
      beforeSha256:h('a'),afterSha256:(await tree.capture(source)).manifest.find(f=>f.path.endsWith('Note.tsx')).sha256,
      binary:false,truncated:false,diff:'--- a/src/components/Note.tsx\n+++ b/src/components/Note.tsx\n-old\n+candidate'}]})}
  const checks={qualificationInputs:async(revision,change,attempt,check)=>{
    check()
    return {source,renderer,sourceDigest:(await tree.capture(source)).digest,rendererDigest:(await tree.capture(renderer)).digest,
      boundDigest:q.boundDigest,inputDigest:q.inputDigest}
  }}
  function seed(patch={}) {
    const s=store.read()
    store.mutate(s.revision,records=>records.push({...structuredClone(record),...patch}))
  }
  const health=async options=>({...syntheticQualification(q,options.job,options.startupNonce),
    artifactDigest:options.expectedArtifactDigest,consumer:options.consumerBinding||null})
  const config={userData:data,versionId:record.versionId,root:targetRoot,source,renderer,candidateRoot:source,signal:new AbortController().signal}
  return {root,data,source,renderer,old,id,attemptId,q,legacyQ,record,store,controller,workspace,checks,seed,health,config,journalPath,journal}
}
