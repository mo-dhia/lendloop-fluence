"use client";
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="error-page">
      <p className="eyebrow">
        <i /> LENDLOOP
      </p>
      <h1>That didn’t load.</h1>
      <p>
        The live board is temporarily unavailable. Your actions are protected;
        try again in a moment.
      </p>
      <button className="button button-dark" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
