import { describe, it, expect } from "vitest";
import { parseImageDataUrl, toMessageContent } from "./imageContent";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANS==";
const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

describe("parseImageDataUrl", () => {
  it("parses a supported base64 image", () => {
    expect(parseImageDataUrl(PNG)).toEqual({ mediaType: "image/png", data: "iVBORw0KGgoAAAANS==" });
  });
  it("normalizes image/jpg to image/jpeg", () => {
    expect(parseImageDataUrl("data:image/jpg;base64,AAAA")).toEqual({ mediaType: "image/jpeg", data: "AAAA" });
  });
  it("rejects non-images and non-data URLs", () => {
    expect(parseImageDataUrl("data:application/pdf;base64,AAAA")).toBeNull();
    expect(parseImageDataUrl("https://example.com/x.png")).toBeNull();
    expect(parseImageDataUrl("")).toBeNull();
  });
});

describe("toMessageContent", () => {
  it("leaves a text-only message as a plain string", () => {
    expect(toMessageContent({ role: "user", content: "hi" })).toBe("hi");
  });

  it("builds text + image blocks when images are attached", () => {
    const out = toMessageContent({ role: "user", content: "what's on here?", images: [PNG, JPG] });
    expect(Array.isArray(out)).toBe(true);
    const blocks = out as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["text", "image", "image"]);
  });

  it("anchors a bare screenshot (no text) with a placeholder text block", () => {
    const out = toMessageContent({ role: "user", content: "", images: [PNG] }) as Array<{ type: string; text?: string }>;
    expect(out[0]).toEqual({ type: "text", text: "(screenshot attached)" });
    expect(out[1].type).toBe("image");
  });

  it("ignores images on assistant messages", () => {
    expect(toMessageContent({ role: "assistant", content: "done", images: [PNG] })).toBe("done");
  });

  it("drops invalid data URLs but keeps valid ones", () => {
    const out = toMessageContent({ role: "user", content: "x", images: ["not-an-image", JPG] }) as Array<{ type: string }>;
    expect(out.map((b) => b.type)).toEqual(["text", "image"]);
  });

  it("caps the number of images per message", () => {
    const many = Array.from({ length: 10 }, () => PNG);
    const out = toMessageContent({ role: "user", content: "x", images: many }) as Array<{ type: string }>;
    // 1 text + at most 6 images
    expect(out.filter((b) => b.type === "image").length).toBe(6);
  });
});
