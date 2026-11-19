# OpenGPT documentation

For developers working on OpenGPT. Start with the architecture, then read
the page for the part you are changing. To install and run OpenGPT, see the
[README](../README.md); for workflow and commit style, see
[CONTRIBUTING.md](../CONTRIBUTING.md). AI coding agents also read the
`AGENTS.md` files ([root](../AGENTS.md)).

## Overview

- [Architecture](architecture.md): the pieces and how a request flows through them
- [Configuration](configuration.md): every setting in `backend/.env`

## Services

| Page | Covers |
|---|---|
| [Chat](services/chat.md) | The LangGraph chat graph, tools, streaming, threads, temporary chats |
| [Documents and knowledge](services/documents-and-knowledge.md) | Files attached to a chat, and the knowledge base every chat can search |
| [Deep research](services/deep-research.md) | Multi-step research reports |
| [Blogs](services/blogs.md) | The blog writer |
| [Coding agent](services/coding-agent.md) | The Code page: projects, sessions, approvals, the agent process |
| [Connectors](services/connectors.md) | MCP servers: catalog, sign-in (OAuth), chat tools and approvals |
| [Skills](services/skills.md) | SKILL.md instructions for chat and the coding agent |
| [Providers](services/providers.md) | Model providers and the model used for each job |
| [Settings](services/settings.md) | The settings popup's storage: profile, general, personalization |

## Guides

- [Run with Docker](guides/run-with-docker.md)
- [Use a local model](guides/use-a-local-model.md)
- [Add a chat tool](guides/add-a-chat-tool.md)
- [Add a settings page](guides/add-a-settings-page.md)
- [Add a connector to the catalog](guides/add-a-catalog-connector.md)
- [Add a provider preset](guides/add-a-provider-preset.md)
- [Change the database](guides/database-changes.md)

## Decisions

Short records of why things are the way they are: [decisions/](decisions/README.md).

## Next to the code

Folders with more going on have their own README describing how that part
works inside: [backend](../backend/README.md) (with READMEs for routers,
services, the coding agent integration, tools, deep research, blogs, the
database and tests) and [frontend](../frontend/README.md).

## Keeping these docs current

Update the page for a service in the same change as its code. Pages explain
how things fit together and link to the code; the details live in each
module's docstring, so keep those current too.
