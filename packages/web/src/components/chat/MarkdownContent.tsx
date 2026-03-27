'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownContentProps {
  content: string;
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => (
          <p className="mb-1.5 last:mb-0 leading-relaxed">{children}</p>
        ),
        code: ({ children, className }) => {
          const isBlock = className?.startsWith('language-');
          if (isBlock) {
            return (
              <pre className="my-2 overflow-x-auto rounded-lg bg-zinc-900 p-3 text-xs text-zinc-300">
                <code>{children}</code>
              </pre>
            );
          }
          return (
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-blue-400">
              {children}
            </code>
          );
        },
        pre: ({ children }) => <>{children}</>,
        strong: ({ children }) => (
          <strong className="font-semibold text-zinc-100">{children}</strong>
        ),
        em: ({ children }) => <em className="italic text-zinc-300">{children}</em>,
        ul: ({ children }) => (
          <ul className="my-1.5 ml-4 list-disc space-y-1 text-zinc-300">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="my-1.5 ml-4 list-decimal space-y-1 text-zinc-300">{children}</ol>
        ),
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-zinc-600 pl-3 text-zinc-400 italic">
            {children}
          </blockquote>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            className="text-blue-400 underline underline-offset-2 hover:text-blue-300"
            target="_blank"
            rel="noopener noreferrer"
          >
            {children}
          </a>
        ),
        h1: ({ children }) => (
          <h1 className="mt-3 mb-1.5 text-base font-semibold text-zinc-100">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="mt-3 mb-1.5 text-sm font-semibold text-zinc-100">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="mt-2 mb-1 text-sm font-medium text-zinc-200">{children}</h3>
        ),
        hr: () => <hr className="my-3 border-zinc-700" />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
