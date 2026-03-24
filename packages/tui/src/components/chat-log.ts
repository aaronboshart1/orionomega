/**
 * @module components/chat-log
 * Chat log component with capped ring buffer and viewport rendering.
 * Messages are stored in memory — render() returns only visible lines.
 */

import { Container, Markdown, Spacer, Text } from '@mariozechner/pi-tui';
import type { Component } from '@mariozechner/pi-tui';
import type { DisplayMessage } from '../gateway-client.js';
import { markdownTheme, theme, spacing, palette, box } from '../theme.js';
import { truncate } from '../utils/format.js';
import { omegaSpinner } from './omega-spinner.js';
import chalk from 'chalk';

interface ChatEntry {
  component: Component;
  role: 'user' | 'assistant' | 'system';
}

/**
 * Chat log that holds all messages and renders them as a scrollable document.
 * The container grows downward; pi-tui's differential renderer handles the viewport.
 */
export class ChatLog extends Container {
  private readonly maxEntries: number;
  private entries: ChatEntry[] = [];
  private streamingComponent: Markdown | null = null;
  private streamingLabel: Text | null = null;
  private thinkingComponent: Text | null = null;
  private thinkingText = '';
  private unsubSpinner: (() => void) | null = null;
  private lastRole: 'user' | 'assistant' | 'system' | null = null;
  private lastUserMessage: string | null = null;
  private pendingUserMessages: string[] = [];
  onUpdate?: () => void;

  constructor(maxEntries = 200) {
    super();
    this.maxEntries = maxEntries;
  }

  private addDivider(): void {
    const rule = chalk.hex(palette.border)(box.horizontal.repeat(70));
    const divider = new Text(rule, spacing.componentMarginX, 0);
    this.addChild(divider);
  }

  private addContextReference(userMsg: string): void {
    const truncMsg = truncate(userMsg, 60);
    const ref = new Text(
      chalk.hex(palette.dim)(`  ↳ re: "${truncMsg}"`),
      spacing.componentMarginX,
      0,
    );
    this.addChild(ref);
  }

  addMessage(msg: DisplayMessage): void {
    if (msg.role === 'user') {
      if (this.lastRole !== null) {
        this.addChild(new Spacer(1));
        this.addDivider();
      }
      this.addChild(new Spacer(1));

      const label = new Text(
        theme.userLabel() + spacing.labelGap + theme.user(msg.content),
        spacing.componentMarginX,
        spacing.componentMarginY,
      );
      this.addChild(label);
      this.entries.push({ component: label, role: 'user' });

      this.lastUserMessage = msg.content;
      this.pendingUserMessages.push(msg.content);
      this.lastRole = 'user';
    } else if (msg.raw) {
      this.addChild(new Spacer(1));
      const rawLines = msg.raw.split('\n');
      for (const line of rawLines) {
        const t = new Text(line, spacing.componentMarginX, spacing.componentMarginY);
        this.addChild(t);
      }
      this.entries.push({ component: new Text('', 0, 0), role: 'system' });
      this.lastRole = 'system';
    } else if (msg.role === 'system') {
      this.addChild(new Spacer(1));
      const prefix = msg.emoji ? `${msg.emoji} ` : '';
      const text = new Text(
        theme.system(prefix + msg.content),
        spacing.componentMarginX,
        spacing.componentMarginY,
      );
      this.addChild(text);
      this.entries.push({ component: text, role: 'system' });
      this.lastRole = 'system';
    } else {
      const needsContext = this.lastRole !== 'user' && this.pendingUserMessages.length > 0;

      this.addChild(new Spacer(1));

      const label = new Text(
        theme.assistantLabel(),
        spacing.componentMarginX,
        spacing.componentMarginY,
      );
      this.addChild(label);

      if (needsContext) {
        const refMsg = this.pendingUserMessages.shift() ?? this.lastUserMessage;
        if (refMsg) {
          this.addContextReference(refMsg);
        }
      } else {
        this.pendingUserMessages.shift();
      }

      const md = new Markdown(
        msg.content,
        spacing.componentMarginX,
        spacing.componentMarginY,
        markdownTheme,
      );
      this.addChild(md);
      this.entries.push({ component: md, role: 'assistant' });
      this.lastRole = 'assistant';
    }

    this.pruneOverflow();
  }

  updateStreaming(content: string): void {
    if (!this.streamingComponent) {
      const needsContext = this.lastRole !== 'user' && this.pendingUserMessages.length > 0;

      this.addChild(new Spacer(1));
      this.streamingLabel = new Text(
        theme.assistantLabel(),
        spacing.componentMarginX,
        spacing.componentMarginY,
      );
      this.addChild(this.streamingLabel);

      if (needsContext) {
        const refMsg = this.pendingUserMessages[0] ?? this.lastUserMessage;
        if (refMsg) {
          this.addContextReference(refMsg);
        }
      }

      this.streamingComponent = new Markdown(
        content,
        spacing.componentMarginX,
        spacing.componentMarginY,
        markdownTheme,
      );
      this.addChild(this.streamingComponent);
    } else {
      this.streamingComponent.setText(content);
    }
  }

  clearStreaming(): void {
    if (this.streamingComponent) {
      this.removeChild(this.streamingComponent);
      this.streamingComponent = null;
    }
    if (this.streamingLabel) {
      this.removeChild(this.streamingLabel);
      this.streamingLabel = null;
    }
  }

  updateThinking(text: string): void {
    if (!text) {
      if (this.thinkingComponent) {
        this.removeChild(this.thinkingComponent);
        this.thinkingComponent = null;
      }
      if (this.unsubSpinner) {
        this.unsubSpinner();
        this.unsubSpinner = null;
      }
      this.thinkingText = '';
      return;
    }

    this.thinkingText = text;
    const truncated = truncate(text, 100);
    const display = theme.dim(`${omegaSpinner.current} ${truncated}`);

    if (!this.thinkingComponent) {
      this.thinkingComponent = new Text(display, spacing.componentMarginX, spacing.componentMarginY);
      this.addChild(this.thinkingComponent);
      this.unsubSpinner = omegaSpinner.subscribe(() => {
        if (this.thinkingComponent && this.thinkingText) {
          const t = truncate(this.thinkingText, 100);
          this.thinkingComponent.setText(theme.dim(`${omegaSpinner.current} ${t}`));
          this.onUpdate?.();
        }
      });
    } else {
      this.thinkingComponent.setText(display);
    }
  }

  clearAll(): void {
    this.clear();
    this.entries = [];
    this.streamingComponent = null;
    this.streamingLabel = null;
    if (this.unsubSpinner) {
      this.unsubSpinner();
      this.unsubSpinner = null;
    }
    this.thinkingComponent = null;
    this.thinkingText = '';
    this.lastRole = null;
    this.lastUserMessage = null;
    this.pendingUserMessages = [];
  }

  private pruneOverflow(): void {
    while (this.entries.length > this.maxEntries) {
      const oldest = this.entries.shift();
      if (oldest) {
        this.removeChild(oldest.component);
      }
    }
  }
}
