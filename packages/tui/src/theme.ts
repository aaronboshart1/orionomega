/**
 * @module theme
 * Visual theme for the OrionOmega TUI.
 * Single source of truth for colors, spacing, icons, box-drawing, and formatting helpers.
 *
 * ALL rendering components must import from here — no local palette definitions.
 */

import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@mariozechner/pi-tui';
import chalk from 'chalk';

// ── Canonical Color Palette ──────────────────────────────────────
// Resolved from 4 conflicting local palettes. Decision: majority wins.

export const palette = {
  // Core text
  text: '#ABB2BF',         // Primary body text
  textBright: '#E8E3D5',   // Emphasized text, user messages
  dim: '#5C6370',          // Metadata, timestamps, secondary
  systemText: '#9BA3B2',   // System message text

  // Brand
  accent: '#F6C453',       // Gold — labels, highlights, active items

  // Semantic status
  success: '#7DD3A5',      // Success, connected, completions
  error: '#F97066',        // Error, failure, disconnected
  warning: '#E5C07B',      // Warning, degraded, pending
  info: '#61AFEF',         // Informational, running, links
  purple: '#C678DD',       // Special highlights, model badges

  // Structural
  border: '#3C414B',       // Panel borders, separators, rules
  borderAccent: '#F6C453', // Highlighted/active panel borders
  bg: '#1A1D23',           // Background tint (where needed)

  // Code / Markdown
  codeFg: '#F0C987',       // Inline code text
  codeBg: '#1E232A',       // Code block background
  codeBorder: '#343A45',   // Code block border
  link: '#7DD3A5',         // Links, URLs
  quote: '#8CC8FF',        // Blockquote text
  quoteBorder: '#3B4D6B',  // Blockquote border

  // User messages
  userBg: '#2B2F36',       // User message background tint
  userText: '#F3EEE0',     // User message text
} as const;

// ── Spacing Constants ────────────────────────────────────────────

export const spacing = {
  /** Left padding for top-level elements (header, status bar, tracker header) */
  indent1: '  ',
  /** Left padding for nested elements (tracker nodes, plan items) */
  indent2: '    ',
  /** Left padding for deeply nested elements (dependencies, sub-items) */
  indent3: '      ',
  /** Separator between inline parts (status bar segments) */
  separator: ' │ ',
  /** Separator between list items */
  dot: ' · ',
  /** Gap between label and value on same line */
  labelGap: '  ',
  /** Margin parameter for pi-tui Text/Markdown components */
  componentMarginX: 1,
  componentMarginY: 0,
} as const;

// ── Icon Constants ───────────────────────────────────────────────
// No overloading — each concept gets a unique icon.

export const icons = {
  // Connection status
  connected: '●',
  disconnected: '●',

  // Task/node status
  pending: '○',
  // running: use omegaSpinner.current (animated)
  complete: '✓',
  error: '✗',
  warning: '⚠',

  // UI element indicators
  model: '⬡',
  workflow: '◆',
  worker: '⚙',
  command: '›',         // Was ⚡ — disambiguated from workflowName
  workflowName: '⚡',
  plan: '📋',
  cost: '$',
  time: '⏱',
  info: 'ℹ',

  // Node types (in plan overlay)
  codingAgent: '💻',
  loopNode: '🔁',
  agentNode: '🔧',

  // Events
  finding: '💡',
  approved: '✓',
  rejected: '✗',
  modified: '✏️',

  // Tree connectors
  treeMiddle: '├',
  treeLast: '└',

  // Collapse/expand
  collapsed: '▸',
  expanded: '▾',

  // Additional status
  skipped: '⊘',
  paused: '⏸',
  files: '📁',

  // Punctuation
  separator: '│',
  dot: '·',
  arrow: '→',
  chevron: '›',
} as const;

// ── Box-Drawing Characters ───────────────────────────────────────
// Rounded corners for modern aesthetic.

export const box = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
  teeRight: '├',
  teeLeft: '┤',
  teeDown: '┬',
  teeUp: '┴',
  cross: '┼',
  heavyHorizontal: '━',
  doubleHorizontal: '═',
} as const;

// ── Chalk Helpers ────────────────────────────────────────────────

const fg = (hex: string) => (text: string) => chalk.hex(hex)(text);

export const markdownTheme: MarkdownTheme = {
  heading: (t) => chalk.hex(palette.accent).bold(t),
  link: fg(palette.link),
  linkUrl: fg(palette.dim),
  code: fg(palette.codeFg),
  codeBlock: fg(palette.codeFg),
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
  // ── Text roles ──
  user: (t: string) => chalk.hex(palette.userText)(t),
  userLabel: () => chalk.hex(palette.accent).bold('You'),
  assistant: (t: string) => chalk.hex(palette.text)(t),
  assistantLabel: () => chalk.hex(palette.accent).bold('Ω'),
  system: (t: string) => chalk.hex(palette.systemText)(t),

  // ── Colors ──
  dim: (t: string) => chalk.hex(palette.dim)(t),
  error: (t: string) => chalk.hex(palette.error)(t),
  success: (t: string) => chalk.hex(palette.success)(t),
  accent: (t: string) => chalk.hex(palette.accent)(t),
  info: (t: string) => chalk.hex(palette.info)(t),
  warning: (t: string) => chalk.hex(palette.warning)(t),
  purple: (t: string) => chalk.hex(palette.purple)(t),

  // ── Typography hierarchy ──
  bold: (t: string) => chalk.bold(t),
  /** App header — bold accent (was dim, which inverted the hierarchy). */
  header: (t: string) => chalk.hex(palette.accent).bold(t),
  /** Primary labels (agent names, field names). */
  label: (t: string) => chalk.hex(palette.accent).bold(t),
  /** Normal values. */
  value: (t: string) => chalk.hex(palette.text)(t),
  /** Metadata, secondary info. */
  meta: (t: string) => chalk.hex(palette.dim)(t),
  /** Section titles (plan title, workflow name). */
  sectionTitle: (t: string) => chalk.hex(palette.accent).bold(t),
  /** Layer/subsection titles. */
  layerTitle: (t: string) => chalk.hex(palette.info).bold(t),

  // ── Status indicators ──
  statusConnected: () => chalk.hex(palette.success)(icons.connected),
  statusDisconnected: () => chalk.hex(palette.error)(icons.disconnected),
};
