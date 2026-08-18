import type Anthropic from "@anthropic-ai/sdk";

// Turning an owner-attached screenshot into an API image content block. Kept
// separate from run.ts so it's unit-testable without constructing the Anthropic
// client (which run.ts does at module load).

export interface ImageChatMessage {
  role: "user" | "assistant";
  content: string;
  // Base64 data URLs (e.g. "data:image/png;base64,…"), user messages only.
  images?: string[];
}

// Image formats the vision model accepts. "image/jpg" is normalized to jpeg.
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
// Cap images per message so a runaway paste can't blow up the request.
export const MAX_IMAGES_PER_MESSAGE = 6;

/// Parse a base64 image data URL into the parts the API's image block needs, or
/// null if it isn't a supported base64 image.
export function parseImageDataUrl(dataUrl: string): { mediaType: ImageMediaType; data: string } | null {
  const m = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$/i.exec((dataUrl ?? "").trim());
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const mediaType = (raw === "image/jpg" ? "image/jpeg" : raw) as ImageMediaType;
  return IMAGE_MEDIA_TYPES.includes(mediaType) ? { mediaType, data: m[2] } : null;
}

/// Build the API content for a chat message: a plain string, or a multimodal
/// block array when the owner attached images (text first, then each image).
/// Images on assistant messages are ignored; invalid data URLs are dropped.
export function toMessageContent(m: ImageChatMessage): string | Anthropic.Beta.BetaContentBlockParam[] {
  const imgs = m.role === "user" ? (m.images ?? []).slice(0, MAX_IMAGES_PER_MESSAGE) : [];
  if (imgs.length === 0) return m.content;
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (m.content) blocks.push({ type: "text", text: m.content });
  for (const url of imgs) {
    const parsed = parseImageDataUrl(url);
    if (parsed) {
      blocks.push({ type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.data } });
    }
  }
  // A bare screenshot with no words still needs a text block to anchor the turn.
  if (!m.content && blocks.length > 0) blocks.unshift({ type: "text", text: "(screenshot attached)" });
  return blocks.length > 0 ? blocks : m.content;
}
