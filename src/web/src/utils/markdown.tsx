import React from 'react';

/**
 * Tiny markdown renderer scoped to the shape produced by the knowledge
 * extractor's system prompt: `##` headings, `-` bullets, paragraphs, inline
 * `code` and **bold**. Anything fancier (tables, code fences, links,
 * blockquotes) falls through as plain text — by design, the prompt forbids
 * those constructs and a stray one is preferable to dragging in a real
 * markdown library for ~30 lines of structure.
 */
export function renderKnowledgeMarkdown(src: string): React.ReactNode {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let bulletBuf: string[] = [];
  let paraBuf: string[] = [];

  const flushBullets = () => {
    if (bulletBuf.length === 0) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`} style={ulStyle}>
        {bulletBuf.map((b, i) => (
          <li key={i} style={liStyle}>{renderInline(b)}</li>
        ))}
      </ul>,
    );
    bulletBuf = [];
  };
  const flushPara = () => {
    if (paraBuf.length === 0) return;
    const text = paraBuf.join(' ').trim();
    if (text) {
      blocks.push(
        <p key={`p-${blocks.length}`} style={pStyle}>{renderInline(text)}</p>,
      );
    }
    paraBuf = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.startsWith('## ')) {
      flushBullets();
      flushPara();
      blocks.push(
        <h3 key={`h-${blocks.length}`} style={h3Style}>{line.slice(3).trim()}</h3>,
      );
      continue;
    }
    if (line.startsWith('### ')) {
      flushBullets();
      flushPara();
      blocks.push(
        <h4 key={`h-${blocks.length}`} style={h4Style}>{line.slice(4).trim()}</h4>,
      );
      continue;
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      flushPara();
      bulletBuf.push(line.slice(2));
      continue;
    }
    if (line.trim() === '') {
      flushBullets();
      flushPara();
      continue;
    }
    // Continuation line of a paragraph.
    flushBullets();
    paraBuf.push(line);
  }
  flushBullets();
  flushPara();

  return blocks;
}

/**
 * Inline tokens: `code`, **bold**. Done with a single regex so order doesn't
 * matter and nesting stays predictable. Every yielded segment is a string or
 * a React element; the caller wraps the result in a block-level node.
 */
function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(<code key={`c-${key++}`} style={codeStyle}>{tok.slice(1, -1)}</code>);
    } else {
      out.push(<strong key={`b-${key++}`} style={boldStyle}>{tok.slice(2, -2)}</strong>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const h3Style: React.CSSProperties = {
  margin: '14px 0 6px',
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: '0.02em',
  color: 'var(--text-primary)',
};
const h4Style: React.CSSProperties = {
  margin: '10px 0 4px',
  fontSize: 12,
  fontWeight: 700,
  color: 'var(--text-primary)',
};
const pStyle: React.CSSProperties = {
  margin: '0 0 8px',
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--text-secondary)',
};
const ulStyle: React.CSSProperties = {
  margin: '0 0 8px',
  paddingLeft: 18,
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
};
const liStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--text-secondary)',
};
const codeStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  fontSize: 11.5,
  padding: '1px 5px',
  borderRadius: 4,
  backgroundColor: 'var(--bg-inset)',
  color: 'var(--text-primary)',
};
const boldStyle: React.CSSProperties = {
  fontWeight: 700,
  color: 'var(--text-primary)',
};
