'use client';

import { useState } from 'react';
import type { ChatMessage } from '@/stores/chat';
import { useOrchestrationStore } from '@/stores/orchestration';
import { InlineDAGCard } from './InlineDAGCard';
import { RunSummaryCard } from './RunSummaryCard';
import { DAGConfirmationCard } from './DAGConfirmationCard';
import { useGateway } from '@/lib/gateway';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism';
import { Copy, Check } from 'lucide-react';

interface MessageBubbleProps {
  message: ChatMessage;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      onClick={handleCopy}
      className="absolute right-2 top-2 rounded-md bg-zinc-700/80 p-1.5 text-zinc-400 opacity-0 transition-all hover:bg-zinc-600 hover:text-zinc-200 group-hover:opacity-100"
      title="Copy code"
    >
      {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
    </button>
  );
}

const markdownComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mb-2 mt-4 text-lg font-bold text-zinc-100">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-3 text-base font-bold text-zinc-100">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-2 text-sm font-bold text-zinc-100">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-2 text-sm font-semibold text-zinc-200">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="mb-1 mt-1 text-xs font-semibold text-zinc-200">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="mb-1 mt-1 text-xs font-semibold text-zinc-300">{children}</h6>
  ),
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="mb-2 ml-4 list-disc space-y-0.5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 ml-4 list-decimal space-y-0.5">{children}</ol>
  ),
  li: ({ children }) => <li className="text-sm">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-400 underline decoration-blue-400/30 hover:text-blue-300 hover:decoration-blue-300/50"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-3 border-zinc-700" />,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-blue-500/50 pl-3 italic text-zinc-400">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-zinc-700">
      <table className="w-full text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-zinc-700 bg-zinc-800/50 text-zinc-300">{children}</thead>
  ),
  tbody: ({ children }) => <tbody className="divide-y divide-zinc-800">{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => (
    <th className="px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider">{children}</th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-1.5 text-zinc-400">{children}</td>
  ),
  code: ({ className, children }) => {
    const match = /language-(\w+)/.exec(className || '');
    const raw = String(children).replace(/\n$/, '');
    const isBlock = match || raw.includes('\n');

    if (isBlock) {
      const language = match?.[1] || 'text';
      return (
        <div className="group relative my-2">
          <div className="flex items-center justify-between rounded-t-lg bg-zinc-800 px-3 py-1">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">{language}</span>
          </div>
          <CopyButton text={raw} />
          <SyntaxHighlighter
            style={oneDark}
            language={language}
            PreTag="div"
            customStyle={{
              margin: 0,
              borderTopLeftRadius: 0,
              borderTopRightRadius: 0,
              borderBottomLeftRadius: '0.5rem',
              borderBottomRightRadius: '0.5rem',
              fontSize: '12px',
              padding: '12px',
            }}
          >
            {raw}
          </SyntaxHighlighter>
        </div>
      );
    }
    return (
      <code className="rounded bg-zinc-700/50 px-1.5 py-0.5 text-xs text-blue-300">
        {children}
      </code>
    );
  },
  pre: ({ children }) => <>{children}</>,
  strong: ({ children }) => (
    <strong className="font-semibold text-zinc-100">{children}</strong>
  ),
  em: ({ children }) => (
    <em className="italic text-zinc-300">{children}</em>
  ),
};

function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const { role, content, type, dagId } = message;
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const pendingConfirmation = useOrchestrationStore((s) => s.pendingConfirmation);
  const { respondToConfirmation } = useGateway();

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

  if (type === 'dag-complete' && dagId) {
    const dag = inlineDAGs[dagId];
    return (
      <div className="my-3 flex justify-start">
        <div className="max-w-[85%]">
          {dag ? (
            <RunSummaryCard dag={dag} />
          ) : (
            <div className="rounded-2xl bg-zinc-800 px-4 py-3 text-sm leading-relaxed text-zinc-100">
              <MarkdownContent content={content} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (role === 'system') {
    return (
      <div className="my-3 flex justify-center">
        <div className="max-w-md rounded-lg bg-zinc-800/50 px-4 py-2 text-center text-xs text-zinc-400">
          {type === 'command-result' && '\u26A1 '}
          {content}
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
        {isUser ? content : <MarkdownContent content={content} />}
      </div>
    </div>
  );
}
