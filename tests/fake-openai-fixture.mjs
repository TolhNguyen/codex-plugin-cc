import http from "node:http";

/**
 * Minimal, real-HTTP fixture for the OpenAI-compatible chat/completions
 * endpoint. Scripted responses are consumed in order; every request body is
 * captured (parsed JSON) for assertions.
 */

function buildToolCall(call, index) {
  return {
    id: `call-${index + 1}`,
    type: "function",
    function: call
  };
}

/** A single tool-call function entry: `{ name, arguments: "<json string>" }`. */
export function toolCall(name, args = {}) {
  return { name, arguments: JSON.stringify(args) };
}

/** Builds a chat/completions body whose assistant message issues tool calls. */
export function toolCallResponse(calls, { usage } = {}) {
  const body = {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map(buildToolCall)
        }
      }
    ]
  };
  if (usage) {
    body.usage = usage;
  }
  return body;
}

/** Builds a chat/completions body with a plain content-only assistant message. */
export function contentResponse(text, { usage } = {}) {
  const body = {
    choices: [
      {
        message: { role: "assistant", content: text }
      }
    ]
  };
  if (usage) {
    body.usage = usage;
  }
  return body;
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * @param {{ responses: Array<object | ((body: object, index: number) => object | Promise<object>)> }} options
 * @returns {Promise<{ url: string, close: () => Promise<void>, requests: object[] }>}
 */
export function createFakeOpenAIServer({ responses = [] } = {}) {
  const requests = [];
  let nextIndex = 0;

  const server = http.createServer((req, res) => {
    readRequestBody(req)
      .then(async (parsedBody) => {
        requests.push(parsedBody);
        const currentIndex = nextIndex++;
        const entry = responses[currentIndex];

        if (entry === undefined) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "fixture exhausted" }));
          return;
        }

        const outcome = typeof entry === "function" ? await entry(parsedBody, currentIndex) : entry;
        const status = outcome && typeof outcome === "object" && "status" in outcome ? outcome.status : 200;
        const responseBody = outcome && typeof outcome === "object" && "body" in outcome ? outcome.body : outcome;

        res.writeHead(status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(responseBody ?? {}));
      })
      .catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const url = `http://127.0.0.1:${address.port}`;
      resolve({
        url,
        requests,
        close: () => new Promise((res) => server.close(() => res()))
      });
    });
  });
}
