import path from "node:path"
import { OPENGPT_CHANNEL } from "./version"

export function databasePath(data: string) {
  const filename =
    process.env.OPENGPT_DB ??
    (["latest", "dev", "beta", "next", "prod"].includes(OPENGPT_CHANNEL) ||
    process.env.OPENGPT_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENGPT_DISABLE_CHANNEL_DB === "true"
      ? "opengpt.db"
      : `opencode-${OPENGPT_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}
