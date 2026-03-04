/** Error thrown when a Hindsight API request fails. */
export class HindsightError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public endpoint: string,
  ) {
    super(`Hindsight API error (${statusCode}) at ${endpoint}: ${message}`);
    this.name = 'HindsightError';
  }
}
