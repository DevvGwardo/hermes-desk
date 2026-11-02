'use strict'
const path=require('node:path')
const RENDERER='Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)'
function literal(value) {
  if(typeof value!=='string'||!path.isAbsolute(value)||/[\0\r\n]/.test(value)||path.normalize(value)!==value)
    throw Error('Unsafe native policy root')
  return JSON.stringify(value)
}
function policy(root,electronRoot,executable,{hostRoot=path.join(root,'app'),controlRoot=path.join(root,'control')}={}) {
  const home=path.join(root,'home'),tmp=path.join(root,'tmp'),renderer=path.join(electronRoot,RENDERER)
  for(const p of [root,electronRoot,executable,hostRoot,controlRoot])literal(p)
  if(executable!==path.join(electronRoot,'Contents/MacOS/Electron')||!electronRoot.startsWith(root+'/'))
    throw Error('Native policy must name only the exact owned copied runtime')
  const parents=new Set(['/dev','/System','/usr','/Library'])
  for(const p of [root,electronRoot,hostRoot,controlRoot,home,tmp]) {
    for(let a=path.dirname(p);a!=='/';a=path.dirname(a))parents.add(a)
  }
  return `(version 1)
(deny default)
(allow syscall-mig (kernel-mig-routine host_get_io_master))
(allow file-read*
 (literal "/") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom")
 (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS")
 (subpath "/System/Cryptexes/OS") (subpath "/Library/Apple/System/Library")
 (subpath "/System/Cryptexes/App/System/Library/Preferences/Logging")
 (subpath "/usr/lib") (subpath "/usr/share") (subpath "/private/var/db/timezone")
 (subpath ${literal(electronRoot)}) (subpath ${literal(hostRoot)})
 (subpath ${literal(controlRoot)}) (subpath ${literal(home)}) (subpath ${literal(tmp)}))
(deny file-read* (subpath "/System/Library/Keychains") (subpath "/System/Library/Security"))
(allow file-read-metadata ${[...parents].sort().map(p=>`(literal ${literal(p)})`).join(' ')})
(allow file-map-executable (subpath ${literal(electronRoot)}) (subpath ${literal(controlRoot)})
 (subpath "/System") (subpath "/usr/lib") (subpath "/Library/Apple/System"))
(allow file-write* (subpath ${literal(home)}) (subpath ${literal(tmp)}) (literal "/dev/null"))
(allow sysctl-read)
(allow process-fork)
(allow process-info* (target self))
(allow signal (target self))
(allow process-exec (literal ${literal(executable)}))
; Anchored numeric PID supplied by the fixed launcher, never a renderer.
(allow mach-register (global-name (string-append "com.github.Electron.MachPortRendezvousServer." (param "BROWSER_PID"))))
(allow mach-lookup
 (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.lsd.mapdb")
 (global-name "com.apple.windowserver.active") (global-name "com.apple.FontObjectsServer") (global-name "com.apple.fonts"))
(allow iokit-open (iokit-user-client-class "IOSurfaceRootUserClient"))
; Exact Renderer routing exception, NOT a Chromium --no-sandbox switch.
(allow process-exec (literal ${literal(renderer)}) (with no-sandbox))
; Conditional reviewed immutable trusted framework bootstrap only. NOT method confinement.
(allow iokit-open-user-client (iokit-user-client-class "RootDomainUserClient"))
`
}
module.exports={policy,literal,RENDERER}
