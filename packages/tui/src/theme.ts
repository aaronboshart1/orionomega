/**
 * @module theme
 * Visual theme for the OrionOmega TUI.
 */

import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@mariozechner/pi-tui';
import chalk from 'chalk';

const palette = {
  text: '#E8E3D5',
  dim: '#7B7F87',
  accent: '#F6C453',
  border: '#3C414B',
  userBg: '#2B2F36',
  userText: '#F3EEE0',
  systemText: '#9BA3B2',
  code: '#F0C987',
  codeBlock: '#1E232A',
  codeBorder: '#343A45',
  link: '#7DD3A5',
  quote: '#8CC8FF',
  quoteBorder: '#3B4D6B',
  error: '#F97066',
  success: '#7DD3A5',
};

const fg = (hex: string) => (text: string) => chalk.hex(hex)(text);

export const markdownTheme: MarkdownTheme = {
  heading: (t) => chalk.hex(palette.accent).bold(t),
  link: fg(palette.link),
  linkUrl: fg(palette.dim),
  code: fg(palette.code),
  codeBlock: fg(palette.code),
  codeBlockBorder: fg(palette.codeBorder),
  quote: fg(palette.quote),
  quoteBorder: fg(palette.quoteBorder),
  hr: fg(palette.border),
  listBullet: fg(palette.accent),
  bold: (t) => chalk.bold(t),
  italic: (t) => chalk.italic(t),
  strikethrough: (t) => chalk.strikethrough(t),
  underline: (t) => chalk.underline(t),
};

const selectListTheme: SelectListTheme = {
  selectedPrefix: fg(palette.accent),
  selectedText: fg(palette.accent),
  description: fg(palette.dim),
  scrollInfo: fg(palette.dim),
  noMatch: fg(palette.dim),
};

export const editorTheme: EditorTheme = {
  borderColor: fg(palette.border),
  selectList: selectListTheme,
};

/** Formatting helpers for the TUI. */
export const theme = {
  user: (t: string) => chalk.hex(palette.userText)(t),
  userLabel: () => chalk.hex(palette.accent).bold('You'),
  assistant: (t: string) => chalk.hex(palette.text)(t),
  assistantLabel: () => chalk.hex(palette.accent).bold('Ω'),
  system: (t: string) => chalk.hex(palette.systemText)(t),
  dim: (t: string) => chalk.hex(palette.dim)(t),
  error: (t: string) => chalk.hex(palette.error)(t),
  success: (t: string) => chalk.hex(palette.success)(t),
  accent: (t: string) => chalk.hex(palette.accent)(t),
  header: (t: string) => chalk.hex(palette.dim)(t),
  statusConnected: () => chalk.hex(palette.success)('●'),
  statusDisconnected: () => chalk.hex(palette.error)('●'),
};
