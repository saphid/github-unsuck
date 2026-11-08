import { createThemeTools } from './theme-runtime.js';
export { createThemeTools };
export const themeTools = createThemeTools();
export type PaletteTheme = { id: string; family: string; name: string; appearance: string; colors: string[] };
