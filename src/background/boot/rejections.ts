/**
 * Promise rejections that the service worker knows are noise.
 *
 * The Google SDK (@google/generative-ai) reads a streamed reply through a stream that it splits in two. When that
 * read is cut, by Pause or Stop or by a dropped connection, one of the two branches rejects a promise that nothing
 * awaits. The call itself still rejects, with the right error, and it is logged as usual, so this is the same
 * failure reported a second time, and in the worker it would land on the extension's error page as a crash.
 * Gemini always streams (docs/langgraph-design.md, "Providers"), so it happens on every Pause during a Gemini call.
 * The same split leaves a second rejection, "Failed to parse stream", when Gemini answers 200 with a body that is not
 * an event stream (a proxy's HTML page, a JSON object): the call fails with the same text and the log has it.
 *
 * The match is exact: the SDK's own error texts and nothing that only looks like them. Any other rejection still goes
 * to the log as an error.
 */
const GEMINI_STREAM_CUT = /^\[GoogleGenerativeAI Error\]: (?:Error reading from the stream|Request aborted when reading from the stream|Failed to parse stream)$/;

export function isGeminiStreamCut(reason: unknown): boolean {
  return reason instanceof Error && GEMINI_STREAM_CUT.test(reason.message);
}
