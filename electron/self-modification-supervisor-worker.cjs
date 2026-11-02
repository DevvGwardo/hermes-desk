'use strict'
// Fixed worker entry. No command or JavaScript crosses the renderer boundary.
const supervisor = require('./self-modification-supervisor.cjs')
const abort = new AbortController()
process.once('SIGTERM',()=>abort.abort())
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data',c=>{input+=c;if(Buffer.byteLength(input)>16384) process.exit(2)})
process.stdin.on('end',async()=>{
  try {
    const options = JSON.parse(input)
    if(options.action==='recover')supervisor.recoveryAuthority(options.root,options.versionId,options)
    const result = options.action === 'recover' ? await supervisor.recover(options.root,options.versionId,options) :
      options.action === 'activate' ? await supervisor.activate({...options,signal:abort.signal}) :
        (()=>{throw new Error('Unsupported supervisor action')})()
    process.stdout.write(JSON.stringify({ok:true,result})+'\n')
  } catch(e) {process.stdout.write(JSON.stringify({ok:false,error:e.message.slice(0,500)})+'\n');process.exitCode=1}
})
