"use client";
import { Show, UserButton } from "@clerk/nextjs";
import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useMutation,
  useQuery,
} from "convex/react";
import type { FunctionReturnType } from "convex/server";
import Link from "next/link";
import { api } from "../convex/_generated/api";
import { Suspense, useState } from "react";
type Tab = "board" | "listings" | "requests" | "incoming" | "admin";
type BoardTool = FunctionReturnType<typeof api.lendloop.board>[number];
type MemberData = FunctionReturnType<typeof api.lendloop.mine>;
type LoanRow = MemberData["requests"][number];
type AdminLoan = FunctionReturnType<typeof api.lendloop.adminLoans>[number];
type FailureRow = FunctionReturnType<
  typeof api.lendloop.automationFailures
>[number];
const categories = [
  "power tools",
  "garden",
  "kitchen",
  "camping",
  "hand tools",
  "other",
];
export default function Dashboard() {
  return (
    <>
      <AuthLoading>
        <main className="dashboard">
          <section className="setup-state" aria-live="polite">
            <p className="eyebrow">
              <i /> MEMBER BOARD
            </p>
            <h1>Connecting your neighborhood.</h1>
            <p>Verifying your secure member session…</p>
          </section>
        </main>
      </AuthLoading>
      <Unauthenticated>
        <main className="dashboard">
          <section className="setup-state" aria-live="polite">
            <p className="eyebrow">
              <i /> MEMBER BOARD
            </p>
            <h1>Sign in to continue.</h1>
            <p>Your member session could not be verified. Please sign in again.</p>
            <Link href="/" className="button button-dark">
              Back to the public shelf
            </Link>
          </section>
        </main>
      </Unauthenticated>
      <Authenticated>
        <DashboardContent />
      </Authenticated>
    </>
  );
}

