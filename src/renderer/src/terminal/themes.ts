import type { ITheme } from '@xterm/xterm'
import type { AppTheme } from '../../../shared/types'

// The 16 ANSI colors matter as much as background/foreground: Claude Code's own box-drawing
// and status text use them directly, and xterm's built-in defaults are tuned for dark
// backgrounds — on white (or a mismatched preset) they read as low-contrast/washed out
// without an explicit palette matching each theme.
export const XTERM_THEMES: Record<AppTheme, ITheme> = {
  light: {
    background: '#ffffff',
    foreground: '#1c1e21',
    cursor: '#0f9d63',
    black: '#1c1e21',
    red: '#cf222e',
    green: '#1a7f37',
    yellow: '#9a6700',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#116329',
    brightYellow: '#4d2d00',
    brightBlue: '#0550ae',
    brightMagenta: '#6639ba',
    brightCyan: '#3192aa',
    brightWhite: '#1c1e21'
  },
  dark: {
    background: '#1c1e21',
    foreground: '#d4d4d4',
    cursor: '#4ee2a3',
    black: '#1c1e21',
    red: '#f85149',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#d4d4d4',
    brightBlack: '#6e7681',
    brightRed: '#ff7b72',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc'
  },
  dracula: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#50fa7b',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff'
  },
  nord: {
    background: '#2e3440',
    foreground: '#e5e9f0',
    cursor: '#88c0d0',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4'
  },
  solarized: {
    background: '#002b36',
    foreground: '#93a1a1',
    cursor: '#2aa198',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3'
  }
}

export function xtermThemeFor(theme: AppTheme): ITheme {
  return XTERM_THEMES[theme]
}
