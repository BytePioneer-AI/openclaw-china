import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function resolveFfmpegCommand(): string {
  try {
    const bundled = require("ffmpeg-static") as string | null;
    if (bundled) {
      return bundled;
    }
  } catch {
    // Fall through to PATH lookup for compatibility in local dev environments.
  }

  return "ffmpeg";
}

export async function hasFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(resolveFfmpegCommand(), ["-version"], { stdio: "ignore" });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

export async function transcodeToAmr(params: {
  inputPath: string;
  outputPath: string;
}): Promise<void> {
  // amr_nb requires 8kHz mono in most WeCom clients
  const args = ["-y", "-i", params.inputPath, "-ar", "8000", "-ac", "1", "-c:a", "amr_nb", params.outputPath];
  const ffmpegCommand = resolveFfmpegCommand();

  await new Promise<void>((resolve, reject) => {
    const p = spawn(ffmpegCommand, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr?.on("data", (d) => (err += String(d)));
    p.on('error', (e) => reject(e));
    p.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg transcode failed (code=${code}): ${err.slice(0, 2000)}`));
    });
  });
}