function DashboardContent() {
  const [tab, setTab] = useState<Tab>("board");
  const [category, setCategory] = useState("all");
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const isAdmin = useQuery(api.lendloop.adminRole, {});
  const allLoans = useQuery(api.lendloop.adminLoans, isAdmin ? {} : "skip");
  const failedEvents = useQuery(
    api.lendloop.automationFailures,
    isAdmin ? {} : "skip",
  );
  const board = useQuery(api.lendloop.board, {
    category: category === "all" ? undefined : category,
  });
  const mine = useQuery(api.lendloop.mine, {});
  const create = useMutation(api.lendloop.createListing);
  const update = useMutation(api.lendloop.updateListing);
  const archive = useMutation(api.lendloop.archiveListing);
  const request = useMutation(api.lendloop.requestLoan);
  const decide = useMutation(api.lendloop.decideRequest);
  const returned = useMutation(api.lendloop.markReturned);
  const adminArchive = useMutation(api.lendloop.adminArchiveListing);
  const trust = useMutation(api.lendloop.trustLender);
  async function act(fn: () => Promise<unknown>) {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Something went wrong. Please try again.",
      );
    }
  }
  const active =
    tab === "board" ? (
      <div className="tool-grid">
        {board === undefined ? (
          <p className="notice">Loading the live board…</p>
        ) : board.length === 0 ? (
          <p className="notice">No tools match this shelf yet.</p>
        ) : (
          board.map((t: BoardTool) => (
            <article className="listing-card" key={t.id}>
              <div className="card-top">
                <span className="tag">{t.category}</span>
                <span
                  className={t.available ? "availability" : "availability busy"}
                >
                  <i />
                  {t.available ? "Available" : "On loan"}
                </span>
              </div>
              <h3>{t.name}</h3>
              <p className="condition">
                {t.condition}
                {t.trustedLender && (
                  <span className="trusted"> · Trusted lender</span>
                )}
              </p>
              <p className="description">{t.description}</p>
              {isAdmin && t.ownerId && (
                <div className="admin-actions">
                  <span>Owner ref · {t.ownerId}</span>
                  <button
                    className="text-button"
                    onClick={() =>
                      void act(() => trust({ userId: t.ownerId! }))
                    }
                  >
                    Mark trusted
                  </button>
                  <button
                    className="text-button"
                    onClick={() =>
                      void act(() => adminArchive({ listingId: t.id }))
                    }
                  >
                    Admin remove
                  </button>
                </div>
              )}
              {!t.owner && (
                <RequestForm
                  onRequest={(startDate, endDate) =>
                    act(() => request({ listingId: t.id, startDate, endDate }))
                  }
                />
              )}
            </article>
          ))
        )}
      </div>
    ) : tab === "listings" ? (
      <div className="stack">
        {mine === undefined ? (
          <p className="notice">Loading your listings…</p>
        ) : mine.listings.length === 0 ? (
          <p className="notice">
            Your shelf is empty. Add something a neighbor could use.
          </p>
        ) : (
          mine.listings.map((t) => (
            <article className="row-card" key={t._id}>
              {editing === t._id ? (
                <ListingForm
                  initial={t}
                  submitLabel="Save changes"
                  onCancel={() => setEditing(null)}
                  onSubmit={(data) =>
                    act(async () => {
                      await update({ listingId: t._id, ...data });
                      setEditing(null);
                    })
                  }
                />
              ) : (
                <>
                  <div>
                    <span className="tag">{t.category}</span>
                    <h3>{t.name}</h3>
                    <p>
                      {t.condition} · {t.description}
                    </p>
                  </div>
                  <div className="row-actions">
                    <button
                      className="button button-light"
                      onClick={() => setEditing(t._id)}
                    >
                      Edit
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        void act(() => archive({ listingId: t._id }))
                      }
                    >
                      Remove
                    </button>
                  </div>
                </>
              )}
            </article>
          ))
        )}
      </div>
    ) : tab === "requests" ? (
      <LoanList
        rows={mine?.requests}
        onReturn={(id) => act(() => returned({ loanId: id }))}
      />
    ) : tab === "incoming" ? (
      <LoanList
        rows={mine?.incoming}
        onDecide={(id, d) => act(() => decide({ loanId: id, decision: d }))}
      />
    ) : (
      <>
        <AdminLoans rows={allLoans} />
        <h2 className="admin-heading">Automation delivery issues</h2>
        <FailureList rows={failedEvents} />
      </>
    );
  return (
    <main className="dashboard">
      <header className="dash-header">
        <Link className="brand" href="/">
          lendloop<span>↗</span>
        </Link>
        <div className="member-label">
          YOUR NEIGHBORHOOD LOOP{" "}
          <Suspense>
            <Show when="signed-in">
              <UserButton />
            </Show>
          </Suspense>
        </div>
      </header>
      <section className="dash-intro">
        <p className="eyebrow">
          <i /> MEMBER BOARD
        </p>
        <div className="intro-line">
          <div>
            <h1>
              Make room for <em>sharing.</em>
            </h1>
            <p>Find a useful thing. Lend the useful thing you have.</p>
          </div>
          <button
            className="button button-green"
            onClick={() => setShowForm((v) => !v)}
          >
            {showForm ? "Close form" : "+ List a tool"}
          </button>
        </div>
      </section>
      {showForm && (
        <ListingForm
          onSubmit={(data) =>
            act(async () => {
              await create(data);
              setShowForm(false);
            })
          }
        />
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <nav className="tabs" aria-label="Member views">
        {(
          [
            ["board", "All tools"],
            ["listings", "My listings"],
            ["requests", "My requests"],
            ["incoming", "Incoming requests"],
            ...(isAdmin ? [["admin", "Admin"] as [Tab, string]] : []),
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            className={tab === key ? "selected" : ""}
            key={key}
            onClick={() => setTab(key)}
          >
            {label}
            {key === "incoming" &&
            mine?.incoming.filter((r) => r.status === "pending").length ? (
              <span className="count">
                {mine.incoming.filter((r) => r.status === "pending").length}
              </span>
            ) : null}
          </button>
        ))}
      </nav>
      {tab === "board" && (
        <label className="filter">
          Filter category
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      )}
      <section className="content">{active}</section>
      <footer>
        <span>lendloop ↗</span>
        <span>Share a little. Borrow a lot.</span>
      </footer>
    </main>
  );
}
function FailureList({ rows }: { rows?: FailureRow[] }) {
  if (!rows) return <p className="notice">Loading automation status…</p>;
  if (!rows.length)
    return (
      <p className="notice">
        No exhausted deliveries. Failed requests retry automatically.
      </p>
    );
  return (
    <div className="stack">
      {rows.map((r, i) => (
        <article className="row-card" key={i}>
          <div>
            <span className="tag">
              {r.eventType} · {r.attempts} attempts
            </span>
            <h3>Delivery needs attention</h3>
            <p>{r.lastError || "No error detail saved"}</p>
          </div>
        </article>
      ))}
    </div>
  );
}
function AdminLoans({ rows }: { rows?: AdminLoan[] }) {
  if (!rows) return <p className="notice">Loading all loans…</p>;
  if (!rows.length) return <p className="notice">No loans recorded.</p>;
  return (
    <div className="stack">
      {rows.map((l) => (
        <article className="row-card" key={l._id}>
          <div>
            <span className="tag">{l.status}</span>
            <h3>{l.listingName}</h3>
            <p>
              {l.startDate} → {l.endDate} · {l.borrowerId} ↔ {l.ownerId}
            </p>
          </div>
        </article>
      ))}
    </div>
  );
}
function ListingForm({
  onSubmit,
  initial,
  submitLabel = "Add to the shelf",
  onCancel,
}: {
  onSubmit: (data: {
    name: string;
    category: string;
    condition: string;
    description: string;
  }) => void;
  initial?: {
    name: string;
    category: string;
    condition: string;
    description: string;
  };
  submitLabel?: string;
  onCancel?: () => void;
}) {
  return (
    <form
      className="listing-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        onSubmit({
          name: String(f.get("name")),
          category: String(f.get("category")),
          condition: String(f.get("condition")),
          description: String(f.get("description")),
        });
      }}
    >
      <label>
        Tool name
        <input
          name="name"
          maxLength={80}
          required
          placeholder="e.g. Cordless drill"
          defaultValue={initial?.name}
        />
      </label>
      <label>
        Category
        <select name="category" defaultValue={initial?.category}>
          {categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label>
        Condition
        <input
          name="condition"
          required
          maxLength={40}
          placeholder="Good, like new…"
          defaultValue={initial?.condition}
        />
      </label>
      <label className="wide">
        Short description
        <textarea
          name="description"
          required
          maxLength={400}
          rows={3}
          placeholder="What should a neighbor know?"
          defaultValue={initial?.description}
        />
      </label>
      <div className="form-actions">
        <button className="button button-dark">{submitLabel}</button>
        {onCancel && (
          <button
            type="button"
            className="button button-light"
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
function RequestForm({
  onRequest,
}: {
  onRequest: (a: string, b: string) => void;
}) {
  return (
    <form
      className="request-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        onRequest(String(f.get("start")), String(f.get("end")));
      }}
    >
      <label>
        From
        <input
          type="date"
          name="start"
          required
          min={new Date().toISOString().slice(0, 10)}
        />
      </label>
      <label>
        Until
        <input
          type="date"
          name="end"
          required
          min={new Date().toISOString().slice(0, 10)}
        />
      </label>
      <button className="button button-dark">Request dates</button>
    </form>
  );
}
function LoanList({
  rows,
  onDecide,
  onReturn,
}: {
  rows?: LoanRow[];
  onDecide?: (id: LoanRow["_id"], d: "approved" | "declined") => void;
  onReturn?: (id: LoanRow["_id"]) => void;
}) {
  if (!rows) return <p className="notice">Loading requests…</p>;
  if (!rows.length)
    return (
      <p className="notice">
        Nothing here yet. Requests will appear when neighbors connect.
      </p>
    );
  return (
    <div className="stack">
      {rows.map((l) => (
        <article className="row-card" key={l._id}>
          <div>
            <span className="tag">{l.status}</span>
            <h3>{l.listingName}</h3>
            <p>
              {l.startDate} → {l.endDate}
            </p>
            {l.activity?.length > 0 && (
              <p className="activity">
                Recent activity · {l.activity[l.activity.length - 1].label}
              </p>
            )}
          </div>
          <div className="row-actions">
            {l.status === "pending" && onDecide && (
              <>
                <button
                  className="button button-green"
                  onClick={() => onDecide(l._id, "approved")}
                >
                  Approve
                </button>
                <button
                  className="button button-light"
                  onClick={() => onDecide(l._id, "declined")}
                >
                  Decline
                </button>
              </>
            )}
            {l.status === "approved" && onReturn && (
              <button
                className="button button-dark"
                onClick={() => onReturn(l._id)}
              >
                Mark returned
              </button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
