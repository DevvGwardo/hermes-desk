// FIXED trusted bootstrap/negative code only; never model/candidate compilation.
import fs from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const root=fs.realpathSync(fs.mkdtempSync('/tmp/hd-native-phase1-fixed-'))
const job=root+'/run'
console.log(JSON.stringify({root,job,scope:'fixed-trusted-phase1-only'}))
const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),300000)
try {
  const report=await require('./self-modification-native-phase1.cjs').run({job,signal:abort.signal})
  console.log(JSON.stringify({job,failure:report.failure,checks:report.checks,digests:report.digests}))
  if(report.failure)process.exitCode=1
} finally {clearTimeout(timer)}
