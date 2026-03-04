'use client';

import type { ChatMessage } from '@/stores/chat';

interface MessageBubbleProps {
  message: ChatMessage;
}

/** Simple inline formatting: backtick code, bold, and newlines */
function formatContent(content: string) {
  const parts: (string | JSX.Element)[] = [];
  // Split into code blocks and inline segments
  const segments = content.split(/(```[\s\S]*?```|`[^`]+`|\*\*[^*]+\*\*)/g);

  segments.forEach((seg, i) => {
    if (seg.startsWith('```') && seg.endsWith('```')) {
      const code = seg.slice(3, -3).replace(/^\w+\n/, '');
      parts.push(
        <pre
          key={i}
          className="my-2 overflow-x-auto rounded-lg bg-zinc-900 p-3 text-xs text-zinc-300"
        >
          <code>{code}</code>
        </pre>,
      );
    } else if (seg.startsWith('`') && seg.endsWith('`')) {
      parts.push(
        <code
          key={i}
          className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-blue-400"
        >
          {seg.slice(1, -1)}
        </code>,
      );
    } else if (seg.startsWith('**') && seg.endsWith('**')) {
      parts.push(
        <strong key={i} className="font-semibold">
          {seg.slice(2, -2)}
        </strong>,
      );
    } else {
      // Convert newlines
      const lines = seg.split('\n');
      lines.forEach((line, li) => {
        if (li > 0) parts.push(<br key={`${i}-br-${li}`} />);
        parts.push(line);
      });
    }
  });

  return parts;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const { role, content, type } = message;

  if (role === 'system') {
    return (
      <div className="my-3 flex justify-center">
        <div className="max-w-md rounded-lg bg-zinc-800/50 px-4 py-2 text-center text-xs text-zinc-400">
          {type === 'command-result' && '⚡ '}
          {formatContent(content)}
        </div>
      </div>
    );
  }

  const isUser = role === 'user';

  return (
    <div className={`my-3 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-zinc-800 text-zinc-100'
        }`}
      >
        {formatContent(content)}
      </div>
    </div>
  );
}
