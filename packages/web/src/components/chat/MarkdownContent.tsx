'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import 'highlight.js/styles/github-dark.css';
import type { Components } from 'react-markdown';

// Allow className on code/span only for syntax-highlight classes (language-*, hljs-*).
// Using a regex allowlist prevents arbitrary class injection via LLM-generated markdown.
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code || []),
      ['className', /^(language-\w+|hljs(-\w+)?)$/],
    ],
    span: [
      ...(defaultSchema.attributes?.span || []),
      ['className', /^(hljs(-\w+)?)$/],
    ],
  },
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setCopied(false);
      }, 2000);
    });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="rounded px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function extractCodeProps(children: React.ReactNode): { lang: string | null; text: string } {
  const child = Array.isArray(children) ? children[0] : children;
  if (child && typeof child === 'object' && 'props' in child) {
    const className = child.props.className || '';
    const match = /language-([^\s]+)/.exec(className);
    const text = String(child.props.children ?? '').replace(/\n$/, '');
    return { lang: match ? match[1] : null, text };
  }
  return { lang: null, text: String(children ?? '') };
}

const components: Components = {
  pre({ children }) {
    const { lang, text } = extractCodeProps(children);
    return (
      <div className="my-3 overflow-x-auto rounded-lg bg-zinc-900 text-xs">
        <div className="flex items-center justify-between border-b border-zinc-700/50 px-4 py-1.5">
          {lang ? (
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              {lang}
            </span>
          ) : (
            <span />
          )}
          <CopyButton text={text} />
        </div>
        <pre className="p-4">
          {children}
        </pre>
      </div>
    );
  },
  code({ className, children, ...props }) {
    const match = /language-([^\s]+)/.exec(className || '');
    if (match) {
      return (
        <code className={`${className} block`} {...props}>
          {children}
        </code>
      );
    }

    return (
      <code
        className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-blue-400"
        {...props}
      >
        {children}
      </code>
    );
  },
  a({ href, children, ...props }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-400 underline decoration-blue-400/30 hover:decoration-blue-400"
        {...props}
      >
        {children}
      </a>
    );
  },
  table({ children, ...props }) {
    return (
      <div className="my-3 overflow-x-auto">
        <table className="min-w-full text-sm" {...props}>
          {children}
        </table>
      </div>
    );
  },
  th({ children, ...props }) {
    return (
      <th className="border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-left text-xs font-semibold text-zinc-300" {...props}>
        {children}
      </th>
    );
  },
  td({ children, ...props }) {
    return (
      <td className="border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300" {...props}>
        {children}
      </td>
    );
  },
  blockquote({ children, ...props }) {
    return (
      <blockquote className="my-2 border-l-2 border-zinc-600 pl-3 text-zinc-400 italic" {...props}>
        {children}
      </blockquote>
    );
  },
  ul({ children, ...props }) {
    return (
      <ul className="my-2 ml-4 list-disc space-y-1 text-zinc-200" {...props}>
        {children}
      </ul>
    );
  },
  ol({ children, ...props }) {
    return (
      <ol className="my-2 ml-4 list-decimal space-y-1 text-zinc-200" {...props}>
        {children}
      </ol>
    );
  },
  li({ children, ...props }) {
    return (
      <li className="text-zinc-200" {...props}>
        {children}
      </li>
    );
  },
  h1({ children, ...props }) {
    return <h1 className="mb-2 mt-4 text-lg font-bold text-zinc-100" {...props}>{children}</h1>;
  },
  h2({ children, ...props }) {
    return <h2 className="mb-2 mt-3 text-base font-bold text-zinc-100" {...props}>{children}</h2>;
  },
  h3({ children, ...props }) {
    return <h3 className="mb-1 mt-3 text-sm font-semibold text-zinc-100" {...props}>{children}</h3>;
  },
  h4({ children, ...props }) {
    return <h4 className="mb-1 mt-2 text-sm font-semibold text-zinc-200" {...props}>{children}</h4>;
  },
  p({ children, ...props }) {
    return <p className="my-1.5 leading-relaxed" {...props}>{children}</p>;
  },
  hr() {
    return <hr className="my-4 border-zinc-700" />;
  },
};

interface MarkdownContentProps {
  content: string;
  isStreaming?: boolean;
}

function MarkdownContentInner({ content, isStreaming }: MarkdownContentProps) {
  const [rendered, setRendered] = useState(content);
  const rafRef = useRef<number | null>(null);
  const latestContent = useRef(content);

  latestContent.current = content;

  useEffect(() => {
    if (!isStreaming) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setRendered(content);
      return;
    }

    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setRendered(latestContent.current);
      });
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [content, isStreaming]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight, [rehypeSanitize, sanitizeSchema]]}
      components={components}
    >
      {rendered}
    </ReactMarkdown>
  );
}

export const MarkdownContent = memo(MarkdownContentInner);
