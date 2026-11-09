/** Reference word splitter: the whitespace-separated words of a value. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const parts = text.split(/\s+/);
  for (let i = 0; i < parts.length; i++) if (parts[i]) out.push(parts[i]);
  return out;
}
