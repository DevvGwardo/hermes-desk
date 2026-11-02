import { useCallback, useLayoutEffect, useRef, useState } from 'react'

type Handler = () => void | Promise<unknown>

/** Stable row callbacks; async results belong to their original thread/root. */
export function useTurnControls(threadKey: string, rootId: string | null | undefined, onRetryTurn?: Handler, onStopTurn?: Handler) {
  // Stop/retry are handed to memo'd rows, so they must not churn identity on
  // every render (that would defeat the TranscriptRow bail-out). Route them
  // through refs and expose one stable wrapper each.
  const [retryBusy, setRetryBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [turnControlNote, setTurnControlNote] = useState<string | null>(null)
  const retryRequestRef = useRef<object | null>(null)
  const stopRequestRef = useRef<object | null>(null)
  const onRetryTurnRef = useRef(onRetryTurn)
  onRetryTurnRef.current = onRetryTurn
  const onStopTurnRef = useRef(onStopTurn)
  onStopTurnRef.current = onStopTurn

  useLayoutEffect(() => {
    retryRequestRef.current = null
    stopRequestRef.current = null
    setRetryBusy(false)
    setStopping(false)
    setTurnControlNote(null)
    return () => {
      retryRequestRef.current = null
      stopRequestRef.current = null
    }
  }, [threadKey, rootId])

  const runTurnControl = useCallback(async (kind: 'retry' | 'stop') => {
    const pending = kind === 'retry' ? retryRequestRef : stopRequestRef
    const handler = kind === 'retry' ? onRetryTurnRef.current : onStopTurnRef.current
    const setBusy = kind === 'retry' ? setRetryBusy : setStopping
    if (!handler || pending.current) return
    const request = {}
    const failure = kind === 'retry'
      ? 'Couldn’t retry this turn. Try again.'
      : 'Couldn’t stop the agent. It may still be running. Try again.'
    pending.current = request
    setBusy(true)
    setTurnControlNote(null)
    try {
      const result = await handler()
      if (result === false && pending.current === request) setTurnControlNote(failure)
    } catch {
      if (pending.current === request) setTurnControlNote(failure)
    } finally {
      if (pending.current === request) {
        pending.current = null
        setBusy(false)
      }
    }
  }, [])
  const retryTransportTurn = useCallback(() => { void runTurnControl('retry') }, [runTurnControl])
  const stopRunningTurn = useCallback(() => { void runTurnControl('stop') }, [runTurnControl])

  return { retryBusy, stopping, turnControlNote, setTurnControlNote, retryTransportTurn, stopRunningTurn }
}
