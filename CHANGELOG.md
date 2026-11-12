# Changelog

## 0.4.1

Warden no longer gets stuck, and you can keep talking to it while it works.

- **Keep typing while it works.** Press enter and your message is queued; the model gets it at its next step (after the tool it is running), so you can steer without waiting. What you type shows in the status line instead of mixing into the output. If the turn is interrupted first, your message waits on the prompt.
- **Esc interrupts**, like ctrl+c. Interrupting during an approval question no longer waits for enter.
- **Commands that never finish no longer freeze Warden.** A dev server or watcher started by a command (`npx serve`, `npm run dev`, `python -m http.server`) kept the command from ever finishing, even after its timeout and ctrl+c. Warden now stops the whole process tree on timeout or interrupt, and returns when the command itself exits.
- **Background jobs.** The model can start servers with `background=true`, check their output with the new `job` tool, and stop them. `/jobs` lists them; Warden stops them all when it exits.
- **Model requests time out** instead of hanging: no response (180s, retried once), a silent stream (120s), or a connection that only sends keep-alive pings (300s). Change with `requestTimeoutSec`, `idleTimeoutSec`, `stallTimeoutSec` in settings. Nothing is lost; send the message again.
- **Clear status while it works:** thinking, reasoning (for models like Nemotron and DeepSeek R1), writing a file (with size), running a command (with its latest output line), waiting for the model.
- **No more silent endings.** An empty reply, a reply cut off by the output limit, or a tool call cut off mid-way now says what happened. A cut-off file write tells the model to write in parts; `write_file` has `append` for that.
- **Faster follow-ups.** Files the model wrote earlier are no longer re-sent in full with every request (it re-reads them when needed), so long sessions stay quick and stay within free-tier limits.
- **Better edits:** `edit_file` tolerates trailing-space differences, and when text does not match it shows the model the real lines, so follow-up changes succeed instead of rewriting whole files.
- An unexpected error in a command no longer leaves you without a prompt.

## 0.4.0

- First-run setup: with no usable key, Warden explains how to get a free one (Google Gemini) and opens `/add`.
- `warden doctor` checks your setup and says how to fix each problem; `--chat` also tests the model.
- `warden --version`, `warden update`, and a once-a-day update notice (opt out with `WARDEN_NO_UPDATE_CHECK=1`).
- One-line installers for Windows (`install.ps1`) and macOS/Linux (`install.sh`).
- Standalone single-file builds (Node.js included), built for Windows, macOS and Linux on every release.
- Tests run on Windows, macOS and Linux (Node 22 and 24), plus an install test on clean machines.

## 0.3.0

- `/add`: add models from OpenRouter, Hugging Face, NVIDIA, Gemini, Groq, Cerebras, Mistral, DeepSeek, Ollama, LM Studio, OpenAI, Anthropic or any OpenAI-compatible URL. Free models are listed first.
- Text tool-call format for models without native tool calling; chat-only mode as a last resort.
- `/model` picker, `/models <source> [search] [--free]`, `/providers`, `/remove`.
- Quota errors stop immediately with a hint instead of retrying.

## 0.2.0

- Warden becomes a terminal coding agent for any model (read, edit, run, with approvals). The supervisor tools from 0.1 remain as subcommands.

## 0.1.0

- Supervisor: record Claude Code sessions, approval-gated reviewers on any model, arena comparisons, local dashboard.
