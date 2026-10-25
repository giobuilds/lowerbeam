/** Window colours: the desktop's, or a choice kept with the app's settings. */
export const THEME_CHOICES = ['system', 'light', 'dark'] as const

export type ThemeChoice = (typeof THEME_CHOICES)[number]
