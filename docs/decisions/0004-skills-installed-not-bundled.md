# 0004. Third-party skills are installed from GitHub at a pinned version, not bundled

Status: accepted (2026-11-16)

## Context

Settings > Skills offers good open-source skills, e.g. Anthropic's skills
under Apache-2.0. Some are large (document skills ship schemas, one ships
fonts: several MB), and bundling them would mean redistributing other
people's work in this repository and keeping copies up to date.

## Decision

- OpenGPT's own skills are bundled in `backend/app/skills/`.
- Third-party skills appear in an Explore catalog and are downloaded from
  their GitHub repository when the user adds one, at a pinned commit (so the
  content is reviewed and can't change underneath users). Their licence file
  is kept with them.
- Only skills whose licence allows it are listed; skills specific to another
  product or without a licence are left out.
- Skills already on the user's computer are shown but off until turned on,
  and the coding agent loads only the skills turned on in OpenGPT.

## Consequences

- The repository stays small and free of third-party content.
- Adding a catalog skill needs network access to GitHub.
- Updating a catalog skill means reviewing it and moving the pinned commit.
