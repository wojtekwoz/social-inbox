/** Errors whose message is safe and useful to show to the caller (agent or human). */
export class UserError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** A platform call failed in a way worth retrying (network, 5xx, rate limit). */
export class TransientError extends Error {}
