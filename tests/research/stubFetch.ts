/** A stand-in for fetch: answers each URL from a table, and records the requests. */
export interface StubAnswer {
  status?: number;
  body?: string | Uint8Array<ArrayBuffer>;
  type?: string;
  /** The address the response says it came from (a redirect), default the one asked. */
  finalUrl?: string;
}

export function stubFetch(answers: Record<string, StubAnswer | ((url: string, init: RequestInit) => Promise<Response>)>) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, init });
    const answer = answers[url] ?? answers['*'];
    if (typeof answer === 'function') return answer(url, init);
    if (!answer) throw new TypeError('Failed to fetch');
    const res = new Response(answer.body ?? '', { status: answer.status ?? 200, headers: answer.type ? { 'content-type': answer.type } : {} });
    Object.defineProperty(res, 'url', { value: answer.finalUrl ?? url });
    return res;
  }) as typeof fetch;
  return { impl, requests };
}
