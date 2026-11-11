// Strip likely secrets before any text goes to a reviewer model.
// Conservative: over-redacting is fine, leaking is not.
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_KEY]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "[REDACTED_GH_TOKEN]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[REDACTED_GOOGLE_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[REDACTED]"],
  // NAME=value / NAME: "value" where the name looks secret-ish
  [/((?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|access[_-]?key|auth)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)([^\s"'`,;]{6,})/gi, "$1[REDACTED]"],
  // credentials inside URLs
  [/(\w+:\/\/[^\s:@/]+:)[^\s@/]+(@)/g, "$1[REDACTED]$2"],
];

export function redact(text) {
  if (!text) return text;
  let out = String(text);
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

// Files that should never be shown to reviewers at all (diff hunks are dropped).
const SENSITIVE_FILE = /(^|\/)(\.env[^/]*|.*\.pem|.*\.key|id_rsa[^/]*|credentials[^/]*|.*secrets?[^/]*\.(json|ya?ml))$/i;

export function redactDiff(diff) {
  if (!diff) return diff;
  return diff
    .split(/^(?=diff --git )/m)
    .map((chunk) => {
      const m = chunk.match(/^diff --git a\/(\S+) b\//);
      return m && SENSITIVE_FILE.test(m[1]) ? `diff --git a/${m[1]} (contents withheld: sensitive file)\n` : redact(chunk);
    })
    .join("");
}
