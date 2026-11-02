'use strict'
const path=require('node:path')
const {randomUUID}=require('node:crypto')
const escape=value=>String(value).replace(/[\u202a-\u202e\u2066-\u2069\0]/g,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
function document(title,detail,nonce) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>body{font:14px system-ui;margin:0;padding:24px;color:#202025;background:#fafafa}h1{font-size:20px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #bbb;background:white;padding:16px;max-height:65vh;overflow:auto}
button{margin:16px 12px 0 0;padding:10px 16px}label{display:block}p{max-width:80ch}</style></head>
<body><h1>${escape(title)}</h1><p>Independent trusted read-only review. No candidate code, application bridge, network, plugins or activation runs here.
Directional/control characters are visibly escaped. Complete exact content and digest bindings follow.</p>
<pre>${escape(detail)}</pre><label><input id="reviewed" type="checkbox">I reviewed the complete exact baseline or artifact diff and its scope.</label>
<button id="cancel" autofocus>Cancel</button><button id="continue" disabled>Continue to separate native confirmation</button>
<script nonce="${nonce}">const reviewed=document.getElementById('reviewed'), next=document.getElementById('continue');
reviewed.addEventListener('change',e=>{if(e.isTrusted)next.disabled=!reviewed.checked});
document.getElementById('cancel').addEventListener('click',e=>{if(e.isTrusted)window.hdNativeReview.decide(false)});
next.addEventListener('click',e=>{if(e.isTrusted&&reviewed.checked)window.hdNativeReview.decide(true)});
document.addEventListener('keydown',e=>{if(e.isTrusted&&e.key==='Escape')window.hdNativeReview.decide(false)});
</script></body></html>`
}
async function read({parent,title,detail}) {
  if(typeof title!=='string'||typeof detail!=='string'||Buffer.byteLength(detail)>17*1024*1024)
    throw new Error('Independent review exceeds its bounded complete display')
  const {BrowserWindow,ipcMain,session}=require('electron')
  const token=randomUUID(),channel=`hd:self-edit-review:${token}`,scheme='hd-self-edit-review'
  const url=`${scheme}://${token}/index.html`,nonce=randomUUID(),html=document(title,detail,nonce)
  const isolated=session.fromPartition(`self-edit-review-${token}`,{cache:false})
  await isolated.protocol.handle(scheme,request=>{
    if(request.url!==url||request.method!=='GET') return new Response('Denied',{status:403})
    return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8',
      'Content-Security-Policy':`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`}})
  })
  const win=new BrowserWindow({parent,modal:true,show:false,width:1000,height:800,title,
    webPreferences:{session:isolated,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,
      preload:path.join(__dirname,'self-modification-review-preload.cjs'),additionalArguments:[`--self-edit-review-token=${token}`]}})
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}))
  win.webContents.on('will-navigate',e=>e.preventDefault())
  let settled=false,finish,timer
  const result=new Promise(resolve=>{
    finish=allow=>{if(settled)return;settled=true;resolve(allow);if(!win.isDestroyed())win.destroy()}
    timer=setTimeout(()=>finish(false),900000)
    win.on('closed',()=>finish(false))
    win.webContents.on('render-process-gone',()=>finish(false))
    ipcMain.handle(channel,(event,...args)=>{
      if(settled||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||
        event.senderFrame.url!==url||args.length!==1||typeof args[0]!=='boolean') return false
      finish(args[0]);return true
    })
  })
  try {await win.loadURL(url);if(!settled)win.show();return await result}
  catch(e) {finish(false);throw e}
  finally {clearTimeout(timer);ipcMain.removeHandler(channel);isolated.protocol.unhandle(scheme)}
}
module.exports={read,document,escape}
