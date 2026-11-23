# Security Policy

## Supported Versions

OpenGPT has no numbered releases yet. Security fixes go into the `main`
branch and the Docker image built from it.

| Version | Supported |
| ------- | --------- |
| `main` branch (latest commit) | :white_check_mark: |
| Docker image `genaiwithms/opengpt:latest` | :white_check_mark: |
| Older commits and `sha-` image tags | :x: (update to the latest) |

The Agent page, its browser and scheduled tasks are a preview and not fully
tested yet; reports about them are welcome and handled the same way.

## Reporting a Vulnerability

Please **don't** report a security problem in a public issue, discussion or
pull request.

Report it privately on GitHub: open the repository's **Security** tab and
choose **Report a vulnerability**
([direct link](https://github.com/GenAIwithMS/OpenGPT/security/advisories/new)).

Include what you can of:

- what the problem is and what an attacker could do with it
- the steps to reproduce it, and the OpenGPT commit or image tag
- your setup, if it matters (Docker or not, `HOST` and `API_TOKEN` settings,
  which features are on)

Never include real API keys, passwords or personal data; use made-up ones.

### What to expect

- **Acknowledgement** within 7 days.
- **An update** at least every 14 days until the report is closed.
- **If it's accepted**: we fix it on `main`, publish a security advisory once
  the fix is out, and credit you in it unless you ask us not to.
- **If it's declined** (for example, it needs access the attacker would
  already have, or it's outside the scope below): we explain why, and you
  are free to discuss it publicly after that.

Please give us a reasonable time to fix a problem before you publish
details.

## Scope

In scope: this repository's code, the backend, frontend, coding agent and
browser engine, and the published Docker image.

Out of scope:

- problems in model providers, connectors (MCP servers) or websites that
  OpenGPT talks to; report those to their owners
- attacks that need someone who already controls the computer or the
  account OpenGPT runs as
- setups that ignore the documented defaults, such as exposing the API to a
  network without `API_TOKEN`

## How OpenGPT protects you

- The backend listens only on `127.0.0.1` by default. To open it to a
  network, set `HOST=0.0.0.0` and a long random `API_TOKEN`; every API call
  then needs the token.
- Stored secrets (provider keys, connector sign-ins) are encrypted in the
  database and never returned by the API.
- The coding agent and the agent ask before they change files, run commands
  or change data in your apps, and show what they will do.
- Logins the agent's browser asks for go only to the browser engine, which
  types them only on that site; they are never stored.

### Known limitations

- The browser engine runs its build commands with the same file access as
  the user who runs OpenGPT; its command sandbox is not available in this
  version. Run OpenGPT as a user (or in the Docker image) that can't read
  files you want to keep private.
- Some websites block automated browsers, and logins are not saved between
  browser tasks.
