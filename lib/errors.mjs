/**
 * lib/errors.mjs — Error factories and output
 */

export function infraError(code, message, extra = {}) {
  const err = new Error(message);
  err.infraCode = code;
  Object.assign(err, extra);
  return err;
}

export function argError(message) {
  const err = new Error(message);
  err.isArgError = true;
  return err;
}

/**
 * Write JSON to stdout and exit if exitCode !== 0.
 * exitCode=0 just writes without exiting (process continues).
 * Non-zero exitCode writes and exits.
 */
export function output(obj, exitCode = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  if (exitCode !== 0) process.exit(exitCode);
}
