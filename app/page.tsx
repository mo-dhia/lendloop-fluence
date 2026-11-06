import { SignInButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
export const dynamic = "force-dynamic";
async function getPublicTools() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return null;
  try {
    const client = new ConvexHttpClient(url);
    return await client.query(api.lendloop.publicListings, {});
  } catch {
    return null;
  }
}
export default async function Home() {
  const tools = await getPublicTools();
  const clerkReady = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const signedIn = clerkReady ? Boolean((await auth()).userId) : false;
  const signIn = signedIn ? (
    <Link className="button button-dark" href="/dashboard">
      Open your shelf <span aria-hidden="true">↗</span>
    </Link>
  ) : clerkReady ? (
    <SignInButton mode="modal" forceRedirectUrl="/dashboard">
      <button className="button button-dark">
        Sign in <span aria-hidden="true">↗</span>
      </button>
    </SignInButton>
  ) : (
    <button
      className="button button-dark"
      disabled
      title="Add Clerk development keys to enable sign-in"
    >
      Sign in <span aria-hidden="true">↗</span>
    </button>
  );
  return (
    <main className="landing">
      <nav className="topbar">
        <Link className="brand" href="/">
          lendloop<span>↗</span>
        </Link>
        {signIn}
      </nav>
      <section className="hero">
        <p className="eyebrow">
          <i /> A LITTLE MORE SHARING, A LOT LESS BUYING
        </p>
        <h1>
          Good tools.
          <br />
          <em>Good neighbors.</em>
        </h1>
        <p className="hero-copy">
          Borrow what you need. Lend what you don’t.
          <br />
          Your neighborhood’s useful things, all in one place.
        </p>
        <div className="hero-actions">
          {signedIn ? (
            <Link className="button button-green" href="/dashboard">
              Open your shelf <span aria-hidden="true">→</span>
            </Link>
          ) : clerkReady ? (
            <SignInButton mode="modal" forceRedirectUrl="/dashboard">
              <button className="button button-green">
                Sign in to lend or borrow <span aria-hidden="true">→</span>
              </button>
            </SignInButton>
          ) : (
            <button
              className="button button-green"
              disabled
              title="Add Clerk development keys to enable sign-in"
            >
              Sign in to lend or borrow <span aria-hidden="true">→</span>
            </button>
          )}
          <span className="quiet">Free to join · Made for nearby</span>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="sun" />
          <div className="tool-card card-one">
            <svg viewBox="0 0 120 80" focusable="false">
              <path d="M25 58 80 20M30 22l55 38M23 57c-6 0-10-5-8-10 2-6 8-9 15-8l12 2-12 13c-2 2-4 3-7 3ZM88 21c6 0 10 5 8 10-2 6-8 9-15 8l-12-2 12-13c2-2 4-3 7-3Z" />
            </svg>
          </div>
          <div className="tool-card card-two">
            <svg viewBox="0 0 120 80" focusable="false">
              <path d="M24 30h48v25H24zM72 36h16v14H72M32 55l-4 14h18l5-14M88 40h18M50 30l9-12h19v12M36 38h19" />
            </svg>
          </div>
          <div className="loop-mark">↗</div>
          <div className="art-caption">
            SHARING IS A GOOD
            <br />
            LOOK FOR A NEIGHBORHOOD
          </div>
        </div>
      </section>
      <section className="public-shelf">
        <div className="section-head">
          <div>
            <p className="eyebrow">THE COMMUNITY SHELF</p>
            <h2>
              Tools in the loop<span> ({tools?.length ?? "—"})</span>
            </h2>
          </div>
          <p>
            Name and category only.
            <br />
            Details stay with members.
          </p>
        </div>
        {tools === null ? (
          <div className="notice">
            The live community shelf could not be reached. Check the Convex
            connection and refresh. No sample listings are shown as real.
          </div>
        ) : tools.length === 0 ? (
          <div className="notice">
            The shelf is ready for its first neighbor.
          </div>
        ) : (
          <ul className="public-list">
            {tools.map((t) => (
              <li key={t.id}>
                <span>{t.name}</span>
                <span className="tag">{t.category}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <footer>
        <span>lendloop ↗</span>
        <span>A small loop makes a good neighborhood.</span>
      </footer>
    </main>
  );
}
