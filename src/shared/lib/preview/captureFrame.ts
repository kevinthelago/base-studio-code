// captureFrame (#2623 slice 5b) — screenshot the running preview for the reviewer. The web preview is a
// cross-origin iframe (localhost:PORT ≠ the app origin), so its canvas is TAINTED — JS can't read those
// pixels with html2canvas / drawImage(iframe). `getDisplayMedia` reads the actual RENDERED pixels at the
// OS level (untainted), which also means it captures a NATIVE preview window (the user shares that
// window) — one capture path for every PreviewSource kind, and zero dependencies (WebView2 supports it).
//
// The DOM-heavy grab (getDisplayMedia + <video> + canvas) isn't exercised in jsdom; the pure guards
// (availability + track teardown) are unit-tested, and the grab itself is runtime-verified.

/** Whether screen capture is available in this webview (feature-detect before offering the action). */
export function screenCaptureAvailable(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
}

/** Start a display-capture stream — prompts the user once to pick the window/screen to review. Reused
 *  across captures (kept by the caller) so the picker isn't shown on every shot. */
export async function startPreviewCapture(): Promise<MediaStream> {
  if (!screenCaptureAvailable()) {
    throw new Error("Screen capture isn't available here — can't grab a preview shot to review.");
  }
  return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: false });
}

/** Grab the stream's current frame as a `data:image/png;base64,…` URL (drawn through a `<video>` +
 *  `<canvas>`; the frame is untainted since it came from screen capture). */
export async function grabFrame(stream: MediaStream): Promise<string> {
  if (!stream.getVideoTracks()[0]) throw new Error("capture stream has no video track");
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  if (video.readyState < 2) {
    await new Promise<void>((resolve) => { video.onloadeddata = () => resolve(); });
  }
  const w = video.videoWidth, h = video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas context for the capture");
  ctx.drawImage(video, 0, 0, w, h);
  video.pause();
  video.srcObject = null;
  return canvas.toDataURL("image/png");
}

/** Stop every track of a capture stream (ends the OS "sharing" indicator). Safe on null. */
export function stopCapture(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}
