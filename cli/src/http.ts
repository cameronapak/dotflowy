import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { fail } from "./core.js";

export const requestJson = Effect.fn("CLI.requestJson")(
  function* (
    url: string,
    options: {
      body?: string;
      headers?: Record<string, string>;
      uncertainWrite?: boolean;
    } = {},
  ) {
    const request = (
      options.body === undefined
        ? HttpClientRequest.get(url)
        : HttpClientRequest.post(url).pipe(
            HttpClientRequest.bodyText(
              options.body,
              options.headers?.["content-type"] ?? "application/json",
            ),
          )
    ).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/json",
        ...options.headers,
      }),
    );
    const result = yield* Effect.gen(function* () {
      const response = yield* HttpClient.execute(request);
      if (response.status < 200 || response.status >= 300) {
        const code = response.status === 401 ? 3 : 1;
        return yield* Effect.fail(
          fail(
            response.status === 401
              ? "Authentication expired or invalid. Run dotflowy login."
              : `Server returned HTTP ${response.status}.${options.uncertainWrite ? " Write outcome may be unknown; inspect the outline before retrying." : ""}`,
            code,
          ),
        );
      }
      return yield* response.json;
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((error) =>
        error._tag === "CliError"
          ? error
          : fail(
              options.uncertainWrite
                ? "Request failed. Write outcome is unknown; inspect the outline before retrying. Nothing was retried."
                : "Request failed or response was invalid. Check your connection and server URL.",
            ),
      ),
    );
    return result;
  },
  (effect) =>
    effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    ),
);
