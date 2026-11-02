/** Build optimization flag only. Transport selection never depends on it. */
export const isProdBuild = (): boolean => import.meta.env.PROD
