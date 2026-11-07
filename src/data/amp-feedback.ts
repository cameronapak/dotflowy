import { Schema } from "effect";

/** Public widget identifiers, never credentials. Shared by the Worker gate and
 * the browser loader so neither can turn configuration into an arbitrary URL. */
export const AmpFeedbackConfig = Schema.Struct({
  clientId: Schema.String.check(Schema.isPattern(/^client_[A-Za-z0-9]+$/)),
  userId: Schema.NonEmptyString,
});
