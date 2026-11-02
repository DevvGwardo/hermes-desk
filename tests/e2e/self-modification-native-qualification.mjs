// Native Electron, exact protected host and copied dependencies. No live app.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
const tree = require('../../electron/self-modification-artifact.cjs')
const seals = require('../../electron/self-modification-seal.cjs')
const baseline = require('../../electron/self-modification-baseline.cjs')
const {runGit} = require('../../electron/self-modification-workspace.cjs')
const repo = path.resolve(import.meta.dirname,'../..')
const root = fs.realpathSync(fs.mkdtempSync('/tmp/hd-selfedit-2026-10-13-native-'))
const report = {root,checks:[],failure:null}
try {
  const snapshot = await baseline.snapshot(repo,runGit)
  const source = path.join(root,'source')
  tree.materialize(source,snapshot.files)
  const dependencies = await seals.capture(path.join(repo,'node_modules'),{allowLinks:true,maxTotal:1024*1024*1024})
  await seals.copy(path.join(repo,'node_modules'),path.join(source,'node_modules'),dependencies,()=>{})
  const renderer = path.join(root,'renderer')
  const config = path.join(root,'fixed-vite.mjs')
  fs.writeFileSync(config,`import react from ${JSON.stringify(require.resolve('@vitejs/plugin-react',{paths:[source]}))}
import tailwind from ${JSON.stringify(require.resolve('@tailwindcss/vite',{paths:[source]}))}
export default {root:${JSON.stringify(source)},base:'./',envDir:${JSON.stringify(root)},
  plugins:[react({babel:{babelrc:false,configFile:false}}),tailwind()],css:{postcss:{plugins:[]}},
  build:{outDir:${JSON.stringify(renderer)},reportCompressedSize:false}}
`)
  execFileSync(process.execPath,[path.join(source,'node_modules/vite/bin/vite.js'),'build','--config',config,'--configLoader','native'],
    {cwd:source,timeout:120000,stdio:'pipe',env:{PATH:process.env.PATH,HOME:root,TMPDIR:root}})
  const probe = path.join(root,'protected.txt')
  fs.writeFileSync(probe,'protected owned native probe')
  // Load the already frozen trusted controller copy. Concurrent repository
  // edits cannot silently substitute the tested native host or its observer.
  const native = require(path.join(source,'electron/self-modification-native.cjs'))
  report.sourceFingerprint = snapshot.digest
  report.dependencyFingerprint = dependencies.digest
  const result = await native.qualify({source,renderer,job:path.join(root,'native'),protectedProbe:probe,signal:new AbortController().signal})
  assert.equal(result.scope,'trusted-host-renderer-only')
  assert.equal(result.fullAppQualified,false)
  assert.equal(result.fixedBridge,true)
  assert.equal(fs.readFileSync(probe,'utf8'),'protected owned native probe')
  report.result=result
  report.checks.push('Real Electron main/preload, hardened window, actual fixed primary-frame IPC and multiple renderer health observations')
  report.checks.push('Kernel denies protected reads/writes, frozen host writes, shell execution and unmanaged localhost network')
  report.checks.push('Exact source, host, copied graph and renderer bytes retained and bound; no unrestricted full-app qualification')
} catch(e) {report.failure=e.stack;process.exitCode=1}
fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2))
console.log(JSON.stringify(report,null,2))
