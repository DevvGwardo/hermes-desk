import type { PartPose, Pose } from './types'

export const IDENTITY_POSE: Pose = { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1 }
export const fullPose = (pose?: PartPose): Pose => ({ ...IDENTITY_POSE, ...pose })
export const num = (n: number): string => String(Math.round(n * 10000) / 10000)

/** SVG applies right to left: unpivot, scale, rotate, repivot, translate. */
export function composeTransform(pose: Pose, pivot: readonly number[]): string {
  const [x, y] = pivot
  return `translate(${num(pose.tx)} ${num(pose.ty)}) translate(${x} ${y}) rotate(${num(pose.rotate)}) scale(${num(pose.sx)} ${num(pose.sy)}) translate(${-x} ${-y})`
}

export type Matrix = [number, number, number, number, number, number]
export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0]
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}
export function poseMatrix(pose: Pose, [x, y]: readonly number[]): Matrix {
  const r = pose.rotate * Math.PI / 180
  const a = Math.cos(r) * pose.sx
  const b = Math.sin(r) * pose.sx
  const c = -Math.sin(r) * pose.sy
  const d = Math.cos(r) * pose.sy
  return [a, b, c, d, pose.tx + x - a * x - c * y, pose.ty + y - b * x - d * y]
}
export function transformPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/** Parse authored SVG transforms once, so FX also follow their geometry. */
export function authoredMatrix(transform: string): Matrix {
  let result: Matrix = [...IDENTITY_MATRIX]
  for (const match of transform.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]+)\)/g)) {
    const values = (match[2].match(/[-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number)
    if (!values.length || !values.every(Number.isFinite)) continue
    const [a, b] = values
    let local: Matrix = [...IDENTITY_MATRIX]
    if (match[1] === 'matrix' && values.length === 6) local = values as Matrix
    if (match[1] === 'translate') local = [1, 0, 0, 1, a, b ?? 0]
    if (match[1] === 'scale') local = [a, 0, 0, b ?? a, 0, 0]
    if (match[1] === 'rotate') local = poseMatrix(fullPose({ rotate: a }), [b ?? 0, values[2] ?? 0])
    if (match[1] === 'skewX') local[2] = Math.tan(a * Math.PI / 180)
    if (match[1] === 'skewY') local[1] = Math.tan(a * Math.PI / 180)
    result = multiply(result, local)
  }
  return result
}
