'use client';

import { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Copy, Check } from 'lucide-react';
import type { ChatMessage } from '@/stores/chat';
import { useOrchestrationStore } from '@/stores/orchestration';
import { InlineDAGCard } from './InlineDAGCard';
import { DAGConfirmationCard } from './DAGConfirmationCard';
import { ToolCallCard } from './ToolCallCard';
import { useGateway } from '@/lib/gateway';

interface MessageBubbleProps {
  message: ChatMessage;
}

// ---------------------------------------------------------------------------
// Copy-to-clipboard button used inside code blocks
// ---------------------------------------------------------------------------
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for non-secure contexts
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-zinc-700 px-2 py-1 text-[10px] text-zinc-400 opacity-0 transition-all duration-150 group-hover:opacity-100 hover:bg-zinc-600 hover:text-zinc-200"
      aria-label={copied ? 'Copied!' : 'Copy code'}
    >
      {copied ? (
        <>
          <Check size={10} className="text-green-400" />
          <span className="text-green-400">Copied</span>
        </>
      ) : (
        <>
          <Copy size={10} />
          <span>Copy</span>
        </>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Markdown renderer — used for assistant messages
// ---------------------------------------------------------------------------
function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        // Fenced code blocks with copy button
        pre({ children, ...props }) {
          // Extract raw text from nested <code> for copy
          const codeEl = (children as React.ReactElement<{ children?: string }>);
          const rawText =
            typeof codeEl?.props?.children === 'string'
              ? codeEl.props.children
              : '';

          return (
            <div className="group relative my-3">
              <pre
                {...props}
                className="overflow-x-auto rounded-lg bg-zinc-950 p-4 text-xs leading-relaxed text-zinc-300 ring-1 ring-zinc-800"
              >
                {children}
              </pre>
              <CopyButton text={rawText} />
            </div>
          );
        },
        // Inline code
        code({ children, className, ...props }) {
          // If it has a language class it's inside a <pre> — let the pre handle it
          const isBlock = className?.startsWith('language-');
          if (isBlock) {
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          }
          return (
            <code
              className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-blue-300"
              {...props}
            >
              {children}
            </code>
          );
        },
        // Paragraphs
        p({ children }) {
          return <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>;
        },
        // Headings
        h1({ children }) {
          return <h1 className="mb-3 mt-4 text-base font-bold text-zinc-100 first:mt-0">{children}</h1>;
        },
        h2({ children }) {
          return <h2 className="mb-2 mt-3 text-sm font-semibold text-zinc-100 first:mt-0">{children}</h2>;
        },
        h3({ children }) {
          return <h3 className="mb-2 mt-3 text-sm font-medium text-zinc-200 first:mt-0">{children}</h3>;
        },
        // Lists
        ul({ children }) {
          return <ul className="mb-2 ml-4 list-disc space-y-1 text-sm text-zinc-200">{children}</ul>;
        },
        ol({ children }) {
          return <ol className="mb-2 ml-4 list-decimal space-y-1 text-sm text-zinc-200">{children}</ol>;
        },
        li({ children }) {
          return <li className="leading-relaxed">{children}</li>;
        },
        // Blockquotes
        blockquote({ children }) {
          return (
            <blockquote className="my-2 border-l-2 border-blue-500 pl-3 text-sm italic text-zinc-400">
              {children}
            </blockquote>
          );
        },
        // Tables (remark-gfm)
        table({ children }) {
          return (
            <div className="my-3 overflow-x-auto rounded-lg ring-1 ring-zinc-700">
              <table className="w-full text-xs">{children}</table>
            </div>
          );
        },
        thead({ children }) {
          return <thead className="bg-zinc-800 text-zinc-300">{children}</thead>;
        },
        tbody({ children }) {
          return <tbody className="divide-y divide-zinc-800 text-zinc-400">{children}</tbody>;
        },
        tr({ children }) {
          return <tr>{children}</tr>;
        },
        th({ children }) {
          return <th className="px-3 py-2 text-left font-medium">{children}</th>;
        },
        td({ children }) {
          return <td className="px-3 py-2">{children}</td>;
        },
        // Horizontal rule
        hr() {
          return <hr className="my-3 border-zinc-700" />;
        },
        // Links
        a({ children, href }) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 underline underline-offset-2 hover:text-blue-300"
            >
              {children}
            </a>
          );
        },
        // Strong / emphasis
        strong({ children }) {
          return <strong className="font-semibold text-zinc-100">{children}</strong>;
        },
        em({ children }) {
          return <em className="italic text-zinc-300">{children}</em>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

// ---------------------------------------------------------------------------
// Main MessageBubble component
// ---------------------------------------------------------------------------
export function MessageBubble({ message }: MessageBubbleProps) {
  const { role, content, type, dagId, toolCall } = message;
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const pendingConfirmation = useOrchestrationStore((s) => s.pendingConfirmation);
  const { respondToConfirmation } = useGateway();

  // --- Tool-call messages ---
  if (type === 'tool-call' && toolCall) {
    return (
      <div className="my-3 flex justify-start">
        <div className="max-w-[85%]">
          <ToolCallCard toolCall={toolCall} />
        </div>
      </div>
    );
  }

  // --- DAG-dispatched: inline progress card ---
  if (type === 'dag-dispatched' && dagId) {
    const dag = inlineDAGs[dagId];
    return (
      <div className="my-3 flex justify-start">
        <div className="max-w-[85%]">
          {dag ? (
            <InlineDAGCard dag={dag} />
          ) : (
            <div className="rounded-2xl bg-zinc-800 px-4 py-3 text-sm text-zinc-100">
              <MarkdownContent content={content} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- DAG-confirmation: approval UI ---
  if (type === 'dag-confirmation' && dagId && pendingConfirmation?.dagId === dagId) {
    return (
      <div className="my-3 flex justify-start">
        <div className="max-w-[85%]">
          <DAGConfirmationCard
            confirmation={pendingConfirmation}
            onRespond={respondToConfirmation}
          />
        </div>
      </div>
    );
  }

  // --- DAG-complete: conversational result ---
  if (type === 'dag-complete') {
    return (
      <div className="my-3 flex justify-start">
        <div className="max-w-[80%] rounded-2xl bg-zinc-800 px-4 py-3 text-sm leading-relaxed text-zinc-100">
          <MarkdownContent content={content} />
        </div>
      </div>
    );
  }

  // --- System / command-result ---
  if (role === 'system') {
    return (
      <div className="my-3 flex justify-center">
        <div className="max-w-md rounded-lg bg-zinc-800/50 px-4 py-2 text-center text-xs text-zinc-400">
          {type === 'command-result' && <span className="mr-1">⚡</span>}
          {content}
        </div>
      </div>
    );
  }

  // --- User message ---
  if (role === 'user') {
    return (
      <div className="my-3 flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-blue-600 px-4 py-3 text-sm leading-relaxed text-white">
          {content}
        </div>
      </div>
    );
  }

  // --- Assistant message (full markdown) ---
  return (
    <div className="my-3 flex justify-start">
      <div className="max-w-[80%] rounded-2xl bg-zinc-800 px-4 py-3 text-sm leading-relaxed text-zinc-100">
        <MarkdownContent content={content} />
      </div>
    </div>
  );
}
