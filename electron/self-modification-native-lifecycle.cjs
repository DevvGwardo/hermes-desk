'use strict'
// One latched failure races EVERY asynchronous phase, including clean shutdown.
function lifecycle(signal,deadlineMs=45000) {
  const started=Date.now()
  let failure=null,rejectFailure
  const failed=new Promise((_,reject)=>{rejectFailure=reject})
  failed.catch(()=>{}) // latched even between waiters, without unhandled rejection
  const fail=error=>{if(!failure){failure=error instanceof Error?error:new Error(String(error));rejectFailure(failure)}}
  const abort=()=>fail(Error('Fixed native Phase1 cancelled'))
  signal.addEventListener('abort',abort,{once:true})
  if(signal.aborted)abort()
  const timer=setTimeout(()=>fail(Error('Fixed native Phase1 45-second deadline')),deadlineMs)
  const check=()=>{
    if(Date.now()-started>=deadlineMs)fail(Error('Fixed native Phase1 45-second deadline'))
    if(failure)throw failure
  }
  async function race(work){check();const value=await Promise.race([work,failed]);check();return value}
  async function shutdown(closed,request,timeoutMs=3000) {
    check()
    let timer
    try {
      const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{const e=Error('Fixed native shutdown acknowledgment deadline');fail(e);reject(e)},timeoutMs)})
      request()
      return await race(Promise.race([closed,deadline]))
    } finally {clearTimeout(timer)}
  }
  return {fail,check,race,shutdown,get failure(){return failure},
    dispose(){clearTimeout(timer);signal.removeEventListener('abort',abort)}}
}
module.exports={lifecycle}
