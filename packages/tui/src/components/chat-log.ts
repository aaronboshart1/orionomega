/**
 * @module components/chat-log
 * Chat log component with capped ring buffer and viewport rendering.
 * Messages are stored in memory — render() returns only visible lines.
 */

import { Container, Markdown, Spacer, Text } from '@mariozechner/pi-tui';
import type { Component } from '@mariozechner/pi-tui';
import type { DisplayMessage } from '../gateway-client.js';
import { markdownTheme, theme, spacing } from '../theme.js';
import { truncate } from '../utils/format.js';
import { omegaSpinner } from './omega-spinner.js';

/** A rendered message component with metadata. */
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
  private thinkingComponent: Text | null = null;
  private thinkingText = '';
  private unsubSpinner: (() => void) | null = null;
  /** Wire this to tui.requestRender() for spinner-driven re-renders. */
  onUpdate?: () => void;

  constructor(maxEntries = 200) {
    super();
    this.maxEntries = maxEntries;
  }

  /** Add a completed message to the log. */
  addMessage(msg: DisplayMessage): void {
    // Spacer between messages
    const spacer = new Spacer(1);
    this.addChild(spacer);

    if (msg.role === 'user') {
      const label = new Text(theme.userLabel() + spacing.labelGap + theme.user(msg.content), spacing.componentMarginX, spacing.componentMarginY);
      this.addChild(label);
      this.entries.push({ component: label, role: 'user' });
    } else if (msg.raw) {
      // Pre-formatted ANSI content — render each line as a Text component
      const rawLines = msg.raw.split('\n');
      for (const line of rawLines) {
        const t = new Text(line, spacing.componentMarginX, spacing.componentMarginY);
        this.addChild(t);
      }
      this.entries.push({ component: new Text('', 0, 0), role: 'system' });
    } else if (msg.role === 'system') {
      const prefix = msg.emoji ? `${msg.emoji} ` : '';
      const text = new Text(theme.system(prefix + msg.content), spacing.componentMarginX, spacing.componentMarginY);
      this.addChild(text);
      this.entries.push({ component: text, role: 'system' });
    } else {
      // Assistant — render as markdown
      const label = new Text(theme.assistantLabel(), spacing.componentMarginX, spacing.componentMarginY);
      this.addChild(label);
      const md = new Markdown(msg.content, spacing.componentMarginX, spacing.componentMarginY, markdownTheme);
      this.addChild(md);
      this.entries.push({ component: md, role: 'assistant' });
    }

    this.pruneOverflow();
  }

  /** Start or update a streaming assistant message. */
  updateStreaming(content: string): void {
    if (!this.streamingComponent) {
      const spacer = new Spacer(1);
      this.addChild(spacer);
      const label = new Text(theme.assistantLabel(), spacing.componentMarginX, spacing.componentMarginY);
      this.addChild(label);
      this.streamingComponent = new Markdown(content, spacing.componentMarginX, spacing.componentMarginY, markdownTheme);
      this.addChild(this.streamingComponent);
    } else {
      this.streamingComponent.setText(content);
    }
  }

  /** Finalize streaming — the message has been added via addMessage, remove streaming component. */
  clearStreaming(): void {
    if (this.streamingComponent) {
      this.removeChild(this.streamingComponent);
      this.streamingComponent = null;
    }
  }

  /** Show a thinking indicator with animated omega spinner. */
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
      // Subscribe to spinner ticks for animation
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

  /** Clear all messages. */
  clearAll(): void {
    this.clear();
    this.entries = [];
    this.streamingComponent = null;
    if (this.unsubSpinner) {
      this.unsubSpinner();
      this.unsubSpinner = null;
    }
    this.thinkingComponent = null;
    this.thinkingText = '';
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
