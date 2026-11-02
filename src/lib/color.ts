/** Validate colors before handing them to the shared mascot engine. */
export const isHexColor = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
export const asHexColor = (value: unknown, fallback: string): string =>
  isHexColor(value) ? value.trim() : fallback
