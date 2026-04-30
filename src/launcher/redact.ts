const SECRET_PATTERNS = [
  /(token=)[^&\s]+/gi,
  /(password=)[^&\s]+/gi,
  /(authorization:\s*bearer\s+)[^\s]+/gi,
  /(OPENCLAW_GATEWAY_TOKEN=)[^\s]+/gi
];

export function redact(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "$1[redacted]"), value);
}
