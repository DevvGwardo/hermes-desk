'use strict'
// This preload is ONLY for the independent immutable read-only review window.
// It exposes no application bridge, file/command access, or reusable grant.
const {contextBridge,ipcRenderer}=require('electron')
const token=process.argv.find(a=>a.startsWith('--self-edit-review-token='))?.slice('--self-edit-review-token='.length)
if(typeof token!=='string'||!/^[a-f0-9-]{36}$/.test(token)) throw new Error('Missing scoped native review token')
contextBridge.exposeInMainWorld('hdNativeReview',Object.freeze({
  decide:allow=>typeof allow==='boolean'?ipcRenderer.invoke(`hd:self-edit-review:${token}`,allow):Promise.resolve(false),
}))
