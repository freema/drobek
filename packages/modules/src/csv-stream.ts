/**
 * The streamed body of a CSV export (NSO-323 M5): CSV lines in, CRLF-terminated
 * text chunks of about `chunkChars` out — so an export (the data module's
 * `export.csv` on the app host, the dashboard's Data tab) holds one chunk in
 * memory, never the whole file. `Readable.from(csvChunks(lines))` is a module
 * route's streamed response body.
 */

/** The default chunk: 64 Ki characters. */
const CSV_CHUNK_CHARS = 64 * 1024;

export async function* csvChunks(lines: AsyncIterable<string>, chunkChars: number = CSV_CHUNK_CHARS): AsyncGenerator<string> {
  let chunk = '';
  for await (const line of lines) {
    chunk += `${line}\r\n`;
    if (chunk.length >= chunkChars) {
      yield chunk;
      chunk = '';
    }
  }
  if (chunk) yield chunk;
}
