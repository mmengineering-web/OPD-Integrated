"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, Eye, EyeOff, Loader2, RefreshCw, Search, Trash2, UserPlus, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { MaskedInput } from "@/components/ui/masked-input";
import { FormGroup } from "@/components/ui/form-group";
import { Breadcrumb } from "@/components/opd/breadcrumb";
import { AppFrame, PageHead, type Access } from "@/components/opd/app-frame";
import { PROJECTS } from "@/lib/opd/config.js";
import { listAll, apiFor } from "@/lib/opd/admin-api.js";
import { ADMIN_ROLES, MIN_PASSWORD, buildMatrix, generatePassword, manageableProjects, personRole, planDeleteEverywhere, planUser, roleText, runPlan } from "@/lib/opd/admin-core.js";
import { maskEmail, maskName, passwordProgress } from "@/lib/opd/masks.js";
import { cn } from "@/lib/utils";

type Cell = { user_id: string; role: string | null; active: boolean; name: string | null };
type Person = { email: string; name: string | null; loose: boolean; cells: Record<string, Cell> };
type Listings = Record<string, { rows?: any[]; error?: string }>;
type Result = { step: { projectId: string; label: string; op: string }; status: "ok" | "failed" | "skipped"; message: string };

// Column order and grouping of the matrix (same as the old users-admin page).
const GROUPS: { label: string; ids: string[] }[] = [
  { label: "Exploration", ids: ["wkm-explo", "cdsm-explo"] },
  { label: "Production", ids: ["wkm-prod", "bm-prod", "tms-prod"] },
  { label: "Head office", ids: ["hub-prod", "hub-explo"] },
];
// Column index where each group starts, so a new site only needs an id in GROUPS (the separators follow).
const GROUP_START = new Set(GROUPS.reduce<number[]>((a, g, i) => [...a, i === 0 ? 0 : a[i - 1] + GROUPS[i - 1].ids.length], []));
const SHORT: Record<string, string> = { "wkm-explo": "WKM", "cdsm-explo": "CDSM", "wkm-prod": "WKM", "bm-prod": "BM", "tms-prod": "TMS", "hub-prod": "Prod hub", "hub-explo": "Explo hub" };
const ROLE_SHORT: Record<string, string> = { viewer: "Viewer", data_entry: "Data entry", site_admin: "Site admin", super_admin: "Super admin" };
/** Role colours. One calm hue (blue = trust) that gets stronger with authority; grey = read only. Green and red are kept for results, so a role never looks like "success" or "danger". */
const ROLE_TONE: Record<string, string> = {
  viewer: "border-border bg-muted text-muted-foreground",
  data_entry: "border-[var(--info-border)] bg-[var(--info-bg)] text-info",
  site_admin: "border-[var(--info)] bg-[var(--info-bg)] font-semibold text-info",
  super_admin: "border-transparent bg-[var(--info)] font-semibold text-[var(--background)]",
};
const ROLE_HELP: Record<string, string> = { viewer: "Can look, not change", data_entry: "Can enter data", site_admin: "Can enter data and edit master data", super_admin: "Can also manage users" };
const projectOf = (id: string) => PROJECTS.find((p: any) => p.id === id)!;

export function UsersAdminPage() {
  return (
    <AppFrame active="portal" gate="super_admin" backHref="/portal/" backLabel="Back to Portal">{access => (
      <>
        <Breadcrumb className="mb-4" items={[{ label: "Home", href: "/" }, { label: "Portal", href: "/portal/" }, { label: "Users" }]} />
        <PageHead title="Users" lead="Create a person once and give them access to the sites they work on. The same email and password are created in each project you tick." tag="Super admin" />
        <Admin access={access!} />
      </>
    )}</AppFrame>
  );
}

