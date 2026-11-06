import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  internalAction,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { identity, admin, isAdmin, text } from "./security";
import {
  canonicalJson,
  verifySignedRequest,
  signPayload,
} from "./integrationSecurity";
import { httpAction } from "./_generated/server";

const category = v.string();
function isUnavailable(
  loan: { status: string; startDate: string; endDate: string },
  today: string,
) {
  // An approved loan remains out until a participant marks it returned.
  // Future reservations remain visible as available before their start date.
  return (
    loan.status === "approved" &&
    (loan.endDate < today ||
      (loan.startDate <= today && loan.endDate >= today))
  );
}
function validDates(start: string, end: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
    throw new Error("Dates must use YYYY-MM-DD");
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    new Date(a).toISOString().slice(0, 10) !== start ||
    new Date(b).toISOString().slice(0, 10) !== end ||
    start < new Date().toISOString().slice(0, 10) ||
    b < a ||
    b - a > 31 * 86400000
  )
    throw new Error("Choose a valid date range of at most 31 days");
}
async function queueEvent(
  ctx: MutationCtx,
  loan: {
    _id: Id<"loans">;
    listingName: string;
    category: string;
    startDate: string;
    endDate: string;
  },
  eventType: string,
  status: string,
  recipientRef: string,
) {
  const eventKey = `${loan._id}:${status}:${Date.now()}`;
  const outboxId = await ctx.db.insert("outbox", {
    eventKey,
    eventType,
    recipientRef,
    loanId: loan._id,
    eventStatus: status,
    itemName: loan.listingName,
    category: loan.category,
    startDate: loan.startDate,
    endDate: loan.endDate,
    attemptCount: 0,
    nextAttemptAt: Date.now(),
    createdAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.lendloop.deliverOutbox, {
    outboxId,
  });
}
export const publicListings = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("listings")
      .withIndex("by_archived_category", (q) => q.eq("archived", false))
      .collect();
    const today = new Date().toISOString().slice(0, 10);
    const available = await Promise.all(
      rows.map(async (listing) => {
        const loans = await ctx.db
          .query("loans")
          .withIndex("by_listing", (q) => q.eq("listingId", listing._id))
          .collect();
        return loans.every((loan) => !isUnavailable(loan, today));
      }),
    );
    // Deliberately narrow public projection: no owner IDs, descriptions, or private status.
    return rows
      .filter((_, index) => available[index])
      .map(({ _id, name, category: c }) => ({ id: _id, name, category: c }));
  },
});
export const adminRole = query({
  args: {},
  handler: async (ctx) => isAdmin(await identity(ctx)),
});
export const board = query({
  args: { category: v.optional(category) },
  handler: async (ctx, args) => {
    const userId = await identity(ctx);
    const rows = args.category
      ? await ctx.db
          .query("listings")
          .withIndex("by_archived_category", (q) =>
            q.eq("archived", false).eq("category", args.category!),
          )
          .collect()
      : await ctx.db
          .query("listings")
          .withIndex("by_archived_category", (q) => q.eq("archived", false))
          .collect();
    const now = new Date().toISOString().slice(0, 10);
    return Promise.all(
      rows.map(async (listing) => {
        const loans = await ctx.db
          .query("loans")
          .withIndex("by_listing", (q) => q.eq("listingId", listing._id))
          .collect();
        const busy = loans.some((loan) => isUnavailable(loan, now));
        return {
          id: listing._id,
          name: listing.name,
          category: listing.category,
          condition: listing.condition,
          description: listing.description,
          available: !busy,
          trustedLender: listing.trustedLender,
          owner: listing.ownerId === userId,
          ...(isAdmin(userId) ? { ownerId: listing.ownerId } : {}),
        };
      }),
    );
  },
});
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await identity(ctx);
    const [listings, asBorrower, incoming] = await Promise.all([
      ctx.db
        .query("listings")
        .withIndex("by_owner", (q) => q.eq("ownerId", userId))
        .collect(),
      ctx.db
        .query("loans")
        .withIndex("by_borrower", (q) => q.eq("borrowerId", userId))
        .collect(),
      ctx.db
        .query("loans")
        .withIndex("by_owner", (q) => q.eq("ownerId", userId))
        .collect(),
    ]);
    const withActivity = async (loan: (typeof asBorrower)[number]) => ({
      ...loan,
      activity: (
        await ctx.db
          .query("notificationLog")
          .withIndex("by_loan", (q) => q.eq("loanId", loan._id))
          .collect()
      ).map(({ kind, status, createdAt, label }) => ({
        kind,
        status,
        createdAt,
        label,
      })),
    });
    return {
      listings: listings.filter((l) => !l.archived),
      requests: await Promise.all(asBorrower.map(withActivity)),
      incoming: await Promise.all(incoming.map(withActivity)),
    };
  },
});
export const createListing = mutation({
  args: {
    name: v.string(),
    category: v.string(),
    condition: v.string(),
    description: v.string(),
  },
  handler: async (ctx, a) => {
    const ownerId = await identity(ctx);
    const now = Date.now();
    const trusted = await ctx.db
      .query("trustedLenders")
      .withIndex("by_user", (q) => q.eq("userId", ownerId))
      .unique();
    return ctx.db.insert("listings", {
      ownerId,
      name: text(a.name, "Name", 80),
      category: text(a.category, "Category", 40),
      condition: text(a.condition, "Condition", 40),
      description: text(a.description, "Description", 400),
      archived: false,
      trustedLender: Boolean(trusted),
      createdAt: now,
      updatedAt: now,
    });
  },
});
export const updateListing = mutation({
  args: {
    listingId: v.id("listings"),
    name: v.string(),
    category: v.string(),
    condition: v.string(),
    description: v.string(),
  },
  handler: async (ctx, a) => {
    const userId = await identity(ctx);
    const item = await ctx.db.get(a.listingId);
    if (!item || item.archived) throw new Error("Listing not found");
    if (item.ownerId !== userId)
      throw new Error("You can only edit your own listings");
    await ctx.db.patch(item._id, {
      name: text(a.name, "Name", 80),
      category: text(a.category, "Category", 40),
      condition: text(a.condition, "Condition", 40),
      description: text(a.description, "Description", 400),
      updatedAt: Date.now(),
    });
  },
});
export const archiveListing = mutation({
  args: { listingId: v.id("listings") },
  handler: async (ctx, { listingId }) => {
    const userId = await identity(ctx);
    const listing = await ctx.db.get(listingId);
    if (!listing) return;
    if (listing.ownerId !== userId)
      throw new Error("You can only remove your own listings");
    // Preserve listing snapshot and all loan history; remove from public discovery immediately.
    await ctx.db.patch(listingId, { archived: true, updatedAt: Date.now() });
  },
});
export const adminArchiveListing = mutation({
  args: { listingId: v.id("listings") },
  handler: async (ctx, { listingId }) => {
    const userId = await identity(ctx);
    await admin(ctx, userId);
    const item = await ctx.db.get(listingId);
    if (item)
      await ctx.db.patch(item._id, { archived: true, updatedAt: Date.now() });
  },
});
export const requestLoan = mutation({
  args: {
    listingId: v.id("listings"),
    startDate: v.string(),
    endDate: v.string(),
  },
  handler: async (ctx, a) => {
    const borrowerId = await identity(ctx);
    const listing = await ctx.db.get(a.listingId);
    if (!listing || listing.archived) throw new Error("Listing is unavailable");
    if (listing.ownerId === borrowerId)
      throw new Error("You cannot borrow your own tool");
    validDates(a.startDate, a.endDate);
    const existing = await ctx.db
      .query("loans")
      .withIndex("by_listing", (q) => q.eq("listingId", listing._id))
      .collect();
    const today = new Date().toISOString().slice(0, 10);
    if (existing.some((loan) => loan.status === "approved" && loan.endDate < today))
      throw new Error("This tool is still on an overdue loan");
    if (
      existing.some(
        (l) =>
          l.status === "approved" &&
          a.startDate <= l.endDate &&
          a.endDate >= l.startDate,
      )
    )
      throw new Error("Those dates overlap an approved loan");
    const loanId = await ctx.db.insert("loans", {
      listingId: listing._id,
      listingName: listing.name,
      category: listing.category,
      ownerId: listing.ownerId,
      borrowerId,
      startDate: a.startDate,
      endDate: a.endDate,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await queueEvent(
      ctx,
      {
        _id: loanId,
        listingName: listing.name,
        category: listing.category,
        startDate: a.startDate,
        endDate: a.endDate,
      },
      "request.created",
      "pending",
      listing.ownerId,
    );
    return loanId;
  },
});
export const decideRequest = mutation({
  args: {
    loanId: v.id("loans"),
    decision: v.union(v.literal("approved"), v.literal("declined")),
  },
  handler: async (ctx, { loanId, decision }) => {
    const userId = await identity(ctx);
    const loan = await ctx.db.get(loanId);
    if (!loan || loan.ownerId !== userId)
      throw new Error("Only the lender can decide this request");
    if (loan.status !== "pending")
      throw new Error("Only pending requests can be decided");
    if (decision === "approved") {
      const all = await ctx.db
        .query("loans")
        .withIndex("by_listing", (q) => q.eq("listingId", loan.listingId))
        .collect();
      if (
        all.some(
          (l) =>
            l._id !== loanId &&
            l.status === "approved" &&
            loan.startDate <= l.endDate &&
            loan.endDate >= l.startDate,
        )
      )
        throw new Error("Another approved loan now overlaps these dates");
    }
    await ctx.db.patch(loanId, { status: decision, updatedAt: Date.now() });
    await queueEvent(
      ctx,
      loan,
      `request.${decision}`,
      decision,
      loan.borrowerId,
    );
  },
});
export const markReturned = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const userId = await identity(ctx);
    const loan = await ctx.db.get(loanId);
    if (!loan || (loan.ownerId !== userId && loan.borrowerId !== userId))
      throw new Error("Only participants may return this loan");
    if (loan.status !== "approved")
      throw new Error("Only approved loans can be returned");
    await ctx.db.patch(loanId, { status: "returned", updatedAt: Date.now() });
    await queueEvent(
      ctx,
      loan,
      "loan.returned",
      "returned",
      userId === loan.borrowerId ? loan.ownerId : loan.borrowerId,
    );
  },
});
export const automationFailures = query({
  args: {},
  handler: async (ctx) => {
    const id = await identity(ctx);
    await admin(ctx, id);
    return (await ctx.db.query("outbox").collect())
      .filter((row) => row.attemptCount >= 8 && !row.deliveredAt)
      .map((row) => ({
        eventType: row.eventType,
        attempts: row.attemptCount,
        lastError: row.lastError,
        createdAt: row.createdAt,
      }));
  },
});
export const adminLoans = query({
  args: {},
  handler: async (ctx) => {
    const id = await identity(ctx);
    await admin(ctx, id);
    return ctx.db.query("loans").collect();
  },
});
export const trustLender = mutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const adminId = await identity(ctx);
    await admin(ctx, adminId);
    const row = await ctx.db
      .query("trustedLenders")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!row)
      await ctx.db.insert("trustedLenders", {
        userId: text(userId, "User ID", 128),
        grantedBy: adminId,
        createdAt: Date.now(),
      });
    for (const l of await ctx.db
      .query("listings")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .collect())
      await ctx.db.patch(l._id, { trustedLender: true });
  },
});
export const activity = query({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const id = await identity(ctx);
    const loan = await ctx.db.get(loanId);
    if (!loan || (loan.borrowerId !== id && loan.ownerId !== id))
      throw new Error("Access denied");
    return (
      await ctx.db
        .query("notificationLog")
        .withIndex("by_loan", (q) => q.eq("loanId", loanId))
        .collect()
    ).map(({ kind, status, createdAt, label }) => ({
      kind,
      status,
      createdAt,
      label,
    }));
  },
});

