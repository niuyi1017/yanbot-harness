/** Copy only named variables from an explicit source; never inherit process.env implicitly. */
export function buildAllowedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError('Invalid CLI environment variable name.');
    const value = source[name];
    if (value === undefined) continue;
    if (value.includes('\0')) throw new TypeError('Invalid CLI environment variable value.');
    result[name] = value;
  }
  return result;
}
