#!/usr/bin/env bun
// Headless API server entry: starts the coding-agent HTTP API without the TUI,
// desktop or web UI. Usage: bun run src/serve-main.ts [--hostname H] [--port P] [--cors ORIGIN]...
import { ensurePluginRuntime } from "@opencode/plugin/runtime"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { Observability } from "@opencode/util/observability"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { Npm } from "@opencode/util/npm"
import { EffectFlock } from "@opencode/util/effect-flock"
import { ServerProcess } from "./server-process"
import { OPENGPT_ARTIFACT, OPENGPT_CHANNEL, OPENGPT_VERSION } from "./version"

const noProxy = [
  ...new Set(
    [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1,localhost,::1"].flatMap((value) =>
      (value ?? "").split(",").flatMap((entry) => entry.trim() || []),
    ),
  ),
].join(",")
process.env.NO_PROXY = noProxy
process.env.no_proxy = noProxy

ensurePluginRuntime()

function flag(name: string) {
  const values: string[] = []
  process.argv.forEach((arg, i) => {
    if (arg === `--${name}` && process.argv[i + 1]) values.push(process.argv[i + 1]!)
    else if (arg.startsWith(`--${name}=`)) values.push(arg.slice(name.length + 3))
  })
  return values
}

const port = flag("port")[0]
const cors = flag("cors")

ServerProcess.run({
  mode: "default",
  hostname: flag("hostname")[0],
  port: port === undefined ? undefined : Number(port),
  cors: cors.length > 0 ? cors : undefined,
}).pipe(
  Effect.provide(
    LayerNode.compile(LayerNode.group([Global.node, AppProcess.node, Npm.node, EffectFlock.node]), {
      replacements: [
        Global.node.replace(
          Global.layerWith(process.env.OPENGPT_CONFIG_DIR ? { config: process.env.OPENGPT_CONFIG_DIR } : {}),
        ),
      ],
    }),
  ),
  Effect.provide(
    Observability.layer({
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
      client: process.env.OPENGPT_CLIENT ?? OPENGPT_ARTIFACT,
      version: OPENGPT_VERSION,
      channel: OPENGPT_CHANNEL,
    }),
  ),
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  NodeRuntime.runMain,
)
