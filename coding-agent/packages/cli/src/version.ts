import { Option, Schema } from "effect"

declare const OPENGPT_VERSION: string
declare const OPENGPT_CHANNEL: string
declare const OPENGPT_ARTIFACT: string
declare const OPENGPT_RELEASE_HIGHLIGHTS: string

const version = typeof OPENGPT_VERSION === "string" ? OPENGPT_VERSION : "local"
const channel = typeof OPENGPT_CHANNEL === "string" ? OPENGPT_CHANNEL : "local"
const artifact = typeof OPENGPT_ARTIFACT === "string" ? OPENGPT_ARTIFACT : "cli"
// Stable release builds embed the release notes' Highlights; every other build has none.
const highlights =
  typeof OPENGPT_RELEASE_HIGHLIGHTS === "string"
    ? Option.getOrElse(
        Schema.decodeUnknownOption(
          Schema.fromJsonString(Schema.Array(Schema.Struct({ title: Schema.String, body: Schema.String }))),
        )(OPENGPT_RELEASE_HIGHLIGHTS),
        () => [],
      )
    : []

export {
  version as OPENGPT_VERSION,
  channel as OPENGPT_CHANNEL,
  artifact as OPENGPT_ARTIFACT,
  highlights as OPENGPT_HIGHLIGHTS,
}
export const OPENGPT_LOCAL = channel === "local"
