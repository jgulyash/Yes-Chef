import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWhisperTranscriber } from "../src/transcribe.js";

// The real transcriber shells out to ffprobe/ffmpeg/whisper. These tests stand in tiny
// shell scripts for all three — the suite never needs the actual binaries or any audio
// (the project's injectable-seam discipline). Each fake logs its argv so we can assert
// exactly how the binaries are invoked.

let dir: string;

const script = (name: string, body: string): string => {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\necho "$@" >> "${dir}/${name}.log"\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};

const argsOf = (name: string): string => (existsSync(join(dir, `${name}.log`)) ? readFileSync(join(dir, `${name}.log`), "utf8") : "");

// Fakes: ffprobe prints a duration; ffmpeg touches its output (last arg); whisper
// writes fixture JSON to <the value after -of>.json.
const fakeFfprobe = (duration: string) => script("ffprobe", `echo "${duration}"`);
const fakeFfmpeg = () => script("ffmpeg", `for last in "$@"; do :; done; : > "$last"`);
const fakeWhisper = (json: string) =>
  script(
    "whisper",
    `prev=""; out=""; for a in "$@"; do if [ "$prev" = "-of" ]; then out="$a"; fi; prev="$a"; done; cat > "$out.json" <<'EOF'\n${json}\nEOF`
  );

const FIXTURE = JSON.stringify({
  transcription: [{ text: " we're out of eggs" }, { text: " and the milk is getting low " }, { text: "  " }],
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yc-fake-bin-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("makeWhisperTranscriber", () => {
  it("extracts audio, transcribes, and returns trimmed text + segments", async () => {
    const t = makeWhisperTranscriber({
      ffprobe: fakeFfprobe("42.5"),
      ffmpeg: fakeFfmpeg(),
      whisper: fakeWhisper(FIXTURE),
      model: "/models/test.bin",
      maxSeconds: 180,
    });
    const res = await t("/media/clip.mp4");
    expect(res).not.toBeNull();
    expect(res!.text).toBe("we're out of eggs and the milk is getting low");
    expect(res!.segments!.map((s) => s.text)).toEqual(["we're out of eggs", "and the milk is getting low"]);
    // invocation shapes
    expect(argsOf("ffprobe")).toContain("/media/clip.mp4");
    expect(argsOf("ffmpeg")).toMatch(/-ar 16000/);
    expect(argsOf("ffmpeg")).toMatch(/-ac 1/);
    expect(argsOf("whisper")).toMatch(/-m \/models\/test\.bin/);
    expect(argsOf("whisper")).toMatch(/-oj/);
  });

  it("cleans up its temp working directory", async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("yc-stt-")).length;
    const t = makeWhisperTranscriber({ ffprobe: fakeFfprobe("10"), ffmpeg: fakeFfmpeg(), whisper: fakeWhisper(FIXTURE), model: "m", maxSeconds: 180 });
    await t("/media/clip.mp4");
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("yc-stt-")).length;
    expect(after).toBe(before);
  });

  it("rejects clips longer than the cap without invoking whisper", async () => {
    const t = makeWhisperTranscriber({ ffprobe: fakeFfprobe("400.2"), ffmpeg: fakeFfmpeg(), whisper: fakeWhisper(FIXTURE), model: "m", maxSeconds: 180 });
    await expect(t("/media/long.mp4")).rejects.toThrow(/longer than the 180s limit/);
    expect(argsOf("whisper")).toBe("");
    expect(argsOf("ffmpeg")).toBe(""); // fails before extraction too
  });

  it("fails CLOSED when ffprobe can't report a duration (N/A)", async () => {
    const t = makeWhisperTranscriber({ ffprobe: fakeFfprobe("N/A"), ffmpeg: fakeFfmpeg(), whisper: fakeWhisper(FIXTURE), model: "m", maxSeconds: 180 });
    await expect(t("/media/stream.webm")).rejects.toThrow(/couldn't determine/);
    expect(argsOf("whisper")).toBe(""); // never reaches STT
  });

  it("falls back to the default cap when YESCHEF_MAX_CLIP_SECONDS is malformed", async () => {
    const prev = process.env.YESCHEF_MAX_CLIP_SECONDS;
    process.env.YESCHEF_MAX_CLIP_SECONDS = "5min"; // Number('5min') = NaN
    try {
      const t = makeWhisperTranscriber({ ffprobe: fakeFfprobe("400"), ffmpeg: fakeFfmpeg(), whisper: fakeWhisper(FIXTURE), model: "m" });
      await expect(t("/media/long.mp4")).rejects.toThrow(/180s limit/); // default, not NaN
    } finally {
      if (prev === undefined) delete process.env.YESCHEF_MAX_CLIP_SECONDS;
      else process.env.YESCHEF_MAX_CLIP_SECONDS = prev;
    }
  });

  it("propagates whisper failures with stderr context", async () => {
    const bad = script("whisper", `echo "model file not found" >&2; exit 1`);
    const t = makeWhisperTranscriber({ ffprobe: fakeFfprobe("10"), ffmpeg: fakeFfmpeg(), whisper: bad, model: "m", maxSeconds: 180 });
    await expect(t("/media/clip.mp4")).rejects.toThrow(/whisper failed.*model file not found/s);
  });

  it("returns null for a silent clip (empty transcription)", async () => {
    const t = makeWhisperTranscriber({
      ffprobe: fakeFfprobe("10"),
      ffmpeg: fakeFfmpeg(),
      whisper: fakeWhisper(JSON.stringify({ transcription: [] })),
      model: "m",
      maxSeconds: 180,
    });
    expect(await t("/media/silent.mp4")).toBeNull();
  });

  it("drops whisper's non-speech artifacts ([BLANK_AUDIO] etc), not treating them as narration", async () => {
    const t = makeWhisperTranscriber({
      ffprobe: fakeFfprobe("10"),
      ffmpeg: fakeFfmpeg(),
      whisper: fakeWhisper(JSON.stringify({ transcription: [{ text: " [BLANK_AUDIO]" }, { text: "(silence)" }, { text: " ♪ music ♪" }] })),
      model: "m",
      maxSeconds: 180,
    });
    expect(await t("/media/silent.mp4")).toBeNull(); // artifacts only -> no speech
    const t2 = makeWhisperTranscriber({
      ffprobe: fakeFfprobe("10"),
      ffmpeg: fakeFfmpeg(),
      whisper: fakeWhisper(JSON.stringify({ transcription: [{ text: "[BLANK_AUDIO]" }, { text: " out of eggs" }] })),
      model: "m",
      maxSeconds: 180,
    });
    const r = await t2("/media/mixed.mp4");
    expect(r!.text).toBe("out of eggs"); // artifact stripped, speech kept
  });
});
