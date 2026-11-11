// Blind judge panel. Candidates are shown as anonymous letters in a shuffled order; every judge
// runs twice (order and reversed order) to cancel position bias. Judges that are also contestants
// are excluded, and same-vendor overlap is reported so you know how independent the panel was.
import { getProvider } from "../providers.mjs";
import { redactDiff, redact } from "../redact.mjs";

const SYSTEM = `You are an impartial senior engineer judging several anonymous solutions to the same coding task.
Score each candidate 1-10 on: does it correctly and completely do what was asked, is it minimal (no unrequested changes), is the code clear and safe.
Objective check results are given as evidence: a candidate that fails the checks cannot score above 4. Do not guess which model wrote what.
Reply with ONLY JSON: {"scores":{"A":number,...},"notes":{"A":"one sentence",...}}`;

const vendorOf = (provider, model) => {
  const s = `${provider} ${model || ""}`.toLowerCase();
  if (/claude|anthropic|opus|sonnet|haiku/.test(s)) return "anthropic";
  if (/gemini|google/.test(s)) return "google";
  if (/gpt|openai|\bo[134]\b/.test(s)) return "openai";
  return provider;
};

const LETTERS = "ABCDEFGHIJ";

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Decide who may judge. contestants: [{subject, provider?, model}]. judges: [{provider, model}]
export function pickJudges(judges, contestants) {
  const warnings = [], used = [];
  const cVendors = new Set(contestants.map((c) => vendorOf(c.provider || "", c.model)));
  for (const j of judges) {
    const same = contestants.some((c) => (c.model || "") === (j.model || "") && vendorOf(c.provider || "", c.model) === vendorOf(j.provider, j.model));
    if (same) { warnings.push(`excluded judge ${j.provider}:${j.model ?? "default"} (same model as a contestant)`); continue; }
    if (cVendors.has(vendorOf(j.provider, j.model))) warnings.push(`judge ${j.provider}:${j.model ?? "default"} shares a vendor with a contestant: possible self-preference bias`);
    used.push(j);
  }
  return { used, warnings };
}

export async function judgePanel({ task, candidates, judges, cfg, rng = Math.random, maxDiffChars = 24000, provider = getProvider }) {
  // candidates: [{subject, diff, checks:[{name,pass}], ok}]
  if (!judges.length) return { scores: {}, detail: [], note: "no valid judges" };
  const perDiff = Math.max(2000, Math.floor(maxDiffChars / Math.max(1, candidates.length)));
  const baseOrder = shuffle(candidates.map((_, i) => i), rng);
  const orders = [baseOrder, baseOrder.slice().reverse()];
  const totals = candidates.map(() => []);
  const detail = [];

  await Promise.all(judges.flatMap((j) => orders.map(async (order, oi) => {
    const letterOf = new Map(order.map((ci, pos) => [ci, LETTERS[pos]]));
    const prompt = `## Task\n${redact(task.prompt)}\n\n` + order.map((ci, pos) => {
      const c = candidates[ci];
      const checks = c.checks.length ? c.checks.map((k) => `${k.name}: ${k.pass ? "PASS" : "FAIL"}`).join(", ") : "no checks";
      let d = redactDiff(c.diff || "");
      if (d.length > perDiff) d = d.slice(0, perDiff) + "\n[diff truncated]";
      return `## Candidate ${LETTERS[pos]}\nChecks: ${checks}\n${c.ok ? "" : "(the agent errored or timed out)\n"}\`\`\`diff\n${d || "(no changes)"}\n\`\`\``;
    }).join("\n\n");
    try {
      const r = await provider(j.provider, cfg).complete({ system: SYSTEM, prompt, model: j.model });
      const m = r.text.match(/\{[\s\S]*\}/);
      const out = JSON.parse(m[0]);
      for (const [ci, letter] of letterOf) {
        const s = Number(out.scores?.[letter]);
        if (Number.isFinite(s) && s >= 1 && s <= 10) totals[ci].push(s);
      }
      detail.push({ judge: `${j.provider}:${j.model ?? "default"}`, order: oi, scores: Object.fromEntries([...letterOf].map(([ci, l]) => [candidates[ci].subject, out.scores?.[l] ?? null])), notes: Object.fromEntries([...letterOf].map(([ci, l]) => [candidates[ci].subject, out.notes?.[l] ?? ""])), costUsd: r.costUsd });
    } catch (err) {
      detail.push({ judge: `${j.provider}:${j.model ?? "default"}`, order: oi, error: err.message });
    }
  })));

  const scores = {};
  candidates.forEach((c, i) => { scores[c.subject] = totals[i].length ? +(totals[i].reduce((a, b) => a + b, 0) / totals[i].length).toFixed(2) : null; });
  return { scores, detail };
}
