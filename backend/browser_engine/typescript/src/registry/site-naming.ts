import { Schema } from "effect";

/** A website integration's site: its everyday name ("Example Flights") and what the site is, never its tools. */
export const SiteNaming = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(60), Schema.pattern(/\S/)),
  summary: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(160), Schema.pattern(/\S/)),
});
export type SiteNaming = typeof SiteNaming.Type;