export const integration = httpAction(async (ctx, req) => {
  const url = new URL(req.url);
  if (Number(req.headers.get("content-length") ?? 0) > 16_384)
    return new Response("Request too large", { status: 413 });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return new Response("Invalid body", { status: 400 });
    body = parsed as Record<string, unknown>;
    await verifySignedRequest(req, url.pathname, body);
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const nonce = req.headers.get("x-lendloop-nonce")!;
  const timestamp = req.headers.get("x-lendloop-timestamp")!;
  const signature = req.headers.get("x-lendloop-signature")!;
  const path = url.pathname;
  if (path === "/lendloop/automation/event") {
    const { eventKey, eventType, loanId, status, recipientRef } = body;
    if (
      typeof eventKey !== "string" ||
      eventKey.length > 200 ||
      typeof loanId !== "string" ||
      typeof eventType !== "string" ||
      typeof status !== "string" ||
      typeof recipientRef !== "string"
    )
      return new Response("Invalid body", { status: 400 });
  } else if (path === "/lendloop/automation/reminder") {
    const { loanId, reminderKey } = body;
    if (
      typeof loanId !== "string" ||
      typeof reminderKey !== "string" ||
      !/^overdue:[^:]{1,128}:\d{4}-\d{2}-\d{2}$/.test(reminderKey)
    )
      return new Response("Invalid body", { status: 400 });
  } else if (path !== "/lendloop/automation/overdue") {
    return new Response("Not found", { status: 404 });
  }
  try {
    const result = await ctx.runMutation(internal.lendloop.handleSignedRequest, {
      path,
      nonce,
      expiresAt: Date.now() + 5 * 60 * 1000,
      requestKey: `${path}\n${timestamp}\n${signature}\n${canonicalJson(body)}`,
      body,
    });
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Integration error";
    if (message.includes("Nonce replay or binding mismatch"))
      return new Response("Replay detected or request binding mismatch", {
        status: 409,
      });
    // The Convex mutation is transactional: operation failures do not commit
    // the nonce record, so the same signed request may be retried safely.
    return new Response("Integration operation failed", { status: 500 });
  }
});

