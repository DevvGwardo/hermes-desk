import { useEffect, useState } from 'react'

/**
 * Returns `true` forever after the first time `open` was ever true.
 *
 * Used with React.lazy panels: the chunk must not load until the user first
 * opens the panel (render-on-open), but once opened, the panel stays mounted
 * so its internal state survives close/reopen exactly as it did when every
 * panel was statically imported and always mounted.
 */
export function useEverOpened(open: boolean): boolean {
  const [ever, setEver] = useState(open)
  useEffect(() => {
    if (open) setEver(true)
  }, [open])
  return ever
}
