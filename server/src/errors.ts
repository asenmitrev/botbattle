/**
 * An error the HTTP layer answers with its own status and message (plus any `extra` fields in the JSON body).
 * Anything else that escapes a route is a 500.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
