// Browser glue for the portal login: one supabase-js client per project, one access object in localStorage.
import { createClient } from "@supabase/supabase-js";
import { PROJECTS } from "./config.js";
import { signInAll, sessionKey, ACCESS_KEY, isConfigured } from "./auth-core.js";
import { readProfile } from "./profile.js";

const LEGACY_KEYS = ["exp_session", "exp_guest_site"];

export const makeClient = (p) => createClient(p.url, p.anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: sessionKey(p), detectSessionInUrl: false },
});

/** Sign in to every configured project in parallel. Saves the access object when at least one project accepts. */
export async function loginAll(email, password) {
  const access = await signInAll({ projects: PROJECTS, email: email.trim(), password, deps: { createClient: makeClient, readProfile } });
  if (access.ok) localStorage.setItem(ACCESS_KEY, JSON.stringify(access));
  return access;
}

export function loadAccess() {
  try { return JSON.parse(localStorage.getItem(ACCESS_KEY) || "null"); } catch { return null; }
}

/** Standalone-Exploration login that existed before the portal (phones signed in before the cutover, or guest mode). */
export function legacyExplo() {
  try {
    const s = JSON.parse(localStorage.getItem("exp_session") || "null");
    if (s?.site) return { site: s.site, guest: !!s.guest };
  } catch {}
  const g = localStorage.getItem("exp_guest_site");
  return g ? { site: g, guest: true } : null;
}

/** Sign out of every project. Scope "local" so other devices of the same person stay signed in. */
export async function logoutAll() {
  await Promise.all(PROJECTS.filter(isConfigured).map(async (p) => {
    try { await makeClient(p).auth.signOut({ scope: "local" }); } catch {}
  }));
  localStorage.removeItem(ACCESS_KEY);
  LEGACY_KEYS.forEach((k) => localStorage.removeItem(k));
}
