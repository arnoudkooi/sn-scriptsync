/** Quote one argument for npm's browser command, which npm passes to a shell. */
export function quoteShellArg(value, platform = process.platform) {
  if (value.includes('\0')) throw new Error('Shell arguments cannot contain NUL');
  if (platform === 'win32') {
    // cmd.exe expands environment variables even inside quotes. Refuse these
    // characters instead of relying on cmd's context-dependent escaping.
    if (/["%!\r\n]/.test(value)) throw new Error('Cannot safely quote this argument for cmd.exe');
    // The Windows argv parser requires trailing backslashes to be doubled
    // before the closing quote. Other backslashes are literal.
    return `"${value.replace(/\\+$/, '$&$&')}"`;
  }
  // Within POSIX double quotes, all four of these characters need escaping.
  return `"${value.replace(/[\\"$`]/g, '\\$&')}"`;
}
