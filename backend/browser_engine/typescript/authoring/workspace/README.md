# Workspace reference

`AGENTS.md` holds the always-on rules and the workspace map. This README indexes the reference
sections; read one with `read_source` only when its topic comes up.

Author the operation as a Kernel script in `src/tool.mjs`. From `src/`, `explore/` or `test/`,
import Effect Schema from `effect` and the SDK from `../../runtime/index.js`, the path the
executor resolves (`runtime/index.js` in this workspace is the same file, for reading):

```js
import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
```

The skill references import the SDK through the repository's paths, such as
`../../src/runtime/index.js`; in the workspace the same modules are `../../runtime/index.js`,
`../../testing/…` and so on. `../../runtime/index.js` is the SDK's public API for tools. Never
import the `opengpt-browser-engine` package's internal modules, such as `opengpt-browser-engine/core/...`: they are host
internals, not part of that API, and can change in any release.
The operation's browser work is its own `kernel.browsers.playwright.execute` calls, as
.agents/core/SKILL.md describes.

<!-- opengpt:section guide.sections:start

## Standalone references

Read the installed core, search, auth, testing, forms, writes, cart, pagination, records, caller-input and publication skills as relevant. The ordinary browser syntax and example source are the same in both compositions. Files use logical `/workspace` paths; installed runtime and skill directories are read-only. Use bounded live observations and `pureFiles` checks on caller-supplied fixtures.

From `src/`, `explore/` or `test/`, import `Schema` from `effect` and `defineOperation` from `../../runtime/index.js`. All website access uses the generated `kernel.browsers.playwright.execute` call.

opengpt:section guide.sections:end -->
