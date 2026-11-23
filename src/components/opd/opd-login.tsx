"use client";
import { useEffect, useState } from "react";
import { LogIn, Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/ui-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MaskedInput } from "@/components/ui/masked-input";
import { maskEmail } from "@/lib/opd/masks.js";
import { Strata, Contours } from "@/components/opd/strata";
import { SECTIONS } from "@/lib/opd/sitemap";
import { BrandMark } from "@/components/brand-mark";
import { Breadcrumb } from "@/components/opd/breadcrumb";
import { SitePicker } from "@/components/site-picker";
import { SITES } from "@/lib/core/config.js";
import { safeNext } from "@/lib/opd/auth-core.js";
import { loadAccess, loginAll } from "@/lib/opd/session.js";

export function OpdLogin() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(true);
  const [guestOpen, setGuestOpen] = useState(false);
  const [gsite, setGsite] = useState("");
  const { theme, toggle } = useTheme();
  const nextPath = () => safeNext(new URLSearchParams(location.search).get("next"), "/portal/");

  useEffect(() => {
    if (loadAccess()?.ok) { location.replace(nextPath()); return; }
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
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,34rem)_1fr]" data-login="opd">
      <div className="flex flex-col gap-6 px-5 pb-10 pt-[calc(var(--safe-t)+1.25rem)] sm:px-10">
        <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Sign in" }]} />
        <div className="mx-auto flex w-full max-w-[26rem] flex-1 flex-col justify-center gap-8 py-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <BrandMark className="size-11" />
              <div><h1 className="font-serif text-2xl font-medium leading-tight">One Portal Data</h1><p className="text-sm text-muted-foreground">PT Central Abadi Nusantara</p></div>
            </div>
            <p className="text-sm text-muted-foreground">Sign in once. The same email and password open every site and module you have an account for.</p>
          </div>

          <div className="flex flex-col gap-4">
            {!online && <div className="rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-sm text-warning">Offline. Sign-in needs internet, but exploration entry works without signing in.</div>}
            <form onSubmit={submit} className="flex flex-col gap-4" id="lf">
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1.5 text-sm font-medium"><span>Email</span>
                  <MaskedInput id="l-email" type="email" mask={maskEmail} autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} enterKeyHint="next" placeholder="name@company.com" required value={email} onValueChange={setEmail} /></label>
                <label className="flex flex-col gap-1.5 text-sm font-medium"><span>Password</span>
                  <Input id="l-pw" type="password" autoComplete="current-password" enterKeyHint="go" required value={pw} onChange={e => setPw(e.target.value)} /></label>
              </div>
              {msg && <div role="alert" className="rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-sm text-danger" id="l-msg">{msg}</div>}
              <Button type="submit" size="lg" className="w-full" disabled={busy || !online} id="l-go"><LogIn />{busy ? "Signing in…" : "Sign in"}</Button>
            </form>
          </div>

          <div className="flex flex-col gap-3 border-t pt-6">
            <Button type="button" variant="outline" className="h-auto min-h-9 w-full whitespace-normal py-2 text-center" id="l-guest" aria-expanded={guestOpen} aria-controls="guest-panel" onClick={() => setGuestOpen(o => !o)}>
              Enter data offline, without signing in
            </Button>
            {guestOpen && (
              <div id="guest-panel" className="flex flex-col gap-3 rounded-lg border bg-card p-4">
                <SitePicker name="guest-site" sites={Object.keys(SITES)} value={gsite} onChange={setGsite} connected={k => !!(SITES as Record<string, { url: string }>)[k].url}
                  legend="Which site is this data for?" hint="Pick it before you start. Records are saved on this phone and sent to this site after you sign in." />
                <Button type="button" size="lg" className="w-full" disabled={!gsite} id="l-guest-go"
                  onClick={() => { try { localStorage.setItem("exp_guest_site", gsite); localStorage.setItem("exp_last_site", gsite); } catch {} location.assign(`/explo/?site=${gsite}`); }}>
                  {gsite ? `Open data entry for ${gsite}` : "Pick a site to continue"}
                </Button>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">No account yet? Ask a super admin.</span>
            <Button type="button" variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">{theme === "dark" ? <Sun /> : <Moon />}</Button></div>
        </div>
      </div>

      <aside className="relative isolate hidden overflow-hidden bg-[var(--strata-1)] text-[#fff6ee] lg:flex lg:flex-col lg:justify-between lg:p-12" aria-label="What you can open after signing in">
        <Contours className="absolute -right-16 -top-10 -z-10 w-[40rem] !text-[#fff6ee]/15" />
        <Strata className="absolute inset-x-0 bottom-0 -z-10 h-56 w-full opacity-90" />
        <div className="max-w-[30rem]">
          <p className="text-xs font-semibold uppercase tracking-wider text-[#fdba74]">Portal</p>
          <h2 className="mt-3 font-serif text-4xl font-medium leading-tight">Every site and module, behind one door.</h2>
        </div>
        <ul className="relative z-[1] mb-24 grid max-w-[30rem] gap-2">
          {SECTIONS.filter(x => x.key !== "home" && x.key !== "help").map(x => { const I = x.icon; return (
            <li key={x.key} className="flex items-center gap-3 rounded-lg border border-white/15 bg-black/15 px-4 py-3 backdrop-blur-sm">
              <I className="size-5 text-[#fdba74]" aria-hidden /><span className="text-sm font-medium">{x.label}</span>
              <span className="ml-auto text-xs text-[#fff6ee]/70">{x.items.length - 1} {x.items.length === 2 ? "page" : "pages"}</span>
            </li>); })}
        </ul>
      </aside>
    </div>
  );
}
