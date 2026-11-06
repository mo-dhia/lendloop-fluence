import type { QueryCtx, MutationCtx, ActionCtx } from "./_generated/server";
export type Ctx = QueryCtx | MutationCtx | ActionCtx;
export async function identity(ctx: Ctx) {
  const user = await ctx.auth.getUserIdentity();
  if (!user?.subject) throw new Error("Authentication required");
  return user.subject;
}
export function isAdmin(userId: string) {
  const allowlist = (process.env.ADMIN_CLERK_IDS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return allowlist.includes(userId);
}
export async function admin(ctx: Ctx, userId: string) {
  if (!isAdmin(userId)) throw new Error("Admin access required");
}
export function text(value: string, label: string, max: number) {
  const clean = value.trim();
  if (!clean || clean.length > max)
    throw new Error(
      `${label} is required and must be at most ${max} characters`,
    );
  return clean;
}
