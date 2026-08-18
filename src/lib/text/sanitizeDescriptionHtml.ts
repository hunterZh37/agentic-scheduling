/// Minimal allowlist HTML sanitizer for calendar event descriptions.
///
/// Google Calendar (and some booking tools that populate it, e.g. the
/// "join session" / "reschedule" links some tutoring platforms add) stores
/// `description` as HTML, but we were rendering it as plain text, so guests
/// saw raw `<a href="...">` markup instead of clickable links. This sanitizes
/// to a small allowlist before rendering with dangerouslySetInnerHTML so we
/// get real links without trusting arbitrary HTML from calendar providers.
///
/// Client-only (relies on DOMParser) — descriptions are only ever rendered
/// after a user opens an event's detail modal.

const ALLOWED_TAGS = new Set(["a", "b", "strong", "i", "em", "u", "br", "p", "div", "span", "ul", "ol", "li"]);
const ALLOWED_ATTRS: Partial<Record<string, Set<string>>> = { a: new Set(["href"]) };
const SAFE_HREF = /^(https?:|mailto:)/i;
// Tags whose entire subtree is removed (not just the tag). These never hold
// user-visible content, and calendar providers often paste a full HTML email
// as the description — its <style>/<head> would otherwise leak raw CSS as text.
const DROP_SUBTREE = new Set(["style", "script", "head", "title", "meta", "link", "noscript"]);

function sanitizeNode(node: Node): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return node.cloneNode();
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (DROP_SUBTREE.has(tag)) return null;
  const children = Array.from(el.childNodes).flatMap((child) => {
    const clean = sanitizeNode(child);
    return clean ? [clean] : [];
  });

  if (!ALLOWED_TAGS.has(tag)) {
    // Drop the tag itself but keep its (sanitized) contents, e.g. a stray
    // <style>/<font> wrapper shouldn't swallow the text inside it.
    const frag = document.createDocumentFragment();
    children.forEach((c) => frag.appendChild(c));
    return frag;
  }

  const clean = document.createElement(tag);
  const allowedAttrs = ALLOWED_ATTRS[tag];
  if (allowedAttrs) {
    for (const attr of allowedAttrs) {
      const val = el.getAttribute(attr);
      if (val != null && (attr !== "href" || SAFE_HREF.test(val.trim()))) {
        clean.setAttribute(attr, val);
      }
    }
  }
  if (tag === "a") {
    clean.setAttribute("target", "_blank");
    clean.setAttribute("rel", "noopener noreferrer");
  }
  children.forEach((c) => clean.appendChild(c));
  return clean;
}

export function sanitizeDescriptionHtml(html: string): string {
  if (typeof window === "undefined") return "";
  // A plain-text description (no markup) carries its structure in newlines.
  // Rendered HTML collapses whitespace, so convert those breaks to <br> up
  // front; HTML descriptions are left to their own tags.
  const looksLikeHtml = /<[a-z!/][\s\S]*>/i.test(html);
  const source = looksLikeHtml
    ? html
    : html
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\r\n?|\n/g, "<br>");

  const parsed = new DOMParser().parseFromString(source, "text/html");
  const container = document.createElement("div");
  Array.from(parsed.body.childNodes).forEach((child) => {
    const clean = sanitizeNode(child);
    if (clean) container.appendChild(clean);
  });

  // Collapse the blank-line explosion common in pasted HTML emails: runs of 3+
  // <br> (with any whitespace between) become a single paragraph break.
  return container.innerHTML
    .replace(/(?:\s*<br\s*\/?>\s*){3,}/gi, "<br><br>")
    .trim();
}
