import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({
  listings: defineTable({
    ownerId: v.string(),
    name: v.string(),
    category: v.string(),
    condition: v.string(),
    description: v.string(),
    archived: v.boolean(),
    trustedLender: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_archived_category", ["archived", "category"]),
  loans: defineTable({
    listingId: v.id("listings"),
    listingName: v.string(),
    category: v.string(),
    ownerId: v.string(),
    borrowerId: v.string(),
    startDate: v.string(),
    endDate: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("declined"),
      v.literal("returned"),
      v.literal("cancelled"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_listing", ["listingId"])
    .index("by_borrower", ["borrowerId"])
    .index("by_owner", ["ownerId"])
    .index("by_status_end", ["status", "endDate"]),
  outbox: defineTable({
    eventKey: v.string(),
    eventType: v.string(),
    recipientRef: v.string(),
    loanId: v.id("loans"),
    // Optional to allow existing local outbox rows to be inspected and retried
    // explicitly after the snapshot schema change. New events always set these.
    eventStatus: v.optional(v.string()),
    itemName: v.optional(v.string()),
    category: v.optional(v.string()),
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    attemptCount: v.number(),
    nextAttemptAt: v.number(),
    deliveredAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_event_key", ["eventKey"])
    .index("by_next_attempt", ["deliveredAt", "nextAttemptAt"]),
  notificationLog: defineTable({
    uniqueKey: v.string(),
    loanId: v.id("loans"),
    recipientRef: v.string(),
    kind: v.string(),
    status: v.string(),
    createdAt: v.number(),
    label: v.string(),
  })
    .index("by_unique_key", ["uniqueKey"])
    .index("by_loan", ["loanId"]),
  requestNonces: defineTable({
    nonce: v.string(),
    expiresAt: v.number(),
    // Legacy nonce rows intentionally have no binding and fail closed.
    requestKey: v.optional(v.string()),
    responseStatus: v.optional(v.number()),
    responseBody: v.optional(v.any()),
  })
    .index("by_nonce", ["nonce"])
    .index("by_expiry", ["expiresAt"]),
  trustedLenders: defineTable({
    userId: v.string(),
    grantedBy: v.string(),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),
});
