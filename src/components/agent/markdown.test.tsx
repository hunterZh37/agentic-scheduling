import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderInline } from "./markdown";

// A to-do item written by another agent read "Open in Celeste: https://…" and
// the URL was plain text: only [label](url) markdown became a link (owner,
// 2026-09-24, "I cannot click on the link"). Bare http(s) URLs are links too.
const html = (s: string) => renderToStaticMarkup(<>{renderInline(s, "t")}</>);

describe("renderInline links", () => {
  it("turns a bare URL into a link, keeping the surrounding text", () => {
    const h = html("Open in Celeste: https://hunters-macbook.tailb35216.ts.net/go/thread/test%3Athread now");
    expect(h).toContain('<a href="https://hunters-macbook.tailb35216.ts.net/go/thread/test%3Athread" target="_blank" rel="noopener noreferrer">https://hunters-macbook.tailb35216.ts.net/go/thread/test%3Athread</a>');
    expect(h).toContain("Open in Celeste: ");
    expect(h).toContain(" now");
  });

  it("leaves trailing sentence punctuation outside the link", () => {
    const h = html("See https://example.com/a. Then (https://example.com/b) and https://example.com/c, ok?");
    expect(h).toContain('href="https://example.com/a"');
    expect(h).toContain('href="https://example.com/b"');
    expect(h).toContain('href="https://example.com/c"');
    expect(h).toContain("</a>. Then (");
    expect(h).toContain("</a>) and ");
    expect(h).toContain("</a>, ok?");
  });

  it("still renders markdown links, and does not double-link the URL inside one", () => {
    const h = html("[docs](https://example.com/docs) and https://example.com/raw");
    expect(h.match(/<a /g)?.length).toBe(2);
    expect(h).toContain(">docs</a>");
  });

  it("never links an unsafe scheme, bare or in markdown", () => {
    expect(html("javascript:alert(1) and [x](javascript:alert(1))")).not.toContain("<a ");
  });

  it("stops a bare URL at a markdown marker glued to it", () => {
    const h = html("https://example.com**bold** and https://example.com/x`code`");
    expect(h).toContain('href="https://example.com"');
    expect(h).toContain("<strong>bold</strong>");
    expect(h).toContain('href="https://example.com/x"');
    expect(h).toContain("<code>code</code>");
  });

  it("keeps bold, strike and code working next to a URL", () => {
    const h = html("**Send** https://example.com `now`");
    expect(h).toContain("<strong>Send</strong>");
    expect(h).toContain("<code>now</code>");
    expect(h).toContain('href="https://example.com"');
  });
});
