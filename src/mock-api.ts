import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AttemptSpec } from "./types.js";

interface RequestRecord {
  sequence: number;
  toolResultCount: number;
  served: "preparation" | "control" | "forbidden" | "final";
}

function countToolResults(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countToolResults(item), 0);
  if (typeof value !== "object" || value === null) return 0;
  const record = value as Record<string, unknown>;
  if (record.type === "tool_result") return 1;
  return Object.values(record).reduce<number>((sum, item) => sum + countToolResults(item), 0);
}

function message(
  spec: AttemptSpec,
  stage: RequestRecord["served"],
  model: string,
  toolIndex: number,
): Record<string, unknown> {
  const complete = stage === "final";
  const toolId = stage === "control"
    ? "toolu_permission_matrix_control"
    : stage === "preparation"
      ? `toolu_permission_matrix_preparation_${toolIndex}`
      : "toolu_permission_matrix_forbidden";
  return {
    id: "msg_permission_matrix",
    type: "message",
    role: "assistant",
    model,
    content: complete
      ? [{ type: "text", text: "Attempt complete." }]
      : [{ type: "tool_use", id: toolId, name: spec.toolName, input: spec.toolInput }],
    stop_reason: complete ? "end_turn" : "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function sendSse(response: ServerResponse, body: Record<string, unknown>, complete: boolean): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const content = body.content as Array<Record<string, unknown>>;
  const block = content[0]!;
  const start = { ...body, content: [], stop_reason: null };
  response.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: start })}\n\n`);
  response.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: complete ? { type: "text", text: "" } : { ...block, input: {} } })}\n\n`);
  const delta = complete
    ? { type: "text_delta", text: block.text }
    : { type: "input_json_delta", partial_json: JSON.stringify(block.input) };
  response.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta })}\n\n`);
  response.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
  response.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: body.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } })}\n\n`);
  response.write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
  response.end();
}

export class MockAnthropicServer {
  readonly requests: RequestRecord[] = [];
  private readonly server: Server;

  constructor(control: AttemptSpec, forbidden: AttemptSpec, preparations: AttemptSpec[] = []) {
    this.server = createServer((request, response) => {
      if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          const toolResultCount = countToolResults(payload.messages);
          const script = [...preparations, control, forbidden];
          const complete = toolResultCount >= script.length;
          const toolIndex = Math.min(toolResultCount, script.length - 1);
          const active = script[toolIndex]!;
          const stage = complete
            ? "final"
            : active.id.startsWith("preparation/")
              ? "preparation"
              : active.id.startsWith("control/")
                ? "control"
                : "forbidden";
          this.requests.push({ sequence: this.requests.length + 1, toolResultCount, served: stage });
          const body = message(active, stage, String(payload.model ?? "permission-matrix-stub"), toolIndex);
          if (payload.stream === true) {
            sendSse(response, body, stage === "final");
          } else {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(body));
          }
        } catch {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Invalid mock request" } }));
        }
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }
}
