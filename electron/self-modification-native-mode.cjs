'use strict'
// Installed only by the immutable external qualification entry, before genuine
// main imports/destructures capabilities. Never activated by renderer/env input.
const fs=require('node:fs')
const path=require('node:path')
let tree // defer app helpers until AFTER their captured native aliases are guarded
let mode=null
const URL_ROOT='hd-native://sealed/'
const BOOT=Buffer.from('<!doctype html><meta charset="utf-8"><title>Trusted native preflight</title><div id="root">TRUSTED INERT PREFLIGHT</div>')
const denial=()=>({ok:false,code:'qualification-readonly',error:'Consequential capability disabled during native qualification.'})
function install(config) {
  if(mode)throw Error('Native qualification mode already installed')
  if(process.versions.electron!=='37.10.3')throw Error('Unsupported sealed Electron guard inventory/version')
  const electron=require('electron'),{app,ipcMain,session,protocol}=electron
  const guards=[],blocked=[],receipts=[],assets=[]
  let win=null,binding=null,released=false,failed=false,bootPromise=null
  const exit=app.exit.bind(app),send=config.send
  function fail(message) {if(failed)return;failed=true;released=false;binding=null;send({type:'fatal',message});exit(81)}
  function blockedCall(name){if(blocked.length<512)blocked.push(name);throw Error('qualification-readonly:'+name)}
  function replace(object,key,fn) {
    if(!object||typeof object[key]!=='function')return
    Object.defineProperty(object,key,{value:fn,configurable:false,writable:false})
    if(object[key]!==fn)throw Error('Guard installation failure:'+key)
    guards.push(key)
  }
  function disable(object,label,known=[],all=true) {
    for(const key of new Set([...known,...(all?Object.keys(object||{}):[])]))
      if(typeof object?.[key]==='function')replace(object,key,()=>blockedCall(label+'.'+key))
  }
  for(const [key,names] of Object.entries({
    shell:['openExternal','openPath','showItemInFolder','trashItem','beep'],
    dialog:['showOpenDialog','showOpenDialogSync','showSaveDialog','showSaveDialogSync','showMessageBox','showMessageBoxSync','showErrorBox'],
    clipboard:['readText','writeText','read','write','clear'],desktopCapturer:['getSources'],
    powerSaveBlocker:['start','stop'],autoUpdater:['setFeedURL','checkForUpdates','quitAndInstall'],
    globalShortcut:['register','registerAll','unregister','unregisterAll'],
    systemPreferences:['askForMediaAccess','isTrustedAccessibilityClient'],
    net:['fetch','request'],
  }))disable(electron[key],key,names)
  disable(require('node:child_process'),'child_process',['spawn','fork','exec','execFile','spawnSync','execSync','execFileSync'])
  disable(require('node:net'),'net',['connect','createConnection','createServer'],false)
  disable(require('node:tls'),'tls',['connect','createServer'],false)
  disable(require('node:http'),'http',['request','get','createServer'],false)
  disable(require('node:https'),'https',['request','get','createServer'],false)
  disable(require('node:dgram'),'dgram',['createSocket'],false)
  for(const [module,ctor,methods] of [
    ['node:net','Socket',['connect']],['node:net','Server',['listen']],
    ['node:tls','TLSSocket',['connect']],['node:http','Agent',['createConnection']],
    ['node:https','Agent',['createConnection']],['node:dgram','Socket',['bind','connect','send']],
  ])for(const key of methods)replace(require(module)[ctor]?.prototype,key,()=>blockedCall(module+'.'+ctor+'.'+key))
  replace(globalThis,'fetch',()=>blockedCall('fetch'))
  replace(globalThis,'WebSocket',()=>blockedCall('WebSocket'))
  replace(require('node:worker_threads'),'Worker',()=>blockedCall('Worker'))
  replace(process,'dlopen',()=>blockedCall('native-plugin'))
  for(const key of ['relaunch','setAsDefaultProtocolClient','removeAsDefaultProtocolClient','setLoginItemSettings'])
    replace(app,key,()=>blockedCall('app.'+key))
  const constructors=new Map()
  let construction=null
  for(const key of ['Notification','Tray','WebContentsView']) {
    const ctor=electron[key]
    if(typeof ctor==='function')constructors.set(key,new Proxy(ctor,{construct:()=>blockedCall(key)}))
  }
  constructors.set('BrowserWindow',new Proxy(electron.BrowserWindow,{construct:(ctor,args)=>{
    const p=args[0]?.webPreferences
    if(construction||!p||p.preload!==config.preload||p.nodeIntegration!==false||p.contextIsolation!==true||
      p.sandbox!==true||p.disableDialogs!==true||p.webviewTag!==false||p.webSecurity!==true||
      JSON.stringify(p.additionalArguments)!==JSON.stringify(['--hd-native-readonly-preload-v1']))
      throw Error('Genuine BrowserWindow constructor preferences unsafe/additional window')
    construction=Object.freeze({preload:p.preload,preloadSha256:tree.sha(tree.readFile(p.preload).bytes)})
    return Reflect.construct(ctor,args,ctor)
  }}))
  // Electron exports these constructors through non-configurable getters.
  // Interpose the genuine module view BEFORE any application destructuring;
  // every other native object/constructor remains the genuine Electron object.
  const facade=new Proxy(electron,{get:(object,key)=>constructors.get(key)||Reflect.get(object,key)})
  const Module=require('node:module'),load=Module._load
  replace(Module,'_load',function(request,parent,isMain) {
    const result=load.call(this,request,parent,isMain)
    return result===electron?facade:result
  })
  guards.push(...[...constructors.keys()].map(key=>'constructor:'+key))
  replace(electron.Menu,'setApplicationMenu',()=>{if(blocked.length<512)blocked.push('native:menu-suppressed')})
  replace(electron.Menu,'sendActionToFirstResponder',()=>blockedCall('Menu.sendActionToFirstResponder'))
  tree=require('./self-modification-artifact.cjs')
  function identity() {
    if(!win||win.isDestroyed())throw Error('Missing genuine primary window')
    const wc=win.webContents,pid=wc.getOSProcessId(),metrics=app.getAppMetrics()
    const browser=metrics.find(m=>m.pid===process.pid&&m.type==='Browser')
    const renderer=metrics.find(m=>m.pid===pid&&m.type==='Tab')
    if(!browser||!renderer||browser.sandboxed!==true||renderer.sandboxed!==true||
      !Number.isFinite(browser.creationTime)||!Number.isFinite(renderer.creationTime))
      throw Error('Unknown actual native PID/creation/sandbox evidence:'+JSON.stringify({pid,metrics}))
    return {windowId:win.id,webContentsId:wc.id,pid,creationTime:renderer.creationTime,
      browserPid:process.pid,browserCreationTime:browser.creationTime}
  }
  function assertBinding() {
    if(!binding||failed||JSON.stringify(binding)!==JSON.stringify(identity()))
      throw Error('Preflight PID/window binding invalidated')
    return true
  }
  function allowEvent(event) {
    return win&&!win.isDestroyed()&&event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame&&
      event.sender.getURL()===URL_ROOT+'index.html'
  }
  function wrapIpc(object) {
    const handle=object.handle?.bind(object)
    if(handle)replace(object,'handle',(channel,fn)=>handle(channel,async(event,...args)=>{
      if(channel!=='hd:changes:list'||args.length||!allowEvent(event)) {
        if(blocked.length<512)blocked.push('invoke:'+channel);return denial()
      }
      const value=await fn(event,...args) // GENUINE passive controller, never a replacement handler
      const id=identity()
      receipts.push({channel,topFrame:true,...id,ok:value?.ok===true,revision:value?.revision})
      if(receipts.length>64)throw Error('Bridge receipt limit')
      return value
    }))
    for(const key of ['on','once','addListener','prependListener','prependOnceListener']) {
      const on=object[key]?.bind(object)
      if(on)replace(object,key,(channel,_fn)=>on(channel,(event)=>{
        if(blocked.length<512)blocked.push('event:'+channel)
        if(event)event.returnValue=denial()
      }))
    }
    replace(object,'handleOnce',(channel,_fn)=>handle(channel,event=>{event.returnValue=denial();return denial()}))
  }
  wrapIpc(ipcMain)
  function finalizeIpc() {
    // Unknown/unregistered genuine preload methods also hit the qualification
    // fence; only the original genuine passive list implementation can pass.
    for(const [kind,channel] of config.channels) {
      if(kind==='invoke'&&!ipcMain._invokeHandlers.has(channel))
        ipcMain.handle(channel,()=>denial())
      else if(kind!=='invoke'&&!ipcMain.listenerCount(channel))
        ipcMain.on(channel,event=>{event.returnValue=denial()})
    }
  }
  const sessions=new WeakSet(),permissionAudit=new WeakMap()
  const rawProtocols=new WeakSet()
  let brokerRegistrationDepth=0
  function protectProtocol(p) {
    if(!p||rawProtocols.has(p))return
    rawProtocols.add(p)
    for(const key of ['handle','registerFileProtocol','registerBufferProtocol','registerStringProtocol','registerStreamProtocol',
      'registerHttpProtocol','interceptFileProtocol','interceptBufferProtocol','interceptStringProtocol','interceptStreamProtocol',
      'interceptHttpProtocol','unhandle','unregisterProtocol','uninterceptProtocol'])
      {
        const raw=p[key]
        replace(p,key,function(...args){
          // Fixed top-level broker registration delegates synchronously to the
          // default session. No exposed caller can set this private depth.
          if(brokerRegistrationDepth===1&&args[0]==='hd-native')return raw.apply(this,args)
          return blockedCall('protocol.'+key)
        })
      }
  }
  function protectSession(ses) {
    if(!ses||sessions.has(ses))return
    sessions.add(ses)
    const request=ses.setPermissionRequestHandler.bind(ses),check=ses.setPermissionCheckHandler.bind(ses)
    const device=ses.setDevicePermissionHandler.bind(ses),display=ses.setDisplayMediaRequestHandler.bind(ses)
    const denyRequest=(_wc,_permission,callback)=>callback(false),denyCheck=()=>false,denyDisplay=(_request,callback)=>callback({})
    request(denyRequest);check(denyCheck);device(denyCheck);display(denyDisplay)
    permissionAudit.set(ses,{denyRequest,denyCheck,denyDisplay})
    replace(ses,'setPermissionRequestHandler',()=>request(denyRequest))
    replace(ses,'setPermissionCheckHandler',()=>check(denyCheck))
    replace(ses,'setDevicePermissionHandler',()=>device(denyCheck))
    replace(ses,'setDisplayMediaRequestHandler',()=>display(denyDisplay))
    for(const key of ['set','remove','flushStore']) {
      if(typeof ses.cookies?.[key]!=='function')throw Error('Unsupported sealed cookie guard shape')
      replace(ses.cookies,key,()=>blockedCall('session.cookies.'+key))
    }
    for(const key of ['addWordToSpellCheckerDictionary','clearStorageData','setPreloads','setCertificateVerifyProc',
      'setProxy','resolveProxy','enableNetworkEmulation','downloadURL','getBlobData'])
      replace(ses,key,()=>blockedCall('session.'+key))
    ses.on('will-download',event=>event.preventDefault())
    ses.on('select-hid-device',(event,_details,callback)=>{event.preventDefault();callback('')})
    ses.on('select-usb-device',(event,_details,callback)=>{event.preventDefault();callback('')})
    ses.on('serial-port-added',()=>{})
    const before=ses.webRequest.onBeforeRequest.bind(ses.webRequest)
    const onBefore=(details,callback)=>{
      let cancel=true
      try {
        const parsed=new URL(details.url)
        const own=win&&!win.isDestroyed()&&details.webContentsId===win.webContents.id
        const file=assetName(parsed)
        const top=details.resourceType==='mainFrame'
        cancel=!own||details.method!=='GET'||details.resourceType==='subFrame'||
          !file||!(top?file==='index.html':released&&config.manifest.some(f=>f.path===file))
        if(!cancel&&released)assertBinding()
      }catch{cancel=true}
      callback({cancel})
    }
    before({urls:['<all_urls>']},onBefore)
    replace(ses.webRequest,'onBeforeRequest',()=>before({urls:['<all_urls>']},onBefore))
    protectProtocol(ses.protocol)
  }
  const register=protocol.registerSchemesAsPrivileged.bind(protocol)
  const handle=protocol.handle.bind(protocol)
  register([{scheme:'hd-native',privileges:{standard:true,secure:true,supportFetchAPI:true}}])
  replace(protocol,'registerSchemesAsPrivileged',()=>blockedCall('additional-scheme'))
  function assetName(parsed) {
    if(parsed.protocol!=='hd-native:'||parsed.hostname!=='sealed'||parsed.port||parsed.username||parsed.password||parsed.search||parsed.hash)return null
    const raw=parsed.pathname.slice(1)
    if(!raw||/%|\\|[\0\r\n]/.test(raw)||raw.split('/').some(p=>!p||p==='.'||p==='..'))return null
    return raw
  }
  const csp="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  async function response(request) {
    try {
      const name=assetName(new URL(request.url))
      if(request.method!=='GET'||!name||!win||win.isDestroyed())return new Response(null,{status:403})
      if(!released) {
        if(name!=='index.html')return new Response(null,{status:403})
        return new Response(BOOT,{headers:{'Content-Type':'text/html','Content-Security-Policy':"default-src 'none'; base-uri 'none'; frame-src 'none'"}})
      }
      assertBinding()
      if(!config.manifest.some(f=>f.path===name))return new Response(null,{status:403})
      const bytes=tree.readAsset(config.renderer,config.manifest,name)
      if(name.endsWith('.html')&&/<(?:[a-z0-9_-]+:)?(?:iframe|frame|object|embed)(?:[\s/>]|$)/i.test(bytes.toString('utf8')))
        throw Error('Initial parser subframe/native object construction refused')
      if(assets.length>=128)throw Error('Asset broker observation bound')
      assets.push({path:name,sha256:tree.sha(bytes),size:bytes.length,pid:binding.pid,
        creationTime:binding.creationTime,windowId:binding.windowId,webContentsId:binding.webContentsId})
      const type=name.endsWith('.html')?'text/html':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'application/octet-stream'
      return new Response(bytes,{headers:{'Content-Type':type,'Content-Security-Policy':csp,'X-Content-Type-Options':'nosniff'}})
    }catch(error){fail(error.message);return new Response(null,{status:403})}
  }
  app.on('session-created',protectSession)
  const from=session.fromPartition.bind(session)
  replace(session,'fromPartition',(...args)=>{const s=from(...args);protectSession(s);return s})
  for(const event of ['open-url','open-file'])app.on(event,e=>e.preventDefault())
  app.on('certificate-error',(_event,_wc,_url,_error,_certificate,callback)=>callback(false))
  app.on('web-contents-created',(_event,wc)=>{
    wrapIpc(wc.ipc)
    wc.setWindowOpenHandler(()=>({action:'deny'}))
    replace(wc,'setWindowOpenHandler',()=>{}) // no later handler can enable a popup
    for(const event of ['will-navigate','will-redirect','will-attach-webview'])wc.on(event,e=>e.preventDefault())
    wc.on('render-process-gone',()=>fail('Renderer process rotated/gone'))
    wc.on('did-fail-load',(_e,code)=>{if(code!==-3)fail('Native document load failed')})
    wc.on('will-frame-navigate',(event,separateDetails)=>{
      // Electron 37 details-on-event and the explicit separate-details form.
      // ALWAYS cancel the genuine event first. Metadata is never an event.
      if(typeof event?.preventDefault!=='function'){fail('Unsupported uncancellable frame event');return}
      try{event.preventDefault()}catch{fail('Frame event cancellation failed');return}
      const details=separateDetails===undefined?event:separateDetails
      if(!details||typeof details.isMainFrame!=='boolean'){fail('Unknown frame navigation shape');return}
      if(!details.isMainFrame){if(blocked.length<512)blocked.push('native:subframe-navigation');return}
      try {
        if(!win||wc!==win.webContents||details.isSameDocument!==false||details.frame!==wc.mainFrame||
          !Number.isSafeInteger(details.frame?.processId)||!Number.isSafeInteger(details.frame?.routingId)||
          details.frame.processId<1||details.frame.routingId<1||
          typeof details.url!=='string'||new URL(details.url).href!==details.url||
          assetName(new URL(details.url))!=='index.html')throw Error('Unknown main frame/origin')
        if(blocked.length<512)blocked.push('native:main-frame-navigation-denied')
      }catch{fail('Unbound frame navigation rejected')}
      // Programmatic trusted loadURL does not emit this event; page navigation
      // never dispatches even for the canonical sealed index.
    })
    protectSession(wc.session)
    for(const key of ['downloadURL','print','printToPDF','capturePage','openDevTools','setDevToolsWebContents'])
      replace(wc,key,()=>blockedCall('webContents.'+key))
  })
  app.whenReady().then(()=>{
    brokerRegistrationDepth=1
    try {handle('hd-native',response)} finally {brokerRegistrationDepth=0}
    protectSession(session.defaultSession);protectProtocol(protocol)
  })
  process.on('uncaughtException',error=>fail(error.message))
  process.on('unhandledRejection',error=>fail(String(error)))
  app.disableHardwareAcceleration();app.enableSandbox()
  for(const [key,value] of [['in-process-gpu',''],['enable-features','NetworkServiceInProcess2']])app.commandLine.appendSwitch(key,value)
  mode=Object.freeze({
    active:true,passiveReadOnly:true,
    finalizeIpc,
    loadWindow:window=>{
      bootPromise=(async()=>{
      if(win)throw Error('Only the genuine primary qualification window is allowed')
      win=window
      // Only inert CSP-none trusted HTML may load before the chooser CDP guard.
      // Page.enable otherwise waits for a renderer that navigation has not yet
      // created. No candidate/negative script is available at this point.
      await win.loadURL(URL_ROOT+'index.html')
      const debuggerClient=win.webContents.debugger
      debuggerClient.attach('1.3')
      await debuggerClient.sendCommand('Page.enable')
      await debuggerClient.sendCommand('Page.setInterceptFileChooserDialog',{enabled:true})
      guards.push('file-chooser:intercept-installed')
      debuggerClient.on('message',(_event,method,params)=>{
        if(method==='Page.fileChooserOpened'){if(blocked.length<512)blocked.push('native:file-chooser')}
        if(method==='Page.javascriptDialogOpening'){
          // CDP reports even a disabled, browser-handler-free dialog. Never
          // accept an actual native handler, and dismiss only with accept:false.
          if(params.hasBrowserHandler!==false){fail('Native dialog handler unexpected:'+JSON.stringify(params));return}
          if(blocked.length<512)blocked.push('native:dialog-browser-handler:false')
          debuggerClient.sendCommand('Page.handleJavaScriptDialog',{accept:false})
            .then(()=>{if(blocked.length<512)blocked.push('native:dialog-dismissed')})
            .catch(error=>fail('Native dialog denial acknowledgment missing:'+error.message))
        }
      })
      })()
      return bootPromise
    },
    preflight:async()=>{
      await app.whenReady()
      for(let n=0;!bootPromise&&n<100;n++)await new Promise(resolve=>setTimeout(resolve,50))
      if(!bootPromise)throw Error('Genuine primary window never created')
      await bootPromise
      const id=identity(),p=win.webContents.getLastWebPreferences()
      if(p.sandbox!==true||p.contextIsolation!==true||p.nodeIntegration!==false||p.nodeIntegrationInSubFrames!==false||
        p.webSecurity!==true||p.disableDialogs!==true||p.webviewTag!==false||
        !construction||construction.preload!==config.preload||p.allowRunningInsecureContent!==false)
        throw Error('Actual genuine window preferences unsafe:'+JSON.stringify(p))
      if(['no-sandbox','disable-sandbox','disable-setuid-sandbox','disable-gpu-sandbox','enable-packaged-dev'].some(k=>app.commandLine.hasSwitch(k)))
        throw Error('Unsafe native switches')
      const surface=await win.webContents.executeJavaScript(`['alert','confirm','prompt','print','open','showOpenFilePicker','showSaveFilePicker','showDirectoryPicker'].every(key=>{
        const d=Object.getOwnPropertyDescriptor(window,key);return !!d&&d.configurable===false&&d.writable===false&&typeof d.value==='function'
      })`)
      if(surface!==true)throw Error('Actual before-load native surface guards missing')
      guards.push('document-start:native-surface-guard-observed')
      // Fixed trusted tests run in the inert document BEFORE any supplied
      // renderer script. No candidate-returned assertion becomes a receipt.
      const surfaceTests=await win.webContents.executeJavaScript(`(async()=>{
        const denied=async fn=>{try{await fn();return false}catch(e){return e?.name==='NotAllowedError'}}
        let leaked=0,prototypePoison=false
        const originalApply=Reflect.apply,originalTest=RegExp.prototype.test
        try {
          Reflect.apply=()=>{leaked++;throw Error('Counterfeit page reflection')}
          RegExp.prototype.test=()=>false
          prototypePoison=await denied(()=>document.createElementNS('http://www.w3.org/1999/xhtml','x:iframe'))&&
            await denied(()=>document.body.insertAdjacentHTML('beforeend','<iframe></iframe>'))&&
            document.createElement('div').localName==='div'&&leaked===0
        } finally {Reflect.apply=originalApply;RegExp.prototype.test=originalTest}
        return {
          prototypePoison,
          subframe:await denied(()=>document.createElement('iframe')),
          subframeParser:await denied(()=>document.body.insertAdjacentHTML('beforeend','<iframe src="about:blank"></iframe>')),
          fsa:await denied(()=>window.showOpenFilePicker()),
          clipboardRead:await denied(()=>navigator.clipboard.readText()),
          clipboardWrite:await denied(()=>navigator.clipboard.writeText('OWNED SYNTHETIC NEVER WRITTEN')),
          capture:await denied(()=>navigator.mediaDevices.getDisplayMedia({video:true})),
          media:await denied(()=>navigator.mediaDevices.getUserMedia({audio:true})),
          mediaEnumeration:await denied(()=>navigator.mediaDevices.enumerateDevices()),
          wake:await denied(()=>navigator.wakeLock.request('screen'))
        }
      })()`)
      const nativeAliases={}
      for(const [key,fn] of [
        ['clipboard',()=>electron.clipboard.readText()],
        ['capture',()=>electron.desktopCapturer.getSources({types:['screen']})],
        ['sessionProxy',()=>win.webContents.session.setProxy({proxyRules:'direct://'})],
        ['sessionProtocol',()=>win.webContents.session.protocol.registerHttpProtocol('fixed-negative',()=>{})],
        ['sessionCookie',()=>win.webContents.session.cookies.set({url:'https://example.invalid',name:'synthetic',value:'never written'})],
        ['dialogOpen',()=>electron.dialog.showOpenDialog({})],
        ['dialogSave',()=>electron.dialog.showSaveDialog({})],
        ['openExternal',()=>electron.shell.openExternal('https://example.invalid')],
        ['spawn',()=>require('node:child_process').spawn('/usr/bin/true')],
        ['tray',()=>new facade.Tray('NEVER LOADED')],
        ['notification',()=>new facade.Notification({title:'NEVER SHOWN'})],
        ['updater',()=>electron.autoUpdater.checkForUpdates()],
        ['nativePlugin',()=>process.dlopen({},'NEVER LOADED')],
      ]) {
        nativeAliases[key]=false
        try{fn()}catch(error){nativeAliases[key]=error.message.startsWith('qualification-readonly:')}
      }
      const barrier=await win.webContents.executeJavaScript('('+require('./self-modification-native-surface-probe.cjs').probe.toString()+')()')
      const permissions=permissionAudit.get(win.webContents.session)
      if(!permissions)throw Error('Actual installed session permission policy missing')
      let permissionRequest,displayRequest
      permissions.denyRequest(win.webContents,'media',v=>permissionRequest=v)
      permissions.denyDisplay({},v=>displayRequest=v)
      const permissionEvidence={requestDenied:permissionRequest===false,checkDenied:permissions.denyCheck()===false,
        deviceDenied:permissions.denyCheck()===false,displayDenied:JSON.stringify(displayRequest)==='{}'}
      if(Object.values(permissionEvidence).some(v=>v!==true))throw Error('Session permission denial missing')
      const surfaceEvidence={source:'fixed-trusted-inert-main-before-release',runtimeVersion:process.versions.electron,
        surface:surfaceTests,nativeAliases,barrier,permissionEvidence,inventoryDigest:tree.sha(JSON.stringify(barrier.inventory))}
      if(Object.values(surfaceTests).some(v=>v!==true)||Object.values(nativeAliases).some(v=>v!==true))
        throw Error('Fixed before-OS native surface denial missing')
      const result=await win.webContents.executeJavaScript('window.nubAgent.changes.list()')
      if(result?.ok!==true||!receipts.length)throw Error('Genuine passive bridge receipt missing')
      if(JSON.stringify(id)!==JSON.stringify(identity()))throw Error('Renderer rotated during preflight')
      return {identity:id,preferences:{sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,
        disableDialogs:p.disableDialogs,preload:construction.preload,preloadSha256:construction.preloadSha256,
        preloadProvenance:'actual-genuine-constructor-and-passive-bridge'},metrics:app.getAppMetrics(),guards,receipts:[...receipts],
        surfaceEvidence}
    },
    release:async expected=>{
      if(binding||released)throw Error('Preflight release is one-shot')
      if(JSON.stringify(expected)!==JSON.stringify(identity()))throw Error('Stale external preflight release')
      binding=expected;released=true
      await win.webContents.loadURL(URL_ROOT+'index.html')
      assertBinding()
    },
    observe:async()=>{
      assertBinding()
      // Isolated observer world owns its DOM prototypes; mainworld tampering
      // cannot counterfeit this trusted observation or main-owned IPC receipts.
      const value=await win.webContents.executeJavaScriptInIsolatedWorld(947,[{code:
        `({complete:document.readyState==='complete',root:!!document.querySelector('#root'),nodeAbsent:typeof require==='undefined'&&typeof process==='undefined'})`}])
      assertBinding()
      return {value,identity:binding,assets:[...assets],blocked:[...blocked],receipts:[...receipts],metrics:app.getAppMetrics()}
    },
    stop:()=>{released=false;binding=null;if(win&&!win.isDestroyed())win.destroy();exit(0)},
  })
  return mode
}
module.exports={install,current:()=>mode,URL_ROOT,BOOT,denial}
