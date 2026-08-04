import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Assistant replies, rendered as the markdown they actually are.
 *
 * The agent answers in markdown — headings, tables of solved component values,
 * fenced blocks of assertions, bold achieved-vs-target figures. Rendering that
 * into a plain `<p>` put raw `##`, `|---|` and backticks on screen and turned a
 * readable parts table into a wall of pipes.
 *
 * GFM is on for tables, which is the format that matters most here: a parts
 * list or a solved-values table is the densest thing in a reply.
 *
 * Raw HTML is deliberately NOT enabled. This text comes from a model, so
 * `rehype-raw` would let a generated string inject markup into the app. Every
 * element rendered below is one this component chose.
 */
export function ChatMarkdown({ children }) {
  return (
    <div className="chat-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Reply headings sit inside a chat bubble, so they cannot use the
          // page's heading scale — they are flattened to something that reads
          // as emphasis rather than document structure.
          h1: ({ children: text }) => <strong className="chat-md-heading">{text}</strong>,
          h2: ({ children: text }) => <strong className="chat-md-heading">{text}</strong>,
          h3: ({ children: text }) => <strong className="chat-md-heading">{text}</strong>,
          h4: ({ children: text }) => <strong className="chat-md-heading">{text}</strong>,
          // A wide parts table must scroll inside the bubble instead of
          // stretching the panel.
          table: ({ children: rows }) => (
            <div className="chat-md-table-wrap"><table>{rows}</table></div>
          ),
          a: ({ href, children: text }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">{text}</a>
          ),
        }}
      >
        {String(children || '')}
      </Markdown>
    </div>
  );
}
