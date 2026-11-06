import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Dashboard from "../../components/Dashboard";
export default async function DashboardPage() {
  if (
    !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
    !process.env.CLERK_SECRET_KEY ||
    !process.env.NEXT_PUBLIC_CONVEX_URL
  ) {
    return (
      <main className="dashboard">
        <header className="dash-header">
          <Link className="brand" href="/">
            lendloop<span>↗</span>
          </Link>
        </header>
        <section className="setup-state">
          <p className="eyebrow">
            <i /> MEMBER BOARD
          </p>
          <h1>Connect your neighborhood.</h1>
          <p>
            Add Clerk development keys and a Convex deployment URL to unlock
            member features. No demo account or sample listings are created.
          </p>
          <Link href="/" className="button button-dark">
            Back to the public shelf
          </Link>
        </section>
      </main>
    );
  }
  const session = await auth();
  if (!session.userId) redirect("/");
  return <Dashboard />;
}
