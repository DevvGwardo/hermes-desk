'use strict'
// Fixed trusted inert-document probe. NEVER exposed to a renderer as an evaluator.
// Every consequential invocation first requires our nonconfigurable guard tag.
async function probe() {
  const inventory=window.__hdNativeSurfaceInventory
  if(!Array.isArray(inventory)||!Object.isFrozen(inventory)||!inventory.length||inventory.length>256||
    inventory.some(r=>r.state==='unsupported-synthetic-only'))throw Error('Native surface inventory unavailable')
  const descriptor=Object.getOwnPropertyDescriptor,apply=Reflect.apply
  const lookup=(label)=>{
    const parts=label.split('.'),family=parts.shift()
    let key=parts.pop()
    if(label==='video.PiP')key='requestPictureInPicture'
    if(label==='document.exitPiP')key='exitPictureInPicture'
    const families={window,clipboard:navigator.clipboard,media:navigator.mediaDevices,wake:navigator.wakeLock,
      credentials:navigator.credentials,permissions:navigator.permissions,navigator,WebAuthn:globalThis.PublicKeyCredential,
      documentPiP:window.documentPictureInPicture,video:HTMLVideoElement.prototype,document:Document.prototype,
      element:Element.prototype,input:HTMLInputElement.prototype,select:HTMLSelectElement.prototype}
    if(family==='parser') {
      const o=parts[0]==='shadow'?ShadowRoot.prototype:
        key==='parseFromString'?DOMParser.prototype:key==='createContextualFragment'?Range.prototype:
          ['createElement','createElementNS','write','writeln'].includes(key)?Document.prototype:Element.prototype
      return {o,key,set:['innerHTML','outerHTML'].includes(key)}
    }
    if(family==='insert') {
      const o={node:Node.prototype,element:Element.prototype,document:Document.prototype,
        fragment:DocumentFragment.prototype,range:Range.prototype}[parts[0]]
      return {o,key}
    }
    if(family==='frame')return {o:globalThis[parts[0]]?.prototype,key,set:true}
    return {o:families[family],key}
  }
  const results=[]
  for(const row of inventory) {
    if(row.label==='input.file-color-and-select.click'||row.label==='input.pointer-keyboard-default-action')continue
    const {o,key,set}=lookup(row.label),fn=set?descriptor(o,key)?.set:o?.[key]
    if(row.state==='absent') {
      if(fn!==undefined)throw Error('Native absence inventory changed: '+row.label)
      results.push({label:row.label,state:row.state,route:'actual-runtime-reflection',outcome:'unavailable',denials:0});continue
    }
    const tag=fn&&descriptor(fn,'__hdNativeGuard')
    if(!tag||tag.configurable!==false||tag.writable!==false||
      !['deny-before-effect','parser-insertion-before-effect'].includes(tag.value))
      throw Error('Before-effect guard not sealed: '+row.label)
    const before=window.__hdNativeSurfaceDenials
    let threw=false
    try {
      if(row.label.startsWith('insert.'))apply(fn,{},[{}])
      else if(row.label==='parser.createElementNS')apply(fn,document,['http://www.w3.org/1999/xhtml','x:iframe'])
      else if(row.label==='parser.createElement')apply(fn,document,['iframe'])
      else if(row.label==='parser.insertAdjacentHTML')apply(fn,document.body,['beforeend','<iframe></iframe>'])
      else if(row.label==='parser.parseFromString')apply(fn,new DOMParser(),['<iframe></iframe>','text/html'])
      else if(row.label==='parser.createContextualFragment')apply(fn,document.createRange(),['<iframe></iframe>'])
      else if(row.label.startsWith('parser.'))apply(fn,{},['<iframe></iframe>'])
      else if(set)apply(fn,{},['about:blank'])
      else await apply(fn,o,[])
    }catch(error){threw=true;if(!row.label.startsWith('insert.')&&error?.name!=='NotAllowedError')throw error}
    const delta=window.__hdNativeSurfaceDenials-before
    if(row.label.startsWith('insert.')?!threw:delta!==1)throw Error('Guard delegation/denial counter missing: '+row.label)
    results.push({label:row.label,state:row.state,route:'sealed-method-or-prototype-reflection',
      outcome:row.label.startsWith('insert.')?'native-brand-rejected':'denied-before-effect',denials:delta})
  }
  if(typeof window.__hdNativeInsertionProof!=='function')throw Error('Private detached-native-node insertion proof missing')
  results.push(...window.__hdNativeInsertionProof())
  const controls=[]
  for(const kind of ['file','color','select']) {
    const node=document.createElement(kind==='select'?'select':'input')
    if(kind!=='select')node.type=kind
    let before=window.__hdNativeSurfaceDenials
    apply(HTMLElement.prototype.click,node,[])
    if(window.__hdNativeSurfaceDenials-before!==1)throw Error('Generic click alias delegated: '+kind)
    results.push({label:'input.'+kind+'.click',state:'guarded',route:'HTMLElement.prototype.click',outcome:'denied-before-effect',denials:1})
    document.body.appendChild(node)
    for(const eventType of ['pointerdown','mousedown','click','dblclick','keydown','keyup','beforeinput']) {
      before=window.__hdNativeSurfaceDenials
      const e=new Event(eventType,{bubbles:true,cancelable:true,composed:true})
      node.dispatchEvent(e)
      if(!e.defaultPrevented||window.__hdNativeSurfaceDenials-before<1)throw Error('Pointer/keyboard default action escaped: '+kind+':'+eventType)
      results.push({label:'input.'+kind+'.'+eventType,state:'guarded',route:'actual-document-capture',
        outcome:'default-prevented-before-effect',denials:window.__hdNativeSurfaceDenials-before})
    }
    node.remove()
  }
  // Adversarial activation routes the fixed probe must also deny: a page
  // window-capture listener that stops propagation, a color control inside a
  // closed shadow root, and a control whose type is mutated after the gate ran.
  const adversarial=(label,node,setup,teardown)=>{
    try {
      if(setup)setup()
      for(const eventType of ['click','keydown']) {
        const before=window.__hdNativeSurfaceDenials
        const e=new Event(eventType,{bubbles:true,cancelable:true,composed:true})
        node.dispatchEvent(e)
        if(!e.defaultPrevented||window.__hdNativeSurfaceDenials-before<1)
          throw Error('Adversarial native activation escaped: '+label+':'+eventType)
        results.push({label:'input.'+label+'.'+eventType,state:'guarded',route:'actual-adversarial-'+label,
          outcome:'default-prevented-before-effect',denials:window.__hdNativeSurfaceDenials-before})
      }
    } finally { if(teardown)teardown(); node.remove() }
  }
  {
    const node=document.createElement('input');node.type='color';document.body.appendChild(node)
    const stop=e=>e.stopPropagation()
    adversarial('window-capture',node,()=>window.addEventListener('click',stop,true),()=>window.removeEventListener('click',stop,true))
  }
  {
    const host=document.createElement('div');document.body.appendChild(host)
    const shadow=host.attachShadow({mode:'closed'})
    const node=document.createElement('input');node.type='color';shadow.appendChild(node)
    adversarial('closed-shadow',node,null,()=>host.remove())
  }
  {
    const node=document.createElement('input');node.type='text';document.body.appendChild(node)
    const mutate=()=>{node.type='color'}
    adversarial('type-mutation',node,()=>node.addEventListener('click',mutate),()=>node.removeEventListener('click',mutate))
  }
  {
    // Closed root plus an ancestor capture listener that stops propagation before
    // the root listener can run. The outer retargeted pass must still deny it.
    const host=document.createElement('div');document.body.appendChild(host)
    const shadow=host.attachShadow({mode:'closed'})
    const node=document.createElement('input');node.type='color';shadow.appendChild(node)
    const stop=e=>e.stopPropagation()
    adversarial('closed-shadow-starved',node,()=>window.addEventListener('click',stop,true),()=>{window.removeEventListener('click',stop,true);host.remove()})
  }
  {
    // Page replaces the intrinsic addEventListener with a no-op before calling
    // attachShadow, so the wrapped root must still receive the gate.
    const host=document.createElement('div');document.body.appendChild(host)
    let shadow
    const node=document.createElement('input');node.type='color'
    const original=EventTarget.prototype.addEventListener
    const setup=()=>{EventTarget.prototype.addEventListener=function(){}
      shadow=host.attachShadow({mode:'closed'});shadow.appendChild(node);EventTarget.prototype.addEventListener=original}
    adversarial('replaced-addEventListener',node,setup,()=>host.remove())
  }
  const div=document.createElement('div')
  div.innerHTML='<p>SAFE ORDINARY DOM</p>'
  document.body.appendChild(div)
  const fragment=document.createRange().createContextualFragment('<p>SAFE FRAGMENT</p>')
  div.appendChild(fragment)
  const shadow=div.attachShadow({mode:'open'})
  shadow.innerHTML='<p>SAFE SHADOW</p>'
  const parsed=new DOMParser().parseFromString('<p>SAFE PARSER</p>','text/html')
  controls.push(div.localName==='div',div.querySelectorAll('p').length===2,
    shadow.querySelector('p').textContent==='SAFE SHADOW',parsed.body.querySelector('p').textContent==='SAFE PARSER')
  div.remove()
  if(controls.some(v=>v!==true))throw Error('Ordinary renderer DOM disabled')
  return {inventory,results,controls}
}
module.exports={probe}