export const handleSignedRequest = internalMutation({
  args: {
    path: v.string(),
    nonce: v.string(),
    expiresAt: v.number(),
    requestKey: v.string(),
    body: v.any(),
  },
  handler: async (ctx, args) => {
    const expired = await ctx.db
      .query("requestNonces")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", Date.now()))
      .take(100);
    for (const old of expired) await ctx.db.delete(old._id);
    const existing = await ctx.db
      .query("requestNonces")
      .withIndex("by_nonce", (q) => q.eq("nonce", args.nonce))
      .unique();
    if (existing && existing.expiresAt > Date.now()) {
      if (
        existing.requestKey !== args.requestKey ||
        existing.responseStatus === undefined ||
        existing.responseBody === undefined
      )
        throw new Error("Nonce replay or binding mismatch");
      return {
        status: existing.responseStatus,
        body: existing.responseBody,
      };
    }
    if (existing) await ctx.db.delete(existing._id);

    let status = 200;
    let responseBody: unknown;
    if (args.path === "/lendloop/automation/overdue") {
      const today = new Date().toISOString().slice(0, 10);
      const loans = await ctx.db
        .query("loans")
        .withIndex("by_status_end", (q) =>
          q.eq("status", "approved").lt("endDate", today),
        )
        .collect();
      responseBody = {
        loans: loans.map((loan) => ({
          loanId: loan._id,
          borrowerRef: loan.borrowerId,
          item: loan.listingName,
          endDate: loan.endDate,
        })),
      };
    } else if (args.path === "/lendloop/automation/event") {
      const event = args.body as {
        eventKey: string;
        eventType: string;
        loanId: string;
        status: string;
        recipientRef: string;
      };
      const key = `event:${event.eventKey}`;
      const found = await ctx.db
        .query("notificationLog")
        .withIndex("by_unique_key", (q) => q.eq("uniqueKey", key))
        .unique();
      let recorded = false;
      if (!found) {
        const loan = await ctx.db.get(event.loanId as Id<"loans">);
        const expectedRecipient =
          event.eventType === "request.created"
            ? loan?.ownerId
            : event.eventType === "loan.returned"
              ? event.recipientRef
              : loan?.borrowerId;
        if (
          loan &&
          event.recipientRef === expectedRecipient &&
          (event.eventType !== "loan.returned" ||
            event.recipientRef === loan.ownerId ||
            event.recipientRef === loan.borrowerId)
        ) {
          await ctx.db.insert("notificationLog", {
            uniqueKey: key,
            loanId: loan._id,
            recipientRef: event.recipientRef,
            kind: event.eventType,
            status: "logged-mock",
            createdAt: Date.now(),
            label: `Mock notification · ${event.status}`,
          });
          recorded = true;
        }
      }
      responseBody = { ok: true, recorded };
    } else if (args.path === "/lendloop/automation/reminder") {
      const reminder = args.body as { loanId: string; reminderKey: string };
      const found = await ctx.db
        .query("notificationLog")
        .withIndex("by_unique_key", (q) =>
          q.eq("uniqueKey", reminder.reminderKey),
        )
        .unique();
      let recorded = false;
      if (!found) {
        const loan = await ctx.db.get(reminder.loanId as Id<"loans">);
        if (
          loan &&
          loan.status === "approved" &&
          loan.endDate < new Date().toISOString().slice(0, 10)
        ) {
          await ctx.db.insert("notificationLog", {
            uniqueKey: reminder.reminderKey,
            loanId: loan._id,
            recipientRef: loan.borrowerId,
            kind: "overdue-reminder",
            status: "logged-mock",
            createdAt: Date.now(),
            label: "Overdue reminder logged (mock)",
          });
          recorded = true;
        }
      }
      responseBody = { ok: true, recorded };
    } else {
      status = 404;
      responseBody = { error: "Not found" };
    }

    await ctx.db.insert("requestNonces", {
      nonce: args.nonce,
      expiresAt: args.expiresAt,
      requestKey: args.requestKey,
      responseStatus: status,
      responseBody,
    });
    return { status, body: responseBody };
  },
});
export const overdueLoans = internalQuery({
  args: {},
  handler: async (ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await ctx.db
      .query("loans")
      .withIndex("by_status_end", (q) =>
        q.eq("status", "approved").lt("endDate", today),
      )
      .collect();
    return rows.map((l) => ({
      loanId: l._id,
      borrowerRef: l.borrowerId,
      item: l.listingName,
      endDate: l.endDate,
    }));
  },
});
export const logRequestEvent = internalMutation({
  args: {
    eventKey: v.string(),
    loanId: v.id("loans"),
    eventType: v.string(),
    status: v.string(),
    recipientRef: v.string(),
  },
  handler: async (ctx, args) => {
    const key = `event:${args.eventKey}`;
    const existing = await ctx.db
      .query("notificationLog")
      .withIndex("by_unique_key", (q) => q.eq("uniqueKey", key))
      .unique();
    if (existing) return false;
    const loan = await ctx.db.get(args.loanId);
    if (!loan) return false;
    const expectedRecipient =
      args.eventType === "request.created"
        ? loan.ownerId
        : args.eventType === "loan.returned"
          ? args.recipientRef
          : loan.borrowerId;
    if (
      args.recipientRef !== expectedRecipient ||
      (args.eventType === "loan.returned" &&
        args.recipientRef !== loan.ownerId &&
        args.recipientRef !== loan.borrowerId)
    )
      return false;
    await ctx.db.insert("notificationLog", {
      uniqueKey: key,
      loanId: args.loanId,
      recipientRef: args.recipientRef,
      kind: args.eventType,
      status: "logged-mock",
      createdAt: Date.now(),
      label: `Mock notification · ${args.status}`,
    });
    return true;
  },
});
export const logReminder = internalMutation({
  args: { loanId: v.id("loans"), reminderKey: v.string() },
  handler: async (ctx, { loanId, reminderKey }) => {
    const existing = await ctx.db
      .query("notificationLog")
      .withIndex("by_unique_key", (q) => q.eq("uniqueKey", reminderKey))
      .unique();
    if (existing) return false;
    const loan = await ctx.db.get(loanId);
    if (
      !loan ||
      loan.status !== "approved" ||
      loan.endDate >= new Date().toISOString().slice(0, 10)
    )
      return false;
    await ctx.db.insert("notificationLog", {
      uniqueKey: reminderKey,
      loanId: loan._id,
      recipientRef: loan.borrowerId,
      kind: "overdue-reminder",
      status: "logged-mock",
      createdAt: Date.now(),
      label: "Overdue reminder logged (mock)",
    });
    return true;
  },
});
export const pendingOutbox = internalQuery({
  args: { outboxId: v.id("outbox") },
  handler: (ctx, { outboxId }) => ctx.db.get(outboxId),
});
export const markOutboxDelivered = internalMutation({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    const row = await ctx.db.get(outboxId);
    if (row)
      await ctx.db.patch(outboxId, {
        deliveredAt: Date.now(),
        lastError: undefined,
      });
  },
});
export const retryOutbox = internalMutation({
  args: { outboxId: v.id("outbox"), error: v.string() },
  handler: async (ctx, { outboxId, error }) => {
    const row = await ctx.db.get(outboxId);
    if (!row || row.deliveredAt) return;
    const attemptCount = row.attemptCount + 1;
    const delay = Math.min(
      60 * 60 * 1000,
      1000 * 2 ** Math.min(attemptCount, 12),
    );
    await ctx.db.patch(outboxId, {
      attemptCount,
      nextAttemptAt: Date.now() + delay,
      lastError: error.slice(0, 300),
    });
    if (attemptCount < 8)
      await ctx.scheduler.runAfter(delay, internal.lendloop.deliverOutbox, {
        outboxId,
      });
  },
});
export const deliverOutbox = internalAction({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    const row = await ctx.runQuery(internal.lendloop.pendingOutbox, {
      outboxId,
    });
    if (!row || row.deliveredAt) return;
    const url = process.env.N8N_WEBHOOK_URL;
    const secret = process.env.INTEGRATION_HMAC_SECRET;
    if (!url || !secret) {
      await ctx.runMutation(internal.lendloop.retryOutbox, {
        outboxId,
        error: "Missing n8n webhook or HMAC secret",
      });
      return;
    }
    try {
      if (
        !row.eventStatus ||
        !row.itemName ||
        !row.category ||
        !row.startDate ||
        !row.endDate
      )
        throw new Error(
          "Legacy outbox event has no immutable snapshot; manual review required",
        );
      const body = {
        eventKey: row.eventKey,
        eventType: row.eventType,
        status: row.eventStatus,
        recipientRef: row.recipientRef,
        loan: {
          id: row.loanId,
          item: row.itemName,
          category: row.category,
          startDate: row.startDate,
          endDate: row.endDate,
        },
      };
      const nonce = crypto.randomUUID();
      const timestamp = String(Math.floor(Date.now() / 1000));
      const path = new URL(url).pathname;
      const signature = await signPayload(path, body, timestamp, nonce, secret);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lendloop-timestamp": timestamp,
          "x-lendloop-nonce": nonce,
          "x-lendloop-signature": signature,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`n8n returned ${response.status}`);
      await ctx.runMutation(internal.lendloop.markOutboxDelivered, {
        outboxId,
      });
    } catch (error) {
      await ctx.runMutation(internal.lendloop.retryOutbox, {
        outboxId,
        error: error instanceof Error ? error.message : "Delivery failed",
      });
    }
  },
});
export const getLoanForEvent = internalQuery({
  args: { loanId: v.id("loans") },
  handler: (ctx, { loanId }) => ctx.db.get(loanId),
});
