export const available = true

export async function resolveBinary() {
  return process.env.OPENGPT_PTY_BIN || "opencode-pty"
}
