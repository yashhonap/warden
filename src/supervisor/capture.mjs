// Repo + transcript capture, run when a session stops.
import { execFile } from "node:child_process";
import fs from "node:fs";

const MAX_DIFF = 2_000_000; // bytes, cap so a huge diff can't bloat the DB
const MAX_TRANSCRIPT = 20_000_000;

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer: 50_000_000, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : stdout)
    );
  });
}

export async function captureSnapshot(cwd, transcriptPath) {
  let git_status = null, git_diff = null, transcript_copy = null;
  if (cwd && fs.existsSync(cwd)) {
    git_status = await git(cwd, ["status", "--porcelain"]);
    // tracked changes vs HEAD; fall back to plain diff if the repo has no commits
    git_diff = (await git(cwd, ["diff", "HEAD"])) ?? (await git(cwd, ["diff"]));
    if (git_diff && git_diff.length > MAX_DIFF) git_diff = git_diff.slice(0, MAX_DIFF) + "\n[truncated]";
  }
  try {
    if (transcriptPath && fs.statSync(transcriptPath).size <= MAX_TRANSCRIPT) {
      transcript_copy = fs.readFileSync(transcriptPath, "utf8");
    }
  } catch {}
  return { git_status, git_diff, transcript_copy };
}
