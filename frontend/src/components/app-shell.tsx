import { History, Sparkles } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";

import { MoonLogo } from "@/components/moon";
import { cn } from "@/lib/utils";

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
    isActive ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
  );

export function AppShell() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <NavLink to="/" className="flex items-center gap-2.5">
            <MoonLogo className="h-6 w-6" />
            <span className="font-display text-xl font-semibold tracking-tight">izayoi</span>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              sixteen personas, one moon
            </span>
          </NavLink>
          <nav className="flex items-center gap-1">
            <NavLink to="/" className={navLinkClass} end>
              <Sparkles className="h-4 w-4" />
              New session
            </NavLink>
            <NavLink to="/history" className={navLinkClass}>
              <History className="h-4 w-4" />
              History
            </NavLink>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        <Outlet />
      </main>
      <footer className="border-t py-4">
        <p className="mx-auto max-w-6xl px-4 text-xs text-muted-foreground sm:px-6">
          Local-only tool — API keys stay in your environment variables and are never stored
          or displayed.
        </p>
      </footer>
    </div>
  );
}
