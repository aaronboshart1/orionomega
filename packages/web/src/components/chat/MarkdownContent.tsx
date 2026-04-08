'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import 'highlight.js/styles/github-dark.css';
import type { Components } from 'react-markdown';
import { useFileViewerStore } from '@/stores/file-viewer';
import { useOrchestrationStore } from '@/stores/orchestration';

// Allow className on code/span only for syntax-highlight classes (language-*, hljs-*).
// Also allow the fileviewer: protocol so clickable file paths survive sanitization.
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
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    href: [...(defaultSchema.protocols?.href ?? []), 'fileviewer'],
  },
};

// Match absolute (/path/to/file.ext) and relative (./path or ../path) file paths.
// Requires an extension so bare directories and URLs aren't falsely detected.
const FILE_PATH_RE = /((?:\/|\.\.?\/)[\w/.\-]+\.[a-zA-Z0-9]{1,10})/g;

/** Open a file path in the file viewer + orchestration pane */
function openInFileViewer(filePath: string) {
  useFileViewerStore.getState().openFile(filePath);
  useOrchestrationStore.getState().setActiveOrchTab('files');
  useOrchestrationStore.getState().setOrchPaneOpen(true);
}

// Remark plugin: finds file-path-like text in non-code, non-link nodes and converts
// them to remark link nodes with a fileviewer: URL scheme so the a{} component can
// render them as clickable file-opener buttons.
// Also converts inlineCode nodes that are entirely a file path into clickable links.
function remarkClickableFilePaths() {
  return (tree: any) => {
    function visitChildren(node: any) {
      if (!node.children) return;

      // Reverse iteration so splice indices stay valid after replacement
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];

        // Handle inlineCode nodes: if the entire content is a file path, convert to a link
        if (child.type === 'inlineCode') {
          const val = (child.value || '').trim();
          if (FILE_PATH_RE.test(val)) {
            // Reset lastIndex since we used .test()
            FILE_PATH_RE.lastIndex = 0;
            node.children[i] = {
              type: 'link',
              url: `fileviewer:${val}`,
              title: null,
              children: [{ type: 'inlineCode', value: val }],
            };
          }
          FILE_PATH_RE.lastIndex = 0;
          continue;
        }

        if (child.type !== 'text') {
          // Don't recurse into code blocks or existing links
          if (child.type !== 'code' && child.type !== 'link') {
            visitChildren(child);
          }
          continue;
        }

        const { value } = child;
        const matches = [...value.matchAll(FILE_PATH_RE)];
        if (matches.length === 0) continue;

        const newNodes: any[] = [];
        let lastIndex = 0;

        for (const match of matches) {
          const start = match.index!;
          const filePath = match[1];
          const end = start + filePath.length;

          if (start > lastIndex) {
            newNodes.push({ type: 'text', value: value.slice(lastIndex, start) });
          }

          newNodes.push({
            type: 'link',
            url: `fileviewer:${filePath}`,
            title: null,
            children: [{ type: 'text', value: filePath }],
          });

          lastIndex = end;
        }

        if (lastIndex < value.length) {
          newNodes.push({ type: 'text', value: value.slice(lastIndex) });
        }

        node.children.splice(i, 1, ...newNodes);
      }
    }

    visitChildren(tree);
  };
}

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

/**
 * Renders text that may contain file paths as a mix of plain text and clickable
 * file-path buttons. Used inside code blocks where the remark plugin can't operate.
 */
function CodeBlockWithClickablePaths({ text }: { text: string }) {
  FILE_PATH_RE.lastIndex = 0;
  const matches = [...text.matchAll(FILE_PATH_RE)];
  if (matches.length === 0) {
    return <>{text}</>;
  }

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of matches) {
    const start = match.index!;
    const filePath = match[1];
    const end = start + filePath.length;

    if (start > lastIndex) {
      parts.push(<span key={`t-${lastIndex}`}>{text.slice(lastIndex, start)}</span>);
    }

    parts.push(
      <button
        key={`f-${start}`}
        type="button"
        onClick={() => openInFileViewer(filePath)}
        className="font-mono text-blue-400/80 hover:text-blue-300 hover:underline cursor-pointer"
      >
        {filePath}
      </button>,
    );

    lastIndex = end;
  }

  if (lastIndex < text.length) {
    parts.push(<span key={`t-${lastIndex}`}>{text.slice(lastIndex)}</span>);
  }

  return <>{parts}</>;
}

const components: Components = {
  pre({ children }) {
    const { lang, text } = extractCodeProps(children);
    const hasFilePaths = FILE_PATH_RE.test(text);
    FILE_PATH_RE.lastIndex = 0;

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
        {hasFilePaths ? (
          <pre className="p-4">
            <code className="block">
              <CodeBlockWithClickablePaths text={text} />
            </code>
          </pre>
        ) : (
          <pre className="p-4">
            {children}
          </pre>
        )}
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
    if (href?.startsWith('fileviewer:')) {
      const filePath = href.slice('fileviewer:'.length);
      return (
        <button
          type="button"
          onClick={() => openInFileViewer(filePath)}
          className="font-mono text-blue-400/80 hover:text-blue-300 hover:underline cursor-pointer"
        >
          {children}
        </button>
      );
    }
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
      remarkPlugins={[remarkGfm, remarkClickableFilePaths]}
      rehypePlugins={[rehypeHighlight, [rehypeSanitize, sanitizeSchema]]}
      components={components}
    >
      {rendered}
    </ReactMarkdown>
  );
}

export const MarkdownContent = memo(MarkdownContentInner);
