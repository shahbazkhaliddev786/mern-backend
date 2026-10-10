// Records every request sent to the Messages API. In offline mode it answers with
// the next queued mock instead of calling the network (spec 001, decision log).

export type MockResponder = (body: Record<string, unknown>) => Response;

export interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  status?: number;
}

export interface Capture {
  fetch: typeof fetch;
  requests: CapturedRequest[];
  /** Queue mock responses for the next calls, in order. Used offline, and for C5 in both modes. */
  queue: (...responders: MockResponder[]) => void;
  reset: () => void;
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    out[key] = key === 'x-api-key' || key === 'authorization' ? '[redacted]' : value;
  });
  return out;
}

export function createCapture(offline: boolean): Capture {
  const requests: CapturedRequest[] = [];
  let pending: MockResponder[] = [];

  const capturingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const rawHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const record: CapturedRequest = { url, body, headers: headersToObject(rawHeaders) };
    requests.push(record);

    const responder = pending.shift();
    const response = responder ? responder(body) : offline ? null : await fetch(input, init);
    if (!response) throw new Error(`offline: no mock queued for ${url}`);
    record.status = response.status;
    return response;
  }) as typeof fetch;

  return {
    fetch: capturingFetch,
    requests,
    queue: (...responders) => {
      pending.push(...responders);
    },
    reset: () => {
      requests.length = 0;
      pending = [];
    },
  };
}
