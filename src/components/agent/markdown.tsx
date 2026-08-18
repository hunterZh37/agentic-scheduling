import type { ReactNode } from "react";

// Only these URL schemes are allowed to become clickable anchors — this keeps
// javascript:/data: and other XSS vectors out of rendered follow-ups and agent
// replies. Returns the trimmed href, or null if the scheme isn't safe.
function safeHref(url: string): string | null {
  const u = url.trim();
  return /^(https?:|mailto:|tel:)/i.test(u) ? u : null;
}

// Minimal, XSS-safe markdown → React nodes (links, bold, strikethrough, inline
// code, bulleted/numbered lists) so agent replies and follow-ups render with
// visual hierarchy instead of showing raw markers. Builds React elements
// directly — no dangerouslySetInnerHTML. Shared by the private AgentPane, the
// public booking chat, and the event follow-up rows.
export function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Link first so [label](url) is consumed as a whole; then bold/strike/code.
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|~~(.+?)~~|`(.+?)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}-${i++}`;
    if (m[1] != null) {
      const href = safeHref(m[2]);
      if (href) {
        out.push(
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {m[1]}
          </a>
        );
      } else {
        // Unsafe/relative scheme: keep the raw text rather than a dead link.
        out.push(m[0]);
      }
    } else if (m[3] != null) out.push(<strong key={key}>{m[3]}</strong>);
    else if (m[4] != null) out.push(<del key={key}>{m[4]}</del>);
    else out.push(<code key={key}>{m[5]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(text: string): ReactNode {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = (k: string) => {
    if (!bullets.length) return;
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul key={`ul-${k}`}>
        {items.map((b, j) => (
          <li key={j}>{renderInline(b, `li-${k}-${j}`)}</li>
        ))}
      </ul>
    );
  };
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push(bullet[1]);
      return;
    }
    flush(String(idx));
    if (line.trim() !== "") {
      blocks.push(<p key={`p-${idx}`}>{renderInline(line, `p-${idx}`)}</p>);
    }
  });
  flush("end");
  return <>{blocks}</>;
}
