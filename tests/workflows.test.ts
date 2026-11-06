import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Script } from "node:vm";
type Node = {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  parameters: Record<string, unknown>;
  retryOnFail?: boolean;
  maxTries?: number;
};
type Workflow = {
  name: string;
  nodes: Node[];
  connections: Record<
    string,
    { main?: { node: string; type: string; index: number }[][] }
  >;
  settings: Record<string, unknown>;
  active: boolean;
};
const read = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../n8n/workflows/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as Workflow;
function checkWorkflow(workflow: Workflow) {
  const ids = new Set(workflow.nodes.map((n) => n.id));
  expect(ids.size).toBe(workflow.nodes.length);
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    expect(workflow.nodes.some((n) => n.name === source)).toBe(true);
    for (const group of outputs.main ?? [])
      for (const link of group)
        expect(workflow.nodes.some((n) => n.name === link.node)).toBe(true);
  }
  for (const node of workflow.nodes)
    if (node.type === "n8n-nodes-base.code") {
      const code = node.parameters.jsCode;
      expect(typeof code).toBe("string");
      new Script(`(function(){${String(code)}\n})`);
      expect(node.parameters.mode).toBe("runOnceForAllItems");
      expect(node.parameters.language).toBe("javaScript");
    }
}
describe("n8n exports (node API: n8n-nodes-base 2.15.1)", () => {
  it("exports a signed, acknowledged request flow with idempotent write-back and no provider senders", () => {
    const w = read("request-notification");
    checkWorkflow(w);
    expect(w.active).toBe(false);
    expect(w.nodes[0]).toMatchObject({
      type: "n8n-nodes-base.webhook",
      typeVersion: 2.1,
      parameters: {
        httpMethod: "POST",
        path: "lendloop-events",
        responseMode: "lastNode",
      },
    });
    expect(w.connections["Convex event webhook"]?.main?.[0]?.[0]?.node).toBe(
      "Verify request and sign mock-log write-back",
    );
    expect(
      w.nodes.some(
        (n) =>
          n.type === "n8n-nodes-base.httpRequest" &&
          n.retryOnFail &&
          n.maxTries === 4,
      ),
    ).toBe(true);
    expect(
      w.nodes.some(
        (n) =>
          n.type.includes("gmail") ||
          n.type.includes("slack") ||
          n.type.includes("discord"),
      ),
    ).toBe(false);
  });
  it("exports a daily Schedule Trigger and signed fetch/write-back HTTP nodes", () => {
    const w = read("overdue-reminders");
    checkWorkflow(w);
    const schedule = w.nodes.find(
      (n) => n.type === "n8n-nodes-base.scheduleTrigger",
    );
    expect(schedule).toMatchObject({
      typeVersion: 1.3,
      parameters: {
        rule: {
          interval: [
            {
              field: "days",
              daysInterval: 1,
              triggerAtHour: 6,
              triggerAtMinute: 0,
            },
          ],
        },
      },
    });
    expect(
      w.nodes.filter(
        (n) =>
          n.type === "n8n-nodes-base.httpRequest" &&
          n.retryOnFail &&
          n.maxTries === 4,
      ),
    ).toHaveLength(2);
    expect(
      w.nodes.some((n) => n.name === "Prepare unique reminder items"),
    ).toBe(true);
  });
  it("exports the Error Trigger based failure workflow and contains no embedded secret values", () => {
    const w = read("error-log");
    checkWorkflow(w);
    expect(w.nodes[0].type).toBe("n8n-nodes-base.errorTrigger");
    for (const name of [
      "request-notification",
      "overdue-reminders",
      "error-log",
    ]) {
      const raw = readFileSync(
        new URL(`../n8n/workflows/${name}.json`, import.meta.url),
        "utf8",
      );
      expect(raw).not.toMatch(/sk_(live|test)_[A-Za-z0-9]{8,}/);
      expect(raw).not.toMatch(
        /INTEGRATION_HMAC_SECRET\s*[:=]\s*["'][^"']{16,}["']/,
      );
    }
  });
});
