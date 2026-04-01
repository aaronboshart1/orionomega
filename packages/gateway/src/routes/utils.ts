import type { IncomingMessage } from 'node:http';

const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MB

/**
 * Reads the request body as a UTF-8 string, enforcing a byte limit.
 * Rejects with an error if the body exceeds maxBytes.
 */
export function readBody(req: IncomingMessage, maxBytes: number = DEFAULT_MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        req.destroy(new Error(`Request body exceeds limit of ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
