import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, resolveRuntimeEnvironment } from "../src/index.js";

test("uses non-secret manifest arguments when Claude Desktop omits MCPB environment values", () => {
  const environment = resolveRuntimeEnvironment(
    { LICENSE_KEY: "kept-in-environment" } as NodeJS.ProcessEnv,
    [
      "--project-root=D:\\Projects\\Demo",
      "--license-service-url=https://recoveryaudit.m2ai.tech",
      "--app-mode=live"
    ]
  );
  assert.equal(environment.PROJECT_ROOT, "D:\\Projects\\Demo");
  assert.equal(environment.LICENSE_SERVICE_URL, "https://recoveryaudit.m2ai.tech");
  assert.equal(environment.APP_MODE, "live");
  assert.equal(environment.LICENSE_KEY, "kept-in-environment");
});

test("exposes the audit and billing-management workflows and returns structured cited findings over MCP", async () => {
  const root = await mkdtemp(join(tmpdir(), "change-order-mcp-"));
  const server = createServer(root, { environment: { M2AI_STATE_DIR: join(root, ".state") } as NodeJS.ProcessEnv });
  const client = new Client({ name: "recovery-audit-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await writeFile(
      join(root, "CO-900.txt"),
      "Change Order CO-900 | 2026-01-05 | Approved by owner | $9,900 | Not invoiced",
      "utf8"
    );
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["audit_change_order_folder", "manage_change_order_subscription", "show_recovery_key"]);
    assert.equal(listed.tools[0]?.annotations?.readOnlyHint, true);
    assert.equal(listed.tools[0]?.annotations?.destructiveHint, false);
    assert.equal(listed.tools[0]?.annotations?.openWorldHint, false);

    const result = await client.callTool({
      name: "audit_change_order_folder",
      arguments: { as_of_date: "2026-08-27", aging_days: 30 }
    });
    assert.notEqual(result.isError, true);
    const structured = result.structuredContent as { findings?: Array<{ type: string }> } | undefined;
    assert.ok(structured?.findings?.some((finding) => finding.type === "apparently_unbilled"));
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.find(
      (item: unknown): item is { type: "text"; text: string } =>
        typeof item === "object" && item !== null && "type" in item && "text" in item &&
        item.type === "text" && typeof item.text === "string"
    );
    assert.ok(text?.text.includes("Human review is required"));
    assert.ok(text?.text.includes("CO-900.txt"));
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
