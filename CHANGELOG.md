# Changelog

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
