import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import {
  signPayload,
  verifySignedRequest,
} from "../convex/integrationSecurity";
const modules = import.meta.glob("../convex/**/*.ts");
function future(days: number) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}
const dates = { start: future(5), end: future(6) };
function signedRequest(
  path: string,
  body: unknown,
  now = Date.now(),
  nonce = "request-nonce-123456",
) {
  const timestamp = String(Math.floor(now / 1000));
  return signPayload(
    path,
    body,
    timestamp,
    nonce,
    "test-secret-that-is-not-a-real-key",
  ).then(
    (signature) =>
      new Request(`http://local${path}`, {
        method: "POST",
        headers: {
          "x-lendloop-timestamp": timestamp,
          "x-lendloop-nonce": nonce,
          "x-lendloop-signature": signature,
        },
        body: JSON.stringify(body),
      }),
  );
}
describe("LendLoop Convex authorization and state", () => {
  beforeEach(() => {
    delete process.env.ADMIN_CLERK_IDS;
    process.env.INTEGRATION_HMAC_SECRET = "test-secret-that-is-not-a-real-key";
  });
  it("requires identity for member queries and all mutations", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.lendloop.mine, {})).rejects.toThrow();
    await expect(
      t.mutation(api.lendloop.createListing, {
        name: "Saw",
        category: "garden",
        condition: "good",
        description: "Short",
      }),
    ).rejects.toThrow();
  });
  it("isolates listing ownership, preserves loan snapshots on archive, and returns a privacy-limited public DTO", async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity({ subject: "user-owner" });
    const other = t.withIdentity({ subject: "user-other" });
    const id = await owner.mutation(api.lendloop.createListing, {
      name: "Hand saw",
      category: "hand tools",
      condition: "Good",
      description: "A private detail",
    });
    await expect(
      other.mutation(api.lendloop.updateListing, {
        listingId: id,
        name: "Changed",
        category: "garden",
        condition: "bad",
        description: "No",
      }),
    ).rejects.toThrow();
    const publicRows = await t.query(api.lendloop.publicListings, {});
    expect(publicRows[0]).toEqual({
      id,
      name: "Hand saw",
      category: "hand tools",
    });
    const loan = await other.mutation(api.lendloop.requestLoan, {
      listingId: id,
      startDate: dates.start,
      endDate: dates.end,
    });
    await owner.mutation(api.lendloop.archiveListing, { listingId: id });
    expect(await t.query(api.lendloop.publicListings, {})).toEqual([]);
    const mine = await other.query(api.lendloop.mine, {});
    expect(mine.requests[0]).toMatchObject({
      listingName: "Hand saw",
      status: "pending",
    });
    expect(loan).toBeTruthy();
  });
  it("blocks self-borrowing, invalid ranges, and a non-lender attempting to decide a request", async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity({ subject: "owner" });
    const borrower = t.withIdentity({ subject: "borrower" });
    const id = await owner.mutation(api.lendloop.createListing, {
      name: "Drill",
      category: "power tools",
      condition: "Good",
      description: "Cordless",
    });
    await expect(
      owner.mutation(api.lendloop.requestLoan, {
        listingId: id,
        startDate: dates.start,
        endDate: dates.end,
      }),
    ).rejects.toThrow(/own tool/);
    await expect(
      borrower.mutation(api.lendloop.requestLoan, {
        listingId: id,
        startDate: future(9),
        endDate: future(8),
      }),
    ).rejects.toThrow(/date range/);
    await expect(
      borrower.mutation(api.lendloop.requestLoan, {
        listingId: id,
        startDate: "2026-02-31",
        endDate: "2026-03-02",
      }),
    ).rejects.toThrow(/date range/);
    await expect(
      borrower.mutation(api.lendloop.requestLoan, {
        listingId: id,
        startDate: future(-2),
        endDate: future(-1),
      }),
    ).rejects.toThrow(/date range/);
    const loan = await borrower.mutation(api.lendloop.requestLoan, {
      listingId: id,
      startDate: dates.start,
      endDate: dates.end,
    });
    await expect(
      borrower.mutation(api.lendloop.decideRequest, {
        loanId: loan,
        decision: "approved",
      }),
    ).rejects.toThrow(/lender/);
  });
  it("prevents two overlapping approvals and restricts return to loan participants", async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity({ subject: "owner" });
    const a = t.withIdentity({ subject: "borrower-a" });
    const b = t.withIdentity({ subject: "borrower-b" });
    const outsider = t.withIdentity({ subject: "outsider" });
    const id = await owner.mutation(api.lendloop.createListing, {
      name: "Ladder",
      category: "other",
      condition: "Good",
      description: "Stable",
    });
    const one = await a.mutation(api.lendloop.requestLoan, {
      listingId: id,
      startDate: dates.start,
      endDate: dates.end,
    });
    const two = await b.mutation(api.lendloop.requestLoan, {
      listingId: id,
      startDate: dates.start,
      endDate: dates.end,
    });
    const approvals = await Promise.allSettled([
      owner.mutation(api.lendloop.decideRequest, {
        loanId: one,
        decision: "approved",
      }),
      owner.mutation(api.lendloop.decideRequest, {
        loanId: two,
        decision: "approved",
      }),
    ]);
    expect(approvals.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(approvals.filter((r) => r.status === "rejected")).toHaveLength(1);
    const activeLoan = (
      await t.run((ctx) => ctx.db.query("loans").collect())
    ).find((l) => l.status === "approved")!;
    expect(await t.query(api.lendloop.publicListings, {})).toHaveLength(1);
    await expect(
      outsider.mutation(api.lendloop.markReturned, { loanId: activeLoan._id }),
    ).rejects.toThrow(/participants/);
    const participant = activeLoan.borrowerId === "borrower-a" ? a : b;
    await participant.mutation(api.lendloop.markReturned, {
      loanId: activeLoan._id,
    });
    expect(
      (await participant.query(api.lendloop.mine, {})).requests.some(
        (l) => l.status === "returned",
      ),
    ).toBe(true);
    expect(await t.query(api.lendloop.publicListings, {})).toMatchObject([
      { name: "Ladder", category: "other" },
    ]);
  });
  it("keeps approved overdue tools unavailable, frees returned tools, and preserves future reservation overlap checks", async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity({ subject: "owner" });
    const borrower = t.withIdentity({ subject: "borrower" });
    const listingId = await owner.mutation(api.lendloop.createListing, {
      name: "Tile saw",
      category: "power tools",
      condition: "Good",
      description: "Wet saw",
    });
    const prior = (days: number) =>
      new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const overdueLoanId = await t.run((ctx) =>
      ctx.db.insert("loans", {
        listingId,
        listingName: "Tile saw",
        category: "power tools",
        ownerId: "owner",
        borrowerId: "borrower",
        startDate: prior(4),
        endDate: prior(1),
        status: "approved",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    expect(await t.query(api.lendloop.publicListings, {})).toEqual([]);
    expect((await owner.query(api.lendloop.board, {}))[0].available).toBe(
      false,
    );
    await expect(
      borrower.mutation(api.lendloop.requestLoan, {
        listingId,
        startDate: future(1),
        endDate: future(2),
      }),
    ).rejects.toThrow(/overdue/);

    await t.run((ctx) =>
      ctx.db.patch(overdueLoanId, { status: "returned", updatedAt: Date.now() }),
    );
    expect(await t.query(api.lendloop.publicListings, {})).toHaveLength(1);
    expect((await owner.query(api.lendloop.board, {}))[0].available).toBe(
      true,
    );

    const futureLoanId = await t.run((ctx) =>
      ctx.db.insert("loans", {
        listingId,
        listingName: "Tile saw",
        category: "power tools",
        ownerId: "owner",
        borrowerId: "borrower",
        startDate: future(5),
        endDate: future(6),
        status: "approved",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    expect(await t.query(api.lendloop.publicListings, {})).toHaveLength(1);
    expect((await owner.query(api.lendloop.board, {}))[0].available).toBe(
      true,
    );
    await expect(
      borrower.mutation(api.lendloop.requestLoan, {
        listingId,
        startDate: future(5),
        endDate: future(5),
      }),
    ).rejects.toThrow(/overlap/);
    expect((await t.run((ctx) => ctx.db.get(futureLoanId)))?.status).toBe(
      "approved",
    );
  });
  it("stores immutable event snapshots and recipient for delayed or reordered delivery", async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity({ subject: "owner" });
    const borrower = t.withIdentity({ subject: "borrower" });
    const listingId = await owner.mutation(api.lendloop.createListing, {
      name: "Camping stove",
      category: "camping",
      condition: "Good",
      description: "Two burner",
    });
    const loanId = await borrower.mutation(api.lendloop.requestLoan, {
      listingId,
      startDate: dates.start,
      endDate: dates.end,
    });
    await owner.mutation(api.lendloop.decideRequest, {
      loanId,
      decision: "approved",
    });
    await borrower.mutation(api.lendloop.markReturned, { loanId });
    const events = await t.run((ctx) =>
      ctx.db
        .query("outbox")
        .withIndex("by_event_key")
        .collect(),
    );
    expect(events).toHaveLength(3);
    const byType = Object.fromEntries(
      events.map((event) => [event.eventType, event]),
    );
    expect(byType["request.created"].eventStatus).toBe("pending");
    expect(byType["request.approved"].eventStatus).toBe("approved");
    expect(byType["loan.returned"].eventStatus).toBe("returned");
    expect(byType["request.created"].recipientRef).toBe("owner");
    expect(byType["request.approved"].recipientRef).toBe("borrower");
    expect(byType["loan.returned"].recipientRef).toBe("owner");
    expect(events.every((event) =>
      [event.itemName, event.category, event.startDate, event.endDate].every(
        Boolean,
      ),
    )).toBe(true);
    const current = await t.run((ctx) => ctx.db.get(loanId));
    expect(current?.status).toBe("returned");
    expect(byType["request.created"].eventStatus).toBe("pending");
    expect(byType["request.created"].itemName).toBe("Camping stove");
  });
  it("enforces admin allowlist server-side for listing removal, all loans, and trusted lenders", async () => {
    process.env.ADMIN_CLERK_IDS = "admin-root";
    const t = convexTest(schema, modules);
    const user = t.withIdentity({ subject: "user" });
    const admin = t.withIdentity({ subject: "admin-root" });
    const owner = t.withIdentity({ subject: "owner" });
    const listing = await owner.mutation(api.lendloop.createListing, {
      name: "Trowel",
      category: "garden",
      condition: "Good",
      description: "Steel",
    });
    await expect(user.query(api.lendloop.adminLoans, {})).rejects.toThrow(
      /Admin/,
    );
    await expect(
      user.mutation(api.lendloop.adminArchiveListing, { listingId: listing }),
    ).rejects.toThrow(/Admin/);
    await expect(
      user.mutation(api.lendloop.trustLender, { userId: "owner" }),
    ).rejects.toThrow(/Admin/);
    expect(await admin.query(api.lendloop.adminLoans, {})).toEqual([]);
    await admin.mutation(api.lendloop.trustLender, { userId: "owner" });
    expect((await admin.query(api.lendloop.board, {}))[0].trustedLender).toBe(
      true,
    );
    const trustedTool = await owner.mutation(api.lendloop.createListing, {
      name: "Gloves",
      category: "garden",
      condition: "New",
      description: "Pair",
    });
    expect(
      (await admin.query(api.lendloop.board, {})).find(
        (l) => l.id === trustedTool,
      )?.trustedLender,
    ).toBe(true);
    await admin.mutation(api.lendloop.adminArchiveListing, {
      listingId: listing,
    });
    expect(await t.query(api.lendloop.publicListings, {})).toMatchObject([
      { name: "Gloves", category: "garden" },
    ]);
  });
  it("rejects tampered, wrong-path, wrong-method, and stale HMAC requests", async () => {
    const body = { hello: "neighbor" };
    const good = await signedRequest("/lendloop/automation/overdue", body);
    await expect(
      verifySignedRequest(good, "/lendloop/automation/overdue", body),
    ).resolves.toBeUndefined();
    await expect(
      verifySignedRequest(good, "/lendloop/automation/overdue", {
        hello: "changed",
      }),
    ).rejects.toThrow(/signature/);
    await expect(
      verifySignedRequest(good, "/different-path", body),
    ).rejects.toThrow(/signature/);
    const wrongMethod = new Request(
      "http://local/lendloop/automation/overdue",
      { method: "GET", headers: good.headers },
    );
    await expect(
      verifySignedRequest(wrongMethod, "/lendloop/automation/overdue", body),
    ).rejects.toThrow(/metadata/);
    const stale = await signedRequest(
      "/lendloop/automation/overdue",
      body,
      Date.now() - 600000,
      "stale-nonce-123456",
    );
    await expect(
      verifySignedRequest(stale, "/lendloop/automation/overdue", body),
    ).rejects.toThrow(/Expired/);
  });
  it("replays an exact signed HTTP request from its bound response cache, rejects changed bindings, and leaves failed operations retryable", async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity({ subject: "owner" });
    const borrower = t.withIdentity({ subject: "borrower" });
    const listingId = await owner.mutation(api.lendloop.createListing, {
      name: "Impact driver",
      category: "power tools",
      condition: "Good",
      description: "18V",
    });
    const loanId = await borrower.mutation(api.lendloop.requestLoan, {
      listingId,
      startDate: dates.start,
      endDate: dates.end,
    });
    const payload = {
      eventKey: "retry:request-created",
      eventType: "request.created",
      loanId,
      status: "pending",
      recipientRef: "owner",
    };
    const signed = await signedRequest(
      "/lendloop/automation/event",
      payload,
      Date.now(),
      "ambiguous-write-nonce-01",
    );
    const first = await t.fetch(new URL(signed.url).pathname, {
      method: "POST",
      headers: signed.headers,
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, recorded: true });

    // Simulate the client losing the first response and retrying the exact bytes.
    const retry = await t.fetch(new URL(signed.url).pathname, {
      method: "POST",
      headers: signed.headers,
      body: JSON.stringify(payload),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true, recorded: true });
    expect(
      await t.run((ctx) => ctx.db.query("notificationLog").collect()),
    ).toHaveLength(1);

    const changed = { ...payload, status: "approved" };
    const changedSignature = await signedRequest(
      "/lendloop/automation/event",
      changed,
      Date.now(),
      "ambiguous-write-nonce-01",
    );
    const mismatch = await t.fetch(new URL(changedSignature.url).pathname, {
      method: "POST",
      headers: changedSignature.headers,
      body: JSON.stringify(changed),
    });
    expect(mismatch.status).toBe(409);

    const invalid = { ...payload, loanId: 42 };
    const failedRequest = await signedRequest(
      "/lendloop/automation/event",
      invalid,
      Date.now(),
      "retry-after-handler-error-01",
    );
    const failed = await t.fetch(new URL(failedRequest.url).pathname, {
      method: "POST",
      headers: failedRequest.headers,
      body: JSON.stringify(invalid),
    });
    expect(failed.status).toBe(400);
    const recoverable = await signedRequest(
      "/lendloop/automation/event",
      { ...payload, eventKey: "retry:recovered-after-validation" },
      Date.now(),
      "retry-after-handler-error-01",
    );
    const recovered = await t.fetch(new URL(recoverable.url).pathname, {
      method: "POST",
      headers: recoverable.headers,
      body: JSON.stringify({
        ...payload,
        eventKey: "retry:recovered-after-validation",
      }),
    });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ ok: true, recorded: true });
  });
  it("deduplicates persisted request-event logs and concurrent reminder writebacks, and retains exhausted outbox failure details", async () => {
    process.env.ADMIN_CLERK_IDS = "owner";
    const t = convexTest(schema, modules);
    const owner = t.withIdentity({ subject: "owner" });
    const listing = await owner.mutation(api.lendloop.createListing, {
      name: "Tent",
      category: "camping",
      condition: "Used",
      description: "Two person",
    });
    const loanId = await t.run(async (ctx) => {
      const lid = await ctx.db.insert("loans", {
        listingId: listing,
        listingName: "Tent",
        category: "camping",
        ownerId: "owner",
        borrowerId: "borrower",
        startDate: future(-4),
        endDate: future(-3),
        status: "approved",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return lid;
    });
    const eventLogged = await t.mutation(internal.lendloop.logRequestEvent, {
      eventKey: "event-1",
      loanId,
      eventType: "request.created",
      status: "pending",
      recipientRef: "owner",
    });
    const duplicateEvent = await t.mutation(internal.lendloop.logRequestEvent, {
      eventKey: "event-1",
      loanId,
      eventType: "request.created",
      status: "pending",
      recipientRef: "owner",
    });
    expect(eventLogged).toBe(true);
    expect(duplicateEvent).toBe(false);
    const results = await Promise.all([
      t.mutation(internal.lendloop.logReminder, {
        loanId,
        reminderKey: "overdue:loan-1:2026-11-06",
      }),
      t.mutation(internal.lendloop.logReminder, {
        loanId,
        reminderKey: "overdue:loan-1:2026-11-06",
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const entries = await owner.query(api.lendloop.activity, { loanId });
    expect(entries).toHaveLength(2);
    const outboxId = await t.run((ctx) =>
      ctx.db.insert("outbox", {
        eventKey: "failure:test",
        eventType: "request.created",
        recipientRef: "owner",
        loanId,
        attemptCount: 7,
        nextAttemptAt: Date.now(),
        lastError: "previous",
        createdAt: Date.now(),
      }),
    );
    await t.mutation(internal.lendloop.retryOutbox, {
      outboxId,
      error: "network down",
    });
    const failures = await owner.query(api.lendloop.automationFailures, {});
    expect(failures).toContainEqual(
      expect.objectContaining({
        eventType: "request.created",
        attempts: 8,
        lastError: "network down",
      }),
    );
  });
});
