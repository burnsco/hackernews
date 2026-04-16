import { Link, Outlet } from "react-router-dom";

export function RootLayout() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[radial-gradient(circle_at_20%_15%,#1e2b52_0%,#090d1a_38%,#020306_85%)] text-[#e8eeff] selection:bg-cyan-300/30">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-24 top-10 h-80 w-80 rounded-full bg-indigo-500/25 blur-[120px]" />
        <div className="absolute -right-20 top-1/4 h-96 w-96 rounded-full bg-teal-400/20 blur-[140px]" />
        <div className="absolute -bottom-28 left-1/3 h-96 w-96 rounded-full bg-cyan-400/15 blur-[130px]" />
      </div>

      <div className="pointer-events-none absolute inset-0 opacity-[0.08] bg-[linear-gradient(rgba(190,201,255,0.6)_1px,transparent_1px)] bg-size-[100%_4px]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_50%,rgba(0,0,0,0.65)_100%)]" />

      <main className="relative z-10 mx-auto max-w-6xl px-6 pb-20 pt-10">
        <header className="mb-6 flex items-center justify-between gap-4 rounded-3xl border border-white/15 bg-slate-950/65 p-4 shadow-[0_18px_40px_rgba(2,8,22,0.45)] backdrop-blur">
          <div>
            <p className="mb-1 text-xs uppercase tracking-[0.32em] text-cyan-100/70">
              Hackernews Relay
            </p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">HN Afterglow</h1>
          </div>
          <Link
            to="/"
            className="rounded-full border border-white/30 bg-white/5 px-5 py-2 text-xs uppercase tracking-[0.2em] text-white/85 transition hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200/70"
          >
            Home
          </Link>
        </header>

        <Outlet />
      </main>
    </div>
  );
}
