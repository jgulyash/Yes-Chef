import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transcriber } from "./narration.js";

// Real speech-to-text: ffmpeg extracts 16kHz mono audio, whisper.cpp transcribes it.
// This is the ONLY module that knows STT binaries exist. server.ts may import the
// side-effect-free config helpers (resolveModelPath) statically, but the factory is
// imported only by the production main block — never by narration.ts or the tests —
// so the test import graph stays free of ffmpeg/Whisper (the same seam discipline as
// the injected file writer and URL fetcher). Tests exercise this module with fake
// shell scripts standing in for the binaries.

export interface WhisperOptions {
  whisper?: string; // whisper.cpp CLI binary
  model?: string; // ggml model file
  ffmpeg?: string;
  ffprobe?: string;
  maxSeconds?: number; // reject longer clips before burning CPU on them
}

// A stray 20-minute recording must not peg the host CPU that other services may share — cap
// processed length; longer clips fail fast with a message the review UI can show.
const DEFAULT_MAX_SECONDS = 180;

// One source of truth for the model location — server.ts probes this same path to
// decide whether STT is enabled at all.
export function resolveModelPath(): string {
  return process.env.YESCHEF_WHISPER_MODEL ?? "/models/ggml-small.en.bin";
}

function run(
  cmd: string,
  args: string[],
  captureStdout = true
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    // Whisper prints every segment to stdout even with -np, but the transcript is read
    // from the -oj JSON file — don't buffer output nobody reads.
    const child = spawn(cmd, args, { stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", reject); // binary missing / not executable
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

// whisper.cpp -oj output (v1.9.x): { transcription: [{ text, timestamps, offsets }] }.
interface WhisperJson {
  transcription?: { text?: string }[];
}

export function makeWhisperTranscriber(opts: WhisperOptions = {}): Transcriber {
  // Env is read per-factory-call (not at module load) so tests and the local-dev
  // runbook can point at different binaries without import-order surprises.
  const whisper = opts.whisper ?? process.env.YESCHEF_WHISPER ?? "whisper-cli";
  const model = opts.model ?? resolveModelPath();
  const ffmpeg = opts.ffmpeg ?? process.env.YESCHEF_FFMPEG ?? "ffmpeg";
  const ffprobe = opts.ffprobe ?? process.env.YESCHEF_FFPROBE ?? "ffprobe";
  // A malformed env value must fall back to the default, never become NaN — NaN
  // comparisons are always false, which would silently disable the cap.
  const envMax = Number(process.env.YESCHEF_MAX_CLIP_SECONDS);
  const maxSeconds = opts.maxSeconds ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_SECONDS);

  return async (absPath: string) => {
    const probe = await run(ffprobe, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      absPath,
    ]);
    if (probe.code !== 0) {
      throw new Error(`ffprobe failed on ${absPath}: ${probe.stderr.trim().slice(-300)}`);
    }
    // Fail CLOSED: an unknowable duration (ffprobe prints 'N/A' for streamed or
    // unfinalized containers) must not slip past the CPU cap.
    const duration = Number.parseFloat(probe.stdout.trim());
    if (!Number.isFinite(duration)) {
      throw new Error("couldn't determine the clip's duration — the file may be unfinalized or corrupt. Re-record, or paste what you said.");
    }
    if (duration > maxSeconds) {
      throw new Error(
        `clip is ${Math.round(duration)}s — longer than the ${maxSeconds}s limit. Record a shorter pass (or raise YESCHEF_MAX_CLIP_SECONDS).`
      );
    }

    const workDir = await mkdtemp(join(tmpdir(), "yc-stt-"));
    try {
      const wav = join(workDir, "audio.wav");
      const extract = await run(ffmpeg, ["-y", "-v", "error", "-nostats", "-i", absPath, "-vn", "-ar", "16000", "-ac", "1", wav]);
      if (extract.code !== 0) {
        throw new Error(`ffmpeg audio extraction failed: ${extract.stderr.trim().slice(-300)}`);
      }

      // nice -n 15: transcription is the lowest-priority tenant on the host CPU.
      const outBase = join(workDir, "out");
      const stt = await run("nice", ["-n", "15", whisper, "-m", model, "-f", wav, "-oj", "-of", outBase, "-np"], false);
      if (stt.code !== 0) {
        throw new Error(`whisper failed: ${stt.stderr.trim().slice(-300)}`);
      }

      const parsed = JSON.parse(await readFile(`${outBase}.json`, "utf8")) as WhisperJson;
      // whisper.cpp annotates non-speech as bracketed tokens — "[BLANK_AUDIO]",
      // "[MUSIC]", "(silence)" — which are not narration. Dropping them lets a truly
      // silent clip fall through to the "no speech was recognized" path instead of
      // producing a phantom transcript (found by probing with a silent clip).
      const isArtifact = (t: string) => /^[[(].*[\])]$/.test(t) || /^♪.*♪$/.test(t);
      const segments = (parsed.transcription ?? [])
        .map((s) => ({ text: (s.text ?? "").trim() }))
        .filter((s) => s.text.length > 0 && !isArtifact(s.text));
      const text = segments.map((s) => s.text).join(" ").trim();
      if (!text) return null; // silent clip — processCapture turns this into a clear error
      return { text, segments };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };
}
