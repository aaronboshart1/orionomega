/**
 * @module components/chat-log
 * Chat log component with capped ring buffer and viewport rendering.
 * Messages are stored in memory — render() returns only visible lines.
 */

import { Container, Markdown, Spacer, Text } from '@mariozechner/pi-tui';
import type { Component } from '@mariozechner/pi-tui';
import type { DisplayMessage } from '../gateway-client.js';
import { markdownTheme, theme } from '../theme.js';

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
      const label = new Text(theme.userLabel() + '  ' + theme.user(msg.content), 1, 0);
      this.addChild(label);
      this.entries.push({ component: label, role: 'user' });
    } else if (msg.role === 'system') {
      const prefix = msg.emoji ? `${msg.emoji} ` : '';
      const text = new Text(theme.system(prefix + msg.content), 1, 0);
      this.addChild(text);
      this.entries.push({ component: text, role: 'system' });
    } else {
      // Assistant — render as markdown
      const label = new Text(theme.assistantLabel(), 1, 0);
      this.addChild(label);
      const md = new Markdown(msg.content, 1, 0, markdownTheme);
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
      const label = new Text(theme.assistantLabel(), 1, 0);
      this.addChild(label);
      this.streamingComponent = new Markdown(content, 1, 0, markdownTheme);
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

  /** Show a thinking indicator. */
  updateThinking(text: string): void {
    if (!text) {
      if (this.thinkingComponent) {
        this.removeChild(this.thinkingComponent);
        this.thinkingComponent = null;
      }
      return;
    }

    const display = theme.dim(`🧠 ${text.length > 100 ? text.slice(0, 100) + '…' : text}`);
    if (!this.thinkingComponent) {
      this.thinkingComponent = new Text(display, 1, 0);
      this.addChild(this.thinkingComponent);
    } else {
      this.thinkingComponent.setText(display);
    }
  }

  /** Clear all messages. */
  clearAll(): void {
    this.clear();
    this.entries = [];
    this.streamingComponent = null;
    this.thinkingComponent = null;
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
