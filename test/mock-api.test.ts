import assert from "node:assert/strict";
import test from "node:test";
import { MockAnthropicServer } from "../src/mock-api.js";
import type { AttemptSpec } from "../src/types.js";

const spec: AttemptSpec = {
  id: "read-secret/native-file",
  invariant: "read-secret",
  path: "native-file",
  toolName: "Read",
  toolInput: { file_path: "/tmp/fake" },
};
const control = { ...spec, id: "control/read", toolInput: { file_path: "/tmp/public" } };

async function post(baseUrl: string, toolResults: unknown[]): Promise<Response> {
  return fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "stub",
      messages: [{ role: "user", content: toolResults }],
      stream: false,
    }),
  });
}

test("mock API sequences control, forbidden call, and completion", async (t) => {
  const mock = new MockAnthropicServer(control, spec);
  const baseUrl = await mock.start();
  t.after(() => mock.close());
  const first = await post(baseUrl, []);
  const firstBody = await first.json() as { stop_reason: string; content: Array<{ id: string; input: unknown }> };
  assert.equal(first.status, 200);
  assert.equal(firstBody.stop_reason, "tool_use");
  assert.equal(firstBody.content[0]?.id, "toolu_permission_matrix_control");
  assert.deepEqual(firstBody.content[0]?.input, control.toolInput);

  const second = await post(baseUrl, [{ type: "tool_result", tool_use_id: "toolu_permission_matrix_control", content: "public" }]);
  const secondBody = await second.json() as { stop_reason: string; content: Array<{ id: string; input: unknown }> };
  assert.equal(secondBody.stop_reason, "tool_use");
  assert.equal(secondBody.content[0]?.id, "toolu_permission_matrix_forbidden");
  assert.deepEqual(secondBody.content[0]?.input, spec.toolInput);

  const third = await post(baseUrl, [
    { type: "tool_result", tool_use_id: "toolu_permission_matrix_control", content: "public" },
    { type: "tool_result", tool_use_id: "toolu_permission_matrix_forbidden", content: "denied" },
  ]);
  const thirdBody = await third.json() as { stop_reason: string };
  assert.equal(thirdBody.stop_reason, "end_turn");
  assert.deepEqual(mock.requests, [
    { sequence: 1, toolResultCount: 0, served: "control" },
    { sequence: 2, toolResultCount: 1, served: "forbidden" },
    { sequence: 3, toolResultCount: 2, served: "final" },
  ]);
});

test("mock API supports Anthropic-style server-sent events", async (t) => {
  const mock = new MockAnthropicServer(control, spec);
  const baseUrl = await mock.start();
  t.after(() => mock.close());
  const response = await fetch(`${baseUrl}/v1/messages?beta=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "stub", messages: [], stream: true }),
  });
  const body = await response.text();
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.match(body, /event: message_start/);
  assert.match(body, /input_json_delta/);
  assert.match(body, /event: message_stop/);
});
