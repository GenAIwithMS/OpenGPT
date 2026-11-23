/** The only place OpenAI model IDs are named in `typescript/src` and `tools`, and tests name
 * the current models only through these constants, both enforced by
 * `typescript/tests/unit/model-ids.test.ts`; changing a model is a one-line edit here. */

/** The big model: minting, maintenance, example generation and challenge solving. */
export const solModel = "gpt-6.1-sol";

/** The small model: Guardian reviews and capability assessment. */
export const lunaModel = "gpt-6-luna";
