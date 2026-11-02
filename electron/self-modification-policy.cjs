'use strict'

// This is the authority boundary, not a suggestion to the model. Everything
// outside the small presentation surface remains byte-for-byte immutable.
const crypto = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')
const POLICY = 'frontend-only-v1'
const PROTECTED = /(?:^|\/)(?:[^/]*(?:storage|persist|migration|compatibility|journal|settings|auth|credential|permission|security|secret|policy|approval|activation|bridge|transport|session|room|runtime|self-modification|genui|ImproveHermesDesk|SourcePreparation|CandidateImplementation|CandidateValidation|MessageBody|TranscriptRow)[^/]*)(?:\/|$)/i
// Names only, before opening bytes or requesting Git blobs. Source modules such
// as auth.cjs / secrets.ts remain protected inputs, not credential data.
function sensitivePath(name) {
  return typeof name !== 'string' || name.split('/').some(part =>
    part !== '.env.example' && (
      /^(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|\.pypirc$|\.ssh$|\.aws$|\.gnupg$|id_(?:rsa|ed25519)(?:\.|$))/i.test(part) ||
      /\.(?:pem|key|p12|pfx|db|sqlite(?:3)?)(?:\.|$)/i.test(part) ||
      /^(?:auth|credentials?|secrets?|tokens?|cookies?|passwords?|api[-_]?keys?|state|settings|sessions?)\.(?:json|ya?ml|toml|ini|cfg|conf|txt|db|sqlite(?:3)?)(?:\.|$)/i.test(part)
    ))
}
function sourcePath(name) {
  return typeof name === 'string' && name.length <= 1024 && !/[\0\\]/.test(name) &&
    !path.posix.isAbsolute(name) && name.split('/').every(p => p && p !== '.' && p !== '..' && !p.startsWith('.')) &&
    (/^(?:src|public|electron)\//.test(name) ||
      /^(?:index\.html|package(?:-lock)?\.json|tsconfig(?:\.[a-z-]+)?\.json|vite\.config\.ts)$/.test(name)) &&
    !/(?:^|\/)(?:node_modules|__pycache__|artifacts|fixtures)(?:\/|$)/.test(name) &&
    !/\.(?:pyc|log)$/i.test(name) && !sensitivePath(name)
}
function editable(name) {
  return sourcePath(name) && !PROTECTED.test(name) &&
    (/^src\/components\/[A-Za-z0-9_/-]+\.(?:tsx|css)$/.test(name) ||
      /^src\/(?:assets\/[A-Za-z0-9_/-]+\.(?:svg|png|jpg|webp)|(?:index|App)\.css)$/.test(name) ||
      /^public\/[A-Za-z0-9_/-]+\.(?:svg|png|jpg|webp|css)$/.test(name))
}
function assertEditable(name) {
  if (!editable(name)) throw Object.assign(new Error(`Protected path: ${String(name).slice(0, 160)}. Frontend v1 permits presentation files only; native host, permissions, dependencies, build controls and persistence are immutable.`),
    { workspaceCode: 'invalid', validationCode: 'invalid' })
}
function verifyDiff(files) {
  for (const file of files) if (file.status !== 'unchanged') assertEditable(file.path)
}
function protectedDigest(manifest) {
  return crypto.createHash('sha256').update(JSON.stringify(manifest.filter(f => !editable(f.path))
    .map(f => [f.path, f.sha256, f.size, !!(f.mode & 0o111)]).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex')
}
function sourceIdentity(root) {
  const identities=[]
  let count=0,bytes=0
  const metadata=s=>[s.dev,s.ino,s.size,s.mode,s.nlink,s.mtimeMs,s.ctimeMs]
  function walk(folder,relative='',depth=0) {
    const before=fs.lstatSync(folder)
    if(!before.isDirectory()||before.isSymbolicLink()||depth>32) throw new Error('Source identity changed')
    identities.push([relative,'directory',...metadata(before)])
    for(const name of fs.readdirSync(folder).sort()) {
      if(++count>10000) throw new Error('Source identity entry limit')
      const file=path.join(folder,name),stat=fs.lstatSync(file)
      if(stat.isDirectory()) walk(file,relative+name+'/',depth+1)
      else {
        if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>2*1024*1024||
          (bytes+=stat.size)>128*1024*1024) throw new Error('Unsafe source identity')
        identities.push([relative+name,'file',...metadata(stat)])
      }
    }
    if(JSON.stringify(metadata(before))!==JSON.stringify(metadata(fs.lstatSync(folder)))) throw new Error('Source identity changed during observation')
  }
  walk(root)
  return crypto.createHash('sha256').update(JSON.stringify(identities)).digest('hex')
}
module.exports = { POLICY, sensitivePath, sourcePath, editable, assertEditable, verifyDiff, protectedDigest, sourceIdentity }
