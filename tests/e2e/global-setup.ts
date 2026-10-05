import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const MEDIA_DIR = join(import.meta.dirname, '.media');

/** Generates small test media with ffmpeg (VP9/Opus because open-source Chromium has no H.264). */
export default function globalSetup() {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const run = (out: string, args: string[]) => {
    if (!existsSync(join(MEDIA_DIR, out))) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args, join(MEDIA_DIR, out)]);
  };
  run('clip.webm', ['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-t', '4', '-c:v', 'libvpx-vp9', '-b:v', '1M', '-c:a', 'libopus', '-shortest']);
  run('tone.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100', '-t', '8', '-c:a', 'libmp3lame']);
  run('square.png', ['-f', 'lavfi', '-i', 'color=c=orange:size=800x800', '-frames:v', '1']);
}
