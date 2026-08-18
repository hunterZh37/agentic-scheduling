import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { firstAudioMedia, transcribeAudio } from "./transcribe";

// --- firstAudioMedia (pure) ------------------------------------------------

describe("firstAudioMedia", () => {
  it("returns the first audio part from a Twilio payload", () => {
    const ref = firstAudioMedia({
      NumMedia: "1",
      MediaContentType0: "audio/ogg",
      MediaUrl0: "https://api.twilio.com/media/AB0",
    });
    expect(ref).toEqual({ url: "https://api.twilio.com/media/AB0", contentType: "audio/ogg" });
  });

  it("skips non-audio parts and finds a later audio part", () => {
    const ref = firstAudioMedia({
      NumMedia: "2",
      MediaContentType0: "image/jpeg",
      MediaUrl0: "https://api.twilio.com/media/IMG",
      MediaContentType1: "audio/ogg",
      MediaUrl1: "https://api.twilio.com/media/AUD",
    });
    expect(ref).toEqual({ url: "https://api.twilio.com/media/AUD", contentType: "audio/ogg" });
  });

  it("returns null when there is no audio media", () => {
    expect(firstAudioMedia({ NumMedia: "1", MediaContentType0: "image/png", MediaUrl0: "u" })).toBeNull();
    expect(firstAudioMedia({ NumMedia: "0" })).toBeNull();
    expect(firstAudioMedia({})).toBeNull();
  });
});

// --- transcribeAudio (network, mocked) -------------------------------------

function audioResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/ogg" }),
    text: async () => "",
  };
}

describe("transcribeAudio", () => {
  const OLD = process.env;
  beforeEach(() => {
    process.env = {
      ...OLD,
      OPENAI_API_KEY: "sk_test",
      TWILIO_ACCOUNT_SID: "ACtest",
      TWILIO_AUTH_TOKEN: "tok",
    };
  });
  afterEach(() => {
    process.env = OLD;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("downloads via the CDN redirect (no auth forwarded) and returns the Whisper transcript", async () => {
    const fetchMock = vi
      .fn()
      // 1) Twilio media URL -> 302 to the CDN
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: new Headers({ location: "https://cdn.example/audio.ogg" }),
        blob: async () => new Blob(),
        text: async () => "",
      })
      // 2) CDN fetch -> the audio bytes
      .mockResolvedValueOnce(audioResponse())
      // 3) Whisper transcription -> plain text
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        blob: async () => new Blob(),
        text: async () => "  Move my 3pm to 4pm.  ",
      });
    vi.stubGlobal("fetch", fetchMock);

    const out = await transcribeAudio("https://api.twilio.com/media/AB0", "audio/ogg");
    expect(out).toBe("Move my 3pm to 4pm.");

    // First hop carries Basic auth + manual redirect; the CDN hop must NOT.
    const firstInit = fetchMock.mock.calls[0][1];
    expect(firstInit.redirect).toBe("manual");
    expect(firstInit.headers.Authorization).toMatch(/^Basic /);
    const cdnCall = fetchMock.mock.calls[1];
    expect(cdnCall[0]).toBe("https://cdn.example/audio.ogg");
    expect(cdnCall[1]).toBeUndefined();
    // OpenAI call is authenticated with the bearer key.
    const openaiCall = fetchMock.mock.calls[2];
    expect(openaiCall[0]).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(openaiCall[1].method).toBe("POST");
    expect((openaiCall[1].headers as Record<string, string>).Authorization).toBe("Bearer sk_test");
  });

  it("handles a direct (non-redirect) Twilio media response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(audioResponse()) // Twilio returns bytes directly
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), text: async () => "Book gym 9am" });
    vi.stubGlobal("fetch", fetchMock);

    expect(await transcribeAudio("https://api.twilio.com/media/AB0", "audio/ogg")).toBe("Book gym 9am");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns '' when OpenAI fails (caller surfaces a retry message)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(audioResponse())
      .mockResolvedValueOnce({ ok: false, status: 500, headers: new Headers(), text: async () => "boom" });
    vi.stubGlobal("fetch", fetchMock);

    expect(await transcribeAudio("https://api.twilio.com/media/AB0", "audio/ogg")).toBe("");
  });

  it("returns '' when the media download fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, headers: new Headers(), blob: async () => new Blob() });
    vi.stubGlobal("fetch", fetchMock);

    expect(await transcribeAudio("https://api.twilio.com/media/AB0", "audio/ogg")).toBe("");
  });
});