function Admin({ access }: { access: Access }) {
  const manageable = useMemo(() => manageableProjects(PROJECTS, access), [access]);
  const manageIds = useMemo(() => new Set(manageable.map((p: any) => p.id)), [manageable]);
  const [listings, setListings] = useState<Listings | null>(null);
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState<{ person: Person | null } | null>(null);
  const [del, setDel] = useState<Person | null>(null);

  const load = useCallback(async () => { setListings(null); setListings((await listAll(manageable)) as Listings); }, [manageable]);
  useEffect(() => { load(); }, [load]);

  const people: Person[] = useMemo(() => (listings ? buildMatrix(listings) : []), [listings]);
  const roleWords = (p: Person) => Object.values(p.cells).map(c => ROLE_SHORT[c.role || ""] || "").join(" ");
  const shown = people.filter(p => !q.trim() || `${p.name ?? ""} ${p.email} ${roleWords(p)}`.toLowerCase().includes(q.trim().toLowerCase()));
  const errors = listings ? Object.entries(listings).filter(([, l]) => l.error) : [];
  const ctx = (confirmRemove: boolean) => ({ projects: manageable, listings: listings || {}, me: access.email, confirmRemove });

  return (
    <div className="flex flex-col gap-4">
      {errors.length > 0 && (
        <div className="rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] p-3 text-sm" role="alert" data-list-errors>
          <div className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" aria-hidden />Some projects could not be read</div>
          <ul className="mt-1.5 flex flex-col gap-1 text-muted-foreground">
            {errors.map(([id, l]) => <li key={id} data-err={id}><span className="font-medium text-foreground">{projectOf(id).name}:</span> {l.error}</li>)}
          </ul>
        </div>
      )}
      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input id="u-search" type="search" className="px-9 [&::-webkit-search-cancel-button]:hidden" placeholder="Type a name, email or role" value={q} onChange={e => setQ(e.target.value)} aria-label="Search users" />
            {q && <button type="button" id="u-clear" className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setQ("")} aria-label="Clear search"><X className="size-4" aria-hidden /></button>}
          </div>
          <Button variant="outline" id="u-refresh" onClick={load} disabled={!listings}><RefreshCw className={cn("size-4", !listings && "animate-spin")} aria-hidden />Refresh list</Button>
          <Button id="u-add" onClick={() => setDialog({ person: null })} disabled={!listings}><UserPlus className="size-4" aria-hidden />Add user</Button>
        </div>
        <p className="text-xs text-muted-foreground"><span id="u-count">{listings ? (q.trim() ? `${shown.length} of ${people.length} people` : `${people.length} people`) : "Reading…"}</span> · You are super admin in {manageable.length} of {PROJECTS.length} projects. Greyed columns are projects you cannot manage.</p>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[56rem] border-collapse text-sm" id="u-table">
            <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
              <tr>
                <th rowSpan={2} className="px-3 py-2 font-medium">Person</th>
                {GROUPS.map(g => <th key={g.label} colSpan={g.ids.length} className="border-l px-3 py-1.5 text-center font-semibold">{g.label}</th>)}
                <th rowSpan={2} className="border-l px-3 py-2 text-right font-medium">Actions</th>
              </tr>
              <tr>{GROUPS.flatMap(g => g.ids).map((id, i) => <th key={id} className={cn("px-2 py-1.5 text-center font-medium", GROUP_START.has(i) && "border-l", !manageIds.has(id) && "opacity-50")} title={manageIds.has(id) ? projectOf(id).name : `${projectOf(id).name}: you are not super admin here`}>{SHORT[id]}</th>)}</tr>
            </thead>
            <tbody>
              {!listings && <tr><td colSpan={9} className="px-3 py-8 text-center text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" aria-hidden />Reading {manageable.length} projects…</td></tr>}
              {listings && shown.length === 0 && <tr><td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">{people.length ? "No one matches the search." : "No users found."}</td></tr>}
              {shown.map(p => (
                <tr key={p.email || p.name + Object.keys(p.cells)[0]} className="border-t hover:bg-muted/30" data-user={p.email || "(no email)"}>
                  <td className="px-3 py-2"><div className="font-medium">{p.name || p.email}</div><div className="text-xs text-muted-foreground">{p.email || "no email (old account)"}</div></td>
                  {GROUPS.flatMap(g => g.ids).map((id, i) => {
                    const c = p.cells[id];
                    return (
                      <td key={id} className={cn("px-2 py-2 text-center", GROUP_START.has(i) && "border-l", !manageIds.has(id) && "bg-muted/40")} data-cell={id}>
                        {c ? <span title={`${ROLE_HELP[c.role || ""] || "No role"}${c.active ? "" : " (account switched off)"}`} data-role={c.role || ""} className={cn("inline-block rounded-full border px-2 py-0.5 text-xs", ROLE_TONE[c.role || ""] || "bg-card", !c.active && "line-through opacity-60")}>{ROLE_SHORT[c.role || ""] || c.role || "no role"}</span> : <span className="text-muted-foreground/50" aria-label="no account">–</span>}
                      </td>
                    );
                  })}
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {!p.loose && <Button size="sm" variant="outline" data-manage aria-label={`Edit access for ${p.name || p.email}`} onClick={() => setDialog({ person: p })}>Edit access</Button>}{" "}
                    <Button size="sm" variant="ghost" data-delete onClick={() => setDel(p)} aria-label={`Delete ${p.name || p.email}`}><Trash2 className="size-4" aria-hidden /></Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {dialog && <UserDialog person={dialog.person} manageable={manageable} ctx={ctx} onClose={() => setDialog(null)} onDone={load} />}
      {del && <DeleteDialog person={del} ctx={ctx} manageable={manageable} onClose={() => setDel(null)} onDone={load} />}
    </div>
  );
}

function Modal({ title, onClose, children, id }: { title: string; onClose: () => void; children: React.ReactNode; id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", k);
    ref.current?.querySelector<HTMLElement>("input,select,button")?.focus();
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/40 p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id + "-t"} id={id} className="my-auto w-full max-w-[34rem] rounded-2xl border bg-card p-5 shadow-lg">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id={id + "-t"} className="font-serif text-xl font-medium">{title}</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="size-4" aria-hidden /></Button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Results({ results }: { results: Result[] }) {
  return (
    <ul className="flex flex-col gap-1.5 text-sm" id="m-result" aria-live="polite">
      {results.map((r, i) => (
        <li key={i} className="flex items-start gap-2" data-status={r.status} data-step={r.step.projectId + ":" + r.step.op}>
          {r.status === "ok" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> : r.status === "failed" ? <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
          <span><span className="font-medium">{r.step.label}</span>{r.status !== "ok" && <span className="block text-xs text-muted-foreground">{r.message}</span>}</span>
        </li>
      ))}
    </ul>
  );
}

function UserDialog({ person, manageable, ctx, onClose, onDone }: { person: Person | null; manageable: any[]; ctx: (c: boolean) => any; onClose: () => void; onDone: () => void }) {
  const editing = !!person;
  const [email, setEmail] = useState(person?.email || "");
  const [name, setName] = useState(person?.name || "");
  const [role, setRole] = useState<string>(person ? personRole(person) || "viewer" : "viewer");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set(person ? Object.keys(person.cells).filter(id => manageable.some(p => p.id === id)) : []));
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [shownPw, setShownPw] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const plan = useMemo(() => planUser({ person, want: { email, name, role, password, projects: sel }, ctx: ctx(confirmRemove) }), [person, email, name, role, password, sel, confirmRemove, ctx]);
  const pw = passwordProgress(password, MIN_PASSWORD);
  const removing = plan.steps.some((s: any) => s.op === "delete");
  const toggle = (id: string) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function apply() {
    setBusy(true); setResults(plan.steps.map((step: any) => ({ step, status: "skipped", message: "Waiting…" })));
    const res = await runPlan({ steps: plan.steps, projects: manageable, api: apiFor, onProgress: (r: Result[]) => setResults(r) });
    setResults(res); setBusy(false);
    if (password && res.some((r: Result) => r.status === "ok" && (r.step.op === "create" || r.step.op === "reset"))) setShownPw(password);
    setPassword(""); onDone();
  }
  async function copy() { try { await navigator.clipboard.writeText(shownPw || ""); setCopied(true); } catch { /* clipboard blocked: the password is selectable on screen */ } }
  const finished = !!results && !busy;
  const allOk = finished && results!.every(r => r.status === "ok");

  return (
    <Modal id="m-user" title={editing ? `Edit access: ${person!.name || person!.email}` : "Add user"} onClose={onClose}>
      {!finished ? (
        <form className="flex flex-col gap-6" onSubmit={e => { e.preventDefault(); if (!plan.errors.length && !busy) apply(); }}>
          <FormGroup legend="Person">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">Email
                <MaskedInput id="m-email" type="email" inputMode="email" mask={maskEmail} autoComplete="off" placeholder="name@company.com" value={email} readOnly={editing} onValueChange={setEmail} /></label>
              <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">Full name
                <MaskedInput id="m-name" mask={maskName} autoComplete="off" placeholder="e.g. Ana Lestari" value={name} onValueChange={setName} /></label>
            </div>
          </FormGroup>

          <FormGroup legend="Sign-in and role">
            <div className="grid gap-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
              <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">Role
                <Select id="m-role" value={role} onChange={e => setRole(e.target.value)}>{ADMIN_ROLES.map((r: any) => <option key={r.v} value={r.v}>{r.t}</option>)}</Select></label>
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="m-pw" className="text-sm font-medium">{editing ? "New password (optional)" : "Password"}</label>
                <span className="flex gap-1.5">
                  <Input id="m-pw" type={show ? "text" : "password"} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} placeholder={editing ? "Leave empty to keep it" : `At least ${MIN_PASSWORD} characters`} aria-describedby="m-pw-hint" />
                  <Button type="button" variant="outline" size="icon" onClick={() => setShow(v => !v)} aria-label={show ? "Hide password" : "Show password"}>{show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}</Button>
                </span>
                <span className="flex items-center justify-between gap-2" id="m-pw-hint">
                  <span className={cn("text-xs", pw.ok ? "text-success" : "text-muted-foreground")} aria-live="polite">{pw.n === 0 ? `${MIN_PASSWORD}+ characters` : pw.ok ? `${pw.n} characters, long enough` : `${pw.n} of ${MIN_PASSWORD}, ${pw.left} more`}</span>
                  <Button type="button" variant="ghost" size="sm" id="m-gen" onClick={() => { setPassword(generatePassword()); setShow(true); }}>Generate password</Button>
                </span>
              </div>
            </div>
          </FormGroup>

          <FormGroup legend="Access to projects" hint="Tick every project this person works in.">
            <div className="flex flex-col gap-1.5">
              {GROUPS.map(g => (
                <div key={g.label} className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="w-24 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</span>
                  {g.ids.map(id => {
                    const ok = manageable.some(p => p.id === id);
                    return (
                      <label key={id} className={cn("flex min-h-8 items-center gap-2 text-sm", !ok && "opacity-45")} title={ok ? projectOf(id).name : "You are not super admin in this project"}>
                        <input type="checkbox" data-proj={id} className="size-4 accent-[var(--brand)]" disabled={!ok} checked={sel.has(id)} onChange={() => toggle(id)} />{SHORT[id]}
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
          </FormGroup>

          <div className="flex flex-col gap-3">
            <div className="rounded-lg border bg-muted/40 p-3" id="m-plan" aria-live="polite">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">What will happen</div>
              {plan.steps.length > 0 && <ol className="list-decimal pl-5 text-sm">{plan.steps.map((s: any, i: number) => <li key={i} data-plan={s.projectId + ":" + s.op}>{s.label}</li>)}</ol>}
              {plan.errors.length > 0 && <ul className="mt-1 text-sm text-danger">{plan.errors.map((e: string) => <li key={e} data-plan-error>{e}</li>)}</ul>}
            </div>
            {(removing || (editing && plan.errors.some((e: string) => /confirmation/.test(e)))) && (
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" id="m-confirm" className="mt-0.5 size-4" checked={confirmRemove} onChange={e => setConfirmRemove(e.target.checked)} />I understand that removing an account deletes the login in that project and cannot be undone.</label>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" id="m-apply" disabled={busy || plan.errors.length > 0}>{busy && <Loader2 className="size-4 animate-spin" aria-hidden />}{editing ? "Save changes" : "Create user"}</Button>
            </div>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <p className={cn("text-sm font-medium", allOk ? "text-success" : "text-danger")} id="m-summary">{allOk ? "All steps finished." : "Some steps did not finish. Nothing was rolled back except a new account whose profile could not be saved."}</p>
          <Results results={results!} />
          {shownPw && (
            <div className="rounded-lg border border-[var(--info-border)] bg-[var(--info-bg)] p-3" id="m-pwbox">
              <div className="text-xs font-semibold uppercase tracking-wide text-info">Password for {email.trim()}</div>
              <div className="mt-1 flex items-center gap-2"><code className="select-all break-all rounded bg-card px-2 py-1 font-mono text-sm" id="m-pwtext">{shownPw}</code>
                <Button type="button" size="sm" variant="outline" id="m-copy" onClick={copy}><Copy className="size-4" aria-hidden />{copied ? "Copied" : "Copy password"}</Button></div>
              <p className="mt-2 text-xs text-muted-foreground">Shown once. It is not stored anywhere. Send it to the person through a safe channel.</p>
            </div>
          )}
          <div className="flex justify-end"><Button onClick={onClose} id="m-close">Done</Button></div>
        </div>
      )}
    </Modal>
  );
}

function DeleteDialog({ person, manageable, ctx, onClose, onDone }: { person: Person; manageable: any[]; ctx: (c: boolean) => any; onClose: () => void; onDone: () => void }) {
  const [ok, setOk] = useState(false), [busy, setBusy] = useState(false), [results, setResults] = useState<Result[] | null>(null);
  const plan = useMemo(() => planDeleteEverywhere({ person, ctx: ctx(ok) }), [person, ok, ctx]);
  async function run() { setBusy(true); const res = await runPlan({ steps: plan.steps, projects: manageable, api: apiFor, onProgress: (r: Result[]) => setResults(r) }); setResults(res); setBusy(false); onDone(); }
  const finished = !!results && !busy;
  return (
    <Modal id="m-delete" title={`Delete ${person.name || person.email} everywhere`} onClose={onClose}>
      {!finished ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border bg-muted/40 p-3 text-sm" id="d-plan">
            {plan.steps.length > 0 && <ol className="list-decimal pl-5">{plan.steps.map((s: any, i: number) => <li key={i}>{s.label}</li>)}</ol>}
            {plan.errors.filter((e: string) => !/confirmation/.test(e)).map((e: string) => <p key={e} className="text-danger" data-plan-error>{e}</p>)}
            {plan.steps.length === 0 && plan.errors.length === 0 && <p>Nothing to delete in the projects you manage.</p>}
          </div>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" id="d-confirm" className="mt-0.5 size-4" checked={ok} onChange={e => setOk(e.target.checked)} />I understand that this deletes the login in every project listed above and cannot be undone.</label>
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button variant="destructive" id="d-apply" disabled={busy || plan.errors.length > 0 || plan.steps.length === 0} onClick={run}>{busy && <Loader2 className="size-4 animate-spin" aria-hidden />}Delete everywhere</Button></div>
        </div>
      ) : (
        <div className="flex flex-col gap-3"><Results results={results!} /><div className="flex justify-end"><Button onClick={onClose} id="d-close">Done</Button></div></div>
      )}
    </Modal>
  );
}
