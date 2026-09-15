/**
 * Generate the three looping surround videos with ffmpeg filters only.
 * Do not burn captions into frames — this machine's fontconfig crashes ffmpeg.
 *
 * Usage: node scripts/make-surrounds.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "assets", "surrounds");

const W = 270;
const H = 480;
const FPS = 8;
const DURATION = 8;

const JOBS = [
  {
    id: "warm-glow",
    c0: "0x1a1008",
    c1: "0x7a4a20",
    hue: `12*sin(2*PI*t/${DURATION})`,
    sat: "1.12",
  },
  {
    id: "cool-dusk",
    c0: "0x081018",
    c1: "0x1a4060",
    hue: `20*sin(2*PI*t/${DURATION})`,
    sat: "1.08",
  },
  {
    id: "soft-gold",
    c0: "0x12100a",
    c1: "0x5a4a20",
    hue: `8*sin(2*PI*t/${DURATION})`,
    sat: "1.05",
  },
];

function ffmpeg(args) {
  const result = spawnSync("ffmpeg", args, { stdio: "inherit" });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

mkdirSync(outDir, { recursive: true });

for (const job of JOBS) {
  const out = path.join(outDir, `${job.id}.mp4`);
  const vf = [
    `hue=h='${job.hue}':s=${job.sat}`,
    `vignette=PI/4+0.06*sin(2*PI*t/${DURATION})`,
    `format=yuv420p`,
  ].join(",");

  ffmpeg([
    "-y",
    "-fflags",
    "+bitexact",
    "-flags",
    "+bitexact",
    "-f",
    "lavfi",
    "-i",
    `gradients=s=${W}x${H}:d=${DURATION}:r=${FPS}:c0=${job.c0}:c1=${job.c1}:x0=0:y0=0:x1=${W}:y1=${H}:nb_colors=2`,
    "-vf",
    vf,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "32",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-map_metadata",
    "-1",
    out,
  ]);
}

console.log(`wrote ${JOBS.length} surrounds to ${outDir}`);
