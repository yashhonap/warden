// Reviewer roles, context building, parallel run, merge.
import { redact, redactDiff } from "./redact.mjs";
import { getProvider, resolveSpec, priceFor } from "./providers.mjs";

const OUTPUT_SPEC = `Reply with ONLY a JSON object, no prose, no code fences:
{"verdict":"pass|concerns|fail","summary":"one sentence","findings":[{"severity":"high|medium|low","file":"path or null","line":number or null,"message":"specific, actionable"}]}
Only report issues you can point to in the diff or transcript summary. If the work is fine, return verdict "pass" with an empty findings list. Do not invent problems.`;

export const ROLES = {
  correctness: `You are a code reviewer. Another AI coding agent just finished a task. Judge whether the diff actually does what the user asked, correctly. Look for logic errors, wrong operators, off-by-one, unhandled cases, broken callers, and claims in the agent's final message that the diff does not support.`,
  "test-gap": `You are a test reviewer. Another AI coding agent just finished a task. Judge test coverage of this change: was anything verified? Are there new behaviours with no test? Do any added tests assert nothing meaningful? Did the agent claim tests passed without evidence of running them?`,
  security: `You are a security reviewer. Another AI coding agent just finished a task. Look only for security problems introduced or exposed by this diff: injection, unsafe shell or eval, hardcoded secrets, weakened auth or validation, unsafe deserialization, risky dependencies, over-broad permissions.`,
  "scope-creep": `You are a scope reviewer. Compare what the user asked with what the diff changed. Flag unrequested changes, unrelated refactors, deleted code or files without reason, and config or dependency changes outside the task.`,
};

export function buildContext(session, events, snapshot, cfg) {
  const prompts = events.filter((e) => e.type === "UserPromptSubmit").map((e) => `- ${e.summary}`).join("\n");
  const actions = events.filter((e) => e.type === "PreToolUse").map((e) => `- ${e.tool_name} ${e.summary}`).join("\n");
  const final = events.filter((e) => e.type === "Stop").at(-1)?.summary || "";
  let diff = redactDiff(snapshot?.git_diff || "");
  if (diff.length > cfg.maxDiffChars) diff = diff.slice(0, cfg.maxDiffChars) + "\n[diff truncated]";
  return redact(
    `## What the user asked\n${prompts || "(unknown)"}\n\n## Tool calls the agent made\n${actions || "(none)"}\n\n` +
    `## Agent's final message (may be inaccurate)\n${final}\n\n## git status\n${snapshot?.git_status || "(none)"}\n\n## Diff\n${diff || "(no tracked changes)"}`
  );
}

// Which reviewer runs on which model. Precedence: explicit specs > config.reviewers > roles x default provider.
export function planReviewers(cfg, { roles, withModels } = {}) {
  const base = (r) => ({ role: r, provider: cfg.provider, model: cfg.model });
  let specs;
  if (withModels?.length) {
    // cross-check: every role on every listed "provider:model"
    specs = (roles || cfg.roles).flatMap((role) => withModels.map((pm) => {
      const i = pm.indexOf(":");
      return { role, provider: i < 0 ? pm : pm.slice(0, i), model: i < 0 ? null : pm.slice(i + 1) };
    }));
  } else if (!roles && cfg.reviewers?.length) {
    specs = cfg.reviewers.map((s) => ({ ...base(s.role), ...s }));
  } else {
    specs = (roles || cfg.roles).map(base);
  }
  return specs.map((s) => ({ ...s, label: `${s.role}@${s.provider}${s.model ? "/" + s.model : ""}` }));
}

// Rough pre-approval estimate. null = unknown (no price configured for that model).
export function estimate(context, specs, cfg) {
  const inTok = Math.ceil(context.length / 4) + 400;
  const outTok = Math.min(800, cfg.maxOutputTokens);
  let usd = 0, unknown = [];
  for (const s of specs) {
    let u = null;
    if (s.provider === "claude-cli") u = 0.02; // measured: ~$0.02 per small review with the lean flags
    else if (resolveSpec(cfg, s.provider).free) u = 0;
    else { const p = priceFor(cfg, s.provider, s.model); if (p) u = (inTok * p.in + outTok * p.out) / 1e6; }
    if (u == null) unknown.push(s.label); else usd += u;
  }
  return { inputTokensPerRole: inTok, usd: +usd.toFixed(3), unknown };
}

function parseReport(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("reviewer returned no JSON");
  const j = JSON.parse(m[0]);
  if (!["pass", "concerns", "fail"].includes(j.verdict)) throw new Error("bad verdict");
  j.findings = Array.isArray(j.findings) ? j.findings : [];
  return j;
}

export async function runReviewers({ context, cfg, specs = planReviewers(cfg), onProgress = () => {} }) {
  const results = await Promise.all(specs.map(async (s) => {
    onProgress(s.label, "running");
    try {
      const provider = getProvider(s.provider, cfg);
      const r = await provider.complete({ system: `${ROLES[s.role]}\n\n${OUTPUT_SPEC}`, prompt: context, model: s.model });
      const rep = parseReport(r.text);
      onProgress(s.label, rep.verdict);
      return { role: s.label, ok: true, costUsd: r.costUsd, ...rep };
    } catch (err) {
      onProgress(s.label, "error");
      return { role: s.label, ok: false, costUsd: 0, error: err.message, findings: [] };
    }
  }));
  return mergeReports(results);
}

const SEV = { high: 0, medium: 1, low: 2 };
const RANK = { fail: 2, concerns: 1, pass: 0 };

export function mergeReports(results) {
  const ok = results.filter((r) => r.ok);
  let verdict = ok.length ? ok.reduce((w, r) => (RANK[r.verdict] > RANK[w] ? r.verdict : w), "pass") : "error";
  const byKey = new Map();
  for (const r of ok) for (const f of r.findings) {
    // merge only findings anchored to the same file:line; unanchored ones stay separate
    const key = f.file && f.line ? `${f.file}:${f.line}` : `${r.role}:${byKey.size}`;
    const prev = byKey.get(key);
    if (prev) {
      if (!prev.roles.includes(r.role)) prev.roles.push(r.role);
      // keep the message from the most severe report; don't concatenate duplicates
      if ((SEV[f.severity] ?? 3) < (SEV[prev.severity] ?? 3)) { prev.severity = f.severity; prev.message = f.message; }
    } else byKey.set(key, { ...f, roles: [r.role] });
  }
  const findings = [...byKey.values()].sort((a, b) => (SEV[a.severity] ?? 3) - (SEV[b.severity] ?? 3));
  return {
    verdict, findings,
    roles: results.map((r) => ({ role: r.role, ok: r.ok, verdict: r.verdict, summary: r.summary, error: r.error })),
    cost_usd: results.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    cost_unknown_for: results.filter((r) => r.ok && r.costUsd == null).map((r) => r.role), // no price configured
  };
}
