'use strict'
// Phase 1 is fixed trusted bootstrap only. No renderer/candidate supplied to
// this API can cross the independent Phase 2 code/authority release gate.
const {policy}=require('./self-modification-native-policy.cjs')
const {RUNTIME}=require('./self-modification-native-runtime.cjs')
const {fingerprint:hostFingerprint}=require('./self-modification-host.cjs')
const {POLICY}=require('./self-modification-native-contract.cjs')
async function qualify() {throw Error('Phase 2 native candidate execution is not released; independent integrated authority critic and explicit parent release required.')}
module.exports={qualify,policy,POLICY,hostFingerprint,RUNTIME}
