// One Portal Data: the 7 Supabase projects behind the single login (concept section 3.2).
// Anon (publishable) keys only. Never a service-role key or a password.
// A project with an empty url/anonKey is "unconfigured": the portal skips it and greys the module out.
import { SITES, HUB } from "../core/config.js";

const OP_PROFILE = { type: "op" };    // op_profile (production), shape confirmed when the SQL lands (Phase 4)
const EXP_PROFILE = { type: "exp" };  // exp_profile: full_name, role, is_active, input_forms
const DASH_MEMBER = { type: "dash" }; // dash.me() -> rows(email, role, sites[])

// Production projects (publishable/anon keys only; safe to ship in the browser, access is enforced by RLS).
const PROD = {
  "hub-prod": { url: "https://yjytejxfkpvttomrpwvt.supabase.co", anonKey: "sb_publishable_e_4CQQpdIczJX33ffcxK5Q_dLeKzSba" },
  "wkm-prod": { url: "https://wjwiyxlcbvwbfodxoczz.supabase.co", anonKey: "sb_publishable_UNNaz34HjKEMJfR0O9SANA_5eM5Uus0" },
  "bm-prod": { url: "https://ucotnmgvkmpfvmqeksxy.supabase.co", anonKey: "sb_publishable_kpU1eH6YlxuYYaZ-_-5ReA_lLUEdD3h" },
  "tms-prod": { url: "https://vsrnpmmwpvykaegwikap.supabase.co", anonKey: "sb_publishable_PyHMVhfDH68BOQArb0-wig_2J7YjW4p" },
};

const explo = (code) => ({
  id: `${code.toLowerCase()}-explo`, name: `${code} exploration`, scope: "site", site: code, module: "exploration",
  url: SITES[code]?.url || "", anonKey: SITES[code]?.anonKey || "", profile: EXP_PROFILE, storageKey: `sb-exp-${code}`,
});

export const PROJECTS = [
  { id: "hub-prod", name: "Hub (HO production)", scope: "ho", module: "production", profile: OP_PROFILE, ...PROD["hub-prod"] },
  { id: "hub-explo", name: "Explo Hub (HO exploration)", scope: "ho", module: "exploration", profile: DASH_MEMBER, url: HUB.url, anonKey: HUB.anon },
  { id: "wkm-prod", name: "WKM production", scope: "site", site: "WKM", module: "production", profile: OP_PROFILE, ...PROD["wkm-prod"] },
  { id: "bm-prod", name: "BM production", scope: "site", site: "BM", module: "production", profile: OP_PROFILE, ...PROD["bm-prod"] },
  { id: "tms-prod", name: "TMS production", scope: "site", site: "TMS", module: "production", profile: OP_PROFILE, ...PROD["tms-prod"] },
  explo("WKM"),
  explo("CDSM"),
];

export const exploProject = (code) => PROJECTS.find((p) => p.module === "exploration" && p.site === code);
