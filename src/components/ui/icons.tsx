import { useId } from 'react'
import type { SVGProps } from 'react'

/** Original, optical 20px grid. Never substitute emoji or font glyphs. */
const paths = {
  search: <><circle cx="8.5" cy="8.5" r="5.25" /><path d="m12.5 12.5 4.25 4.25" /></>,
  plus: <path d="M10 4v12M4 10h12" />,
  settings: <><path d="m8 2-.6 2-1.8 1-2-.4-1.8 3.1 1.4 1.5v1.6L1.8 12l1.8 3.1 2-.4 1.8 1 .6 2.3h4l.6-2.3 1.8-1 2 .4 1.8-3.1-1.4-1.2V9.2l1.4-1.5-1.8-3.1-2 .4-1.8-1L12 2Z" /><circle cx="10" cy="10" r="2.7" /></>,
  bell: <><path d="M5.5 8a4.5 4.5 0 0 1 9 0v3l1.5 3H4l1.5-3ZM8 17h4" /></>,
  paperclip: <path d="m7 10 5-5a2.8 2.8 0 0 1 4 4l-7 7a4.25 4.25 0 0 1-6-6l7-7M6 11l6-6" />,
  sidebar: <><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="M7.5 3.5v13" /></>,
  panel: <><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="M12.5 3.5v13" /></>,
  workspace: <><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="M2.5 7.5h15M5 5.5h.01M8 5.5h.01" /></>,
  back: <path d="m8 4-6 6 6 6M2 10h15" />,
  forward: <path d="m12 4 6 6-6 6M18 10H3" />,
  reload: <><path d="M16.5 6A7 7 0 1 0 17 12M16.5 2.5V6H13" /></>,
  send: <><path d="m3 3 14 7-14 7 2-7ZM5 10h12" /></>,
  mic: <><rect x="7" y="2" width="6" height="10" rx="3" /><path d="M4.5 9v1a5.5 5.5 0 0 0 11 0V9M10 15.5V18M7 18h6" /></>,
  stop: <rect x="4.5" y="4.5" width="11" height="11" rx="2" />,
  emoji: <><circle cx="10" cy="10" r="7.5" /><path d="M6.5 8h.01M13.5 8h.01M6.5 12a4 4 0 0 0 7 0" /></>,
  menu: <path d="M4 5h12M4 10h12M4 15h12" />,
  more: <><circle cx="4" cy="10" r=".8" /><circle cx="10" cy="10" r=".8" /><circle cx="16" cy="10" r=".8" /></>,
  copy: <><rect x="6.5" y="6.5" width="10" height="11" rx="2" /><path d="M12.5 6.5v-2a2 2 0 0 0-2-2h-6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" /></>,
  reply: <path d="m8 4-5 5 5 5M3 9h8a5 5 0 0 1 5 5v2" />,
  branch: <><circle cx="6" cy="4" r="2" /><circle cx="6" cy="16" r="2" /><circle cx="15" cy="4" r="2" /><path d="M6 6v8M15 6v1a4 4 0 0 1-4 4H6" /></>,
  retry: <><path d="M3.5 7a7 7 0 1 1-.5 5M3.5 3.5V7H7" /></>,
  check: <path d="m4 10 4 4 8-8" />,
  'check-double': <path d="m2 10 4 4 8-8m-4 7 1 1 7-8" />,
  x: <path d="m5 5 10 10M15 5 5 15" />,
  'chevron-left': <path d="m12.5 5-5 5 5 5" />,
  'chevron-right': <path d="m7.5 5 5 5-5 5" />,
  'chevron-up': <path d="m5 12.5 5-5 5 5" />,
  'chevron-down': <path d="m5 7.5 5 5 5-5" />,
  external: <><path d="M11 3h6v6M17 3l-9 9M8 3H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" /></>,
  lock: <><rect x="4" y="8" width="12" height="9" rx="2" /><path d="M6.5 8V5.5a3.5 3.5 0 0 1 7 0V8M10 12v1.5" /></>,
  globe: <><circle cx="10" cy="10" r="7.5" /><ellipse cx="10" cy="10" rx="3" ry="7.5" /><path d="M2.5 10h15" /></>,
  terminal: <><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="m5.5 7 3 3-3 3M10.5 13H14" /></>,
  file: <><path d="M11 2.5H5a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 5 17.5h10a1.5 1.5 0 0 0 1.5-1.5V8ZM11 2.5V8h5.5M7 11h6M7 14h4" /></>,
  folder: <path d="M2.5 5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h6A1.5 1.5 0 0 1 17.5 7v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15ZM2.5 8h15" />,
  image: <><rect x="2.5" y="2.5" width="15" height="15" rx="2" /><circle cx="6.5" cy="6.5" r="1.5" /><path d="m3 15 4-4 3 3 3-5 4 6" /></>,
  tool: <path d="M11 3a5 5 0 0 0-5.7 6.3L2.8 14a2.25 2.25 0 0 0 3.2 3.2l4.7-4.7A5 5 0 0 0 17 6l-3 3-3-3Z" />,
  sparkle: <><path d="m10 2 2 6 6 2-6 2-2 6-2-6-6-2 6-2ZM16 2v3M14.5 3.5h3" /></>,
  shield: <><path d="m10 2 6.5 2.5V10c0 3.5-3 6-6.5 8-3.5-2-6.5-4.5-6.5-8V4.5Z" /><path d="m7 10 2 2 4-4" /></>,
  pause: <><rect x="5" y="3.5" width="3" height="13" rx="1" /><rect x="12" y="3.5" width="3" height="13" rx="1" /></>,
  play: <path d="m6 3.5 10 6.5-10 6.5Z" />,
  computer: <><rect x="2" y="3" width="16" height="11" rx="2" /><path d="M10 14v3M6 17h8" /></>,
  hand: <path d="M6 10V5.5a1.25 1.25 0 0 1 2.5 0V10 3.5a1.25 1.25 0 0 1 2.5 0V10 5a1.25 1.25 0 0 1 2.5 0v5-2.5a1.25 1.25 0 0 1 2.5 0v5c0 3-2 5.5-5 5.5H9c-2 0-3-1-4-3l-2-3a1.5 1.5 0 0 1 2-2Z" />,
  eye: <><path d="M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10s-3 5.5-8.5 5.5S1.5 10 1.5 10Z" /><circle cx="10" cy="10" r="2.5" /></>,
  move: <path d="M3 6h14l-3-3m3 3-3 3M17 14H3l3 3m-3-3 3-3" />,
  reader: <><rect x="3" y="2.5" width="14" height="15" rx="2" /><path d="M6.5 6.5h7M6.5 10h7M6.5 13.5h4" /></>,
  home: <path d="M3 9 10 3l7 6v7a1.5 1.5 0 0 1-1.5 1.5H12.5v-5h-5v5H4.5A1.5 1.5 0 0 1 3 16Z" />,
  chat: <path d="M5 3.5h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H8l-5 3v-12a2 2 0 0 1 2-2Z" />,
  clock: <><circle cx="10" cy="10" r="7.5" /><path d="M10 5.5V10l3 2" /></>,
  users: <><circle cx="7.5" cy="6" r="3" /><path d="M2 17v-1.5A4.5 4.5 0 0 1 6.5 11h2a4.5 4.5 0 0 1 4.5 4.5V17M13 3.5a3 3 0 0 1 0 5.5M15 11a4.5 4.5 0 0 1 3 4.5V17" /></>,
} as const

export type IconName = keyof typeof paths
export const iconNames = Object.keys(paths) as IconName[]
export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'viewBox' | 'width' | 'height' | 'stroke' | 'strokeWidth' | 'fill' | 'strokeLinecap' | 'strokeLinejoin'> & {
  name: IconName
  size?: number
  title?: string
}

/** Decorative by default; use title only for a meaningful standalone icon. */
export function Icon({ name, size = 20, title, className, ...props }: IconProps) {
  const titleId = useId()
  return <svg {...props}
    className={['desk-icon', className].filter(Boolean).join(' ')}
    width={size} height={size} viewBox="0 0 20 20"
    fill="none" stroke="currentColor" strokeWidth={1.6}
    strokeLinecap="round" strokeLinejoin="round"
    aria-hidden={title ? undefined : true}
    role={title ? 'img' : undefined}
    aria-labelledby={title ? titleId : undefined}
    focusable="false">
    {title && <title id={titleId}>{title}</title>}
    {paths[name]}
  </svg>
}
