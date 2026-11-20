"use client";
import { useEffect, useRef, useState } from "react";
import { LogIn, Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/ui-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { BrandMark } from "@/components/brand-mark";
import { Breadcrumb } from "@/components/opd/breadcrumb";
import { safeNext } from "@/lib/opd/auth-core.js";
import { loadAccess, loginAll } from "@/lib/opd/session.js";

export function OpdLogin() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(true);
  const [svg, setSvg] = useState("");
  const hero = useRef<HTMLDivElement>(null);
  const { theme, toggle } = useTheme();
  const nextPath = () => safeNext(new URLSearchParams(location.search).get("next"), "/portal/");

  useEffect(() => {
    if (loadAccess()?.ok) { location.replace(nextPath()); return; }
    import("@/lib/core/brand.js").then(b => setSvg(b.strataHero()));
    setOnline(navigator.onLine);
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!navigator.onLine) { setMsg("No internet. Signing in needs a connection. You can still enter exploration data without signing in."); return; }
    setBusy(true); setMsg("");
    try {
      const access = await loginAll(email, pw);
      if (!access.ok) {
        const down = access.failures.length;
        setMsg(down && down === Object.values(access.projects).filter((p: any) => p.state !== "unconfigured").length
          ? "Could not reach the servers. Check your connection and try again."
          : "Email or password is wrong, or you have no account yet. Ask a super admin.");
        return;
      }
      location.replace(nextPath());
    } catch (err) {
      setMsg((err as Error)?.message || "Sign-in failed.");
    } finally { setBusy(false); }
  }

  return (
    <div className="login-wrap">
      <div className="login-hero" ref={hero}>
        <Breadcrumb tone="light" className="absolute left-4 top-[calc(var(--safe-t)+1rem)] z-[2]" items={[{ label: "Home", href: "/" }, { label: "Log in" }]} />
        <div dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="hero-copy">
          <h2 style={{ ["--i" as string]: 0 }}>One login for every site and module.</h2>
          <p style={{ ["--i" as string]: 1 }}>Production, exploration and head office data, from one place.</p>
        </div>
      </div>
      <div className="login-pane">
        <Card className="login w-full max-w-[26rem]">
          <div className="flex items-center gap-3">
            <BrandMark className="size-[2.6rem]" />
            <div><h1 className="text-lg font-semibold leading-tight">One Portal Data</h1><p className="text-sm text-muted-foreground">PT Central Abadi Nusantara</p></div>
          </div>
          {!online && <div className="rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-sm text-warning">Offline. Sign-in needs internet, but exploration entry works without signing in.</div>}
          <form onSubmit={submit} className="flex flex-col gap-4" id="lf">
            <label className="flex flex-col gap-1.5 text-sm font-medium"><span>Email</span>
              <Input id="l-email" type="email" autoComplete="username" inputMode="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
            <label className="flex flex-col gap-1.5 text-sm font-medium"><span>Password</span>
              <Input id="l-pw" type="password" autoComplete="current-password" required value={pw} onChange={e => setPw(e.target.value)} /></label>
            {msg && <div role="alert" className="rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-sm text-danger" id="l-msg">{msg}</div>}
            <Button type="submit" size="lg" className="w-full" disabled={busy || !online} id="l-go"><LogIn />{busy ? "Signing in…" : "Sign in"}</Button>
          </form>
          <div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
          <Button type="button" variant="outline" className="w-full" id="l-guest" onClick={() => location.assign("/explo/")}>
            Exploration entry without signing in (offline)
          </Button>
          <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">Same email and password for every project</span>
            <Button type="button" variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">{theme === "dark" ? <Sun /> : <Moon />}</Button></div>
        </Card>
      </div>
    </div>
  );
}
