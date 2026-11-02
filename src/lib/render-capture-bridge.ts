// Keep the optional capture implementation out of the boot/error-boundary chunk.
let reporter: ((error: unknown, componentStack?: string) => void) | undefined
export function setRenderFailureReporter(next: typeof reporter) { reporter = next }
export function reportRenderFailure(error: unknown, componentStack?: string) { reporter?.(error, componentStack) }
