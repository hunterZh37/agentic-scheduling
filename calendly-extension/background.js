// Service worker: the content script can't call your-deployment.example.com
// cross-origin from calendly.com, but the worker can (host_permissions grant
// it, bypassing CORS). It just proxies the availability check and returns the
// JSON.
// NOTE: replace the domain below with your own deployment before loading
// this extension (see README.md).
const ENDPOINT = "https://your-deployment.example.com/api/availability/check";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "check") return;
  fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg.payload),
  })
    .then((r) => r.json())
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // keep the message channel open for the async response
});
