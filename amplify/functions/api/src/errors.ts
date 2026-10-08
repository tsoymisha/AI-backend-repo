/**
 * Error thrown by the business logic. When the Lambda throws it, AppSync
 * returns it to the app with `errorType` = `reason` (e.g. "token-invalid",
 * "kiosk-busy"), which the Flutter app maps to a Korean message the
 * screen reader can read out. `message` is an English fallback.
 */
export class AppError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
    // The Lambda runtime reports error.name as AppSync's errorType.
    this.name = reason;
  }
}
