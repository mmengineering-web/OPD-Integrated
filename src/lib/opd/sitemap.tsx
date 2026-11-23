import { Building2, BookOpen, Calculator, ClipboardList, Compass, Database, Box, FileSpreadsheet, FileText, Home, ShieldCheck, LayoutDashboard, LifeBuoy, Map, Pickaxe, Smartphone, TrendingUp, UserCog, Wrench } from "lucide-react";

export type NavKey = "home" | "portal" | "production" | "explo" | "documents" | "tools" | "help";
/** What a page needs: any account, a usable production or exploration project, the Hub production project, or super admin. */
export type Need = "any" | "production" | "exploration" | "ho-production" | "super_admin";
type Icon = React.ComponentType<{ className?: string }>;

/** `aka` holds the older or longer names of a page. Page search reads it, so shortening a label never makes the page harder to find. */
export type SiteItem = { label: string; href: string; icon: Icon; need?: Need; note?: string; aka?: string };
export type SiteSection = { key: NavKey; label: string; href: string; icon: Icon; items: SiteItem[]; aka?: string };

/**
 * The one list of pages in OPD. The top menu, the sidebar, the breadcrumbs and the tests all read it,
 * so a page is added here and nowhere else. `need` is what the page asks for; no `need` means public.
 */
export const SECTIONS: SiteSection[] = [
  { key: "home", label: "Home", href: "/", icon: Home, items: [] },
  { key: "portal", label: "Portal", href: "/portal/", icon: Building2, items: [
    { label: "Overview", href: "/portal/", icon: Building2 },
    { label: "Users", href: "/portal/admin/", icon: UserCog, need: "super_admin", aka: "user administration accounts people roles access" },
  ] },
  { key: "production", label: "Production", href: "/production/", icon: Pickaxe, items: [
    { label: "Overview", href: "/production/", icon: Pickaxe },
    { label: "Dashboard", href: "/production/dashboard/", icon: LayoutDashboard, need: "ho-production", note: "All sites" },
    { label: "Uploads", href: "/production/data-inputs/", icon: ClipboardList, need: "production", aka: "data inputs daily report send" },
    { label: "Guides", href: "/production/guidelines/", icon: BookOpen, need: "production", aka: "guidelines help how to" },
  ] },
  { key: "explo", label: "Exploration", href: "/exploration/", icon: Compass, items: [
    { label: "Overview", href: "/exploration/", icon: Compass },
    { label: "Data Entry", href: "/explo/", icon: Smartphone, aka: "field data entry offline collar progress hours sample" },
    { label: "Dashboard", href: "/exploration/dashboard/", icon: LayoutDashboard, need: "exploration" },
    { label: "Data QC", href: "/exploration/data-qc/", icon: ShieldCheck, need: "exploration" },
    { label: "Maps", href: "/exploration/maps/", icon: Map, need: "exploration", aka: "interactive maps collars layers" },
    { label: "3D Hole", href: "/exploration/3d-hole/", icon: Box, need: "exploration" },
    { label: "Requests", href: "/exploration/request-data/", icon: Database, need: "exploration", aka: "request data dataset" },
  ] },
  { key: "documents", label: "Documents", href: "/documents/", icon: FileText, items: [
    { label: "Overview", href: "/documents/", icon: FileText },
    { label: "Reports", href: "/documents/reports/", icon: FileText, need: "any" },
    { label: "SOPs", href: "/documents/sops/", icon: BookOpen, need: "any" },
    { label: "Templates", href: "/documents/templates/", icon: FileSpreadsheet, need: "any" },
  ] },
  { key: "tools", label: "Tools", href: "/tools/", icon: Wrench, aka: "mining tools calculators", items: [
    { label: "Overview", href: "/tools/", icon: Wrench },
    { label: "Calculators", href: "/tools/calculators/", icon: Calculator, aka: "utm coordinates latitude longitude tonnage volume" },
    { label: "HPM Nickel", href: "/tools/hpm-nickel/", icon: TrendingUp, aka: "price hma kepmen saprolite limonite" },
  ] },
  { key: "help", label: "Help", href: "/help/", icon: LifeBuoy, items: [] },
];

/** The six top-level pages, in menu order. */
export const NAV = SECTIONS.filter(s => s.key !== "portal").map(s => ({ key: s.key, label: s.label, href: s.href }));

const norm = (p: string) => (p.endsWith("/") ? p : p + "/");

/** The section that owns a path, so the sidebar opens the right group. */
export function sectionOf(pathname: string): NavKey | null {
  const p = norm(pathname);
  for (const s of SECTIONS) if (s.items.some(i => norm(i.href) === p)) return s.key;
  return SECTIONS.find(s => s.href !== "/" && p.startsWith(s.href))?.key ?? (p === "/" ? "home" : null);
}
export const isHere = (href: string, pathname: string) => norm(href) === norm(pathname);
