const IDENTIFIER_RE = /^[a-zA-Z0-9._-]{1,63}$/;
const SHELL_BAD = /[\s;`$&|<>"'\\]/;

export function validateIdentifier(value: string): string | null {
  if (!value) return 'Required.';
  if (!IDENTIFIER_RE.test(value)) {
    return 'Use letters, digits, dots, dashes, or underscores (max 63 chars). No spaces or shell metacharacters.';
  }
  return null;
}

export function validateBrokerUrl(value: string): string | null {
  if (!value) return null; // optional when useDefaultBroker
  if (SHELL_BAD.test(value)) return 'Contains a disallowed character (whitespace or shell metacharacter).';
  if (!/^mqtts?:\/\//.test(value)) return 'Must start with mqtt:// or mqtts://';
  return null;
}

export function validateImage(value: string): string | null {
  if (!value) return null; // optional, falls back to default
  if (SHELL_BAD.test(value)) return 'Contains a disallowed character (whitespace or shell metacharacter).';
  return null;
}
