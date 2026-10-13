// Redaction for anything that leaves for the model (P2 AI, OpenRouter): tool output, logs, incident text.
// Pattern-based, so it is a net, not a guarantee; the tool server also never reads Secrets, ConfigMap data or env.
// Order matters: whole blocks first, then key=value pairs, then bare tokens.
const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED private key]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@'], // user:pass@ in any URL (http, postgres, redis, …)
  [/\b(authorization|bearer)(["']?\s*[:=]?\s*)(bearer\s+)?[A-Za-z0-9._~+/=-]{12,}/gi, '$1$2$3[REDACTED]'],
  [/\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|mnemonic|seed)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)[^\s"',;}]{4,}/gi, '$1$2[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED jwt]'],
  [/\b(sk-or-v1-|sk-ant-|sk-|ghp_|gho_|ghs_|github_pat_|xox[abposr]-|glpat-|AKIA|ASIA)[A-Za-z0-9_-]{10,}/g, '[REDACTED token]'],
  [/\b0x[0-9a-fA-F]{64}\b/g, '[REDACTED 32-byte hex]'], // Ethereum private keys (tx/block hashes are lost too; acceptable)
  [/\b[0-9a-fA-F]{64}\b/g, '[REDACTED 32-byte hex]'],
];

export function redact(text: string): string {
  return RULES.reduce((s, [re, to]) => s.replace(re, to), text);
}

// Redact and cap: keeps the head of long output and says how much was cut.
export function redactCapped(text: string, max = 12_000): string {
  const r = redact(text);
  return r.length <= max ? r : `${r.slice(0, max)}\n… [${r.length - max} more characters cut]`;
}
