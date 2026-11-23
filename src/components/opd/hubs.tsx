"use client";
import { Box, ShieldCheck, BookOpen, Calculator, ClipboardList, FileSpreadsheet, FileText, Layers, LayoutDashboard, Map, Smartphone, Truck, TrendingUp, Database } from "lucide-react";
import { GatedPage, HubLanding } from "@/components/opd/hub";

export const ProductionHub = () => (
  <HubLanding active="production" tag="Operations" title="Production" accent="Hub"
    lead="Check how each site is performing, send the daily report, and read how the numbers are built."
    inside={[{ label: "Sites with production", value: "WKM · BM · TMS" }, { label: "Head office view", value: "All sites" }, { label: "Daily upload", value: "Phase 4" }]}
    cards={[
      { icon: LayoutDashboard, title: "Dashboard", desc: "Output against plan, site by site and for head office.", href: "/production/dashboard/", needs: true },
      { icon: ClipboardList, title: "Uploads", desc: "Send the daily report. The file is checked before anything is saved.", href: "/production/data-inputs/", needs: true },
      { icon: BookOpen, title: "Guides", desc: "How to read the dashboard and fill in each form.", href: "/production/guidelines/", needs: true },
    ]}
    note="Production data is private. You sign in only when you open one of these pages." />
);

export const ExplorationHub = () => (
  <HubLanding active="explo" tag="Exploration" title="Exploration" accent="Hub"
    lead="Enter drilling data in the field with no signal, ask for datasets, and look at the project on a map."
    inside={[{ label: "Sites live", value: "WKM · CDSM" }, { label: "Field entry", value: "Works offline" }, { label: "Analysis", value: "Dashboard · QC · Map · 3D" }]}
    cards={[
      { icon: Smartphone, title: "Data Entry", desc: "Record collars, drilling progress, hours and samples. Works with no signal and installs on your phone.", href: "/explo/", badge: "Works offline" },
      { icon: LayoutDashboard, title: "Dashboard", desc: "Drilling progress, recovery and sampling for one site.", href: "/exploration/dashboard/", needs: true },
      { icon: ShieldCheck, title: "Data QC", desc: "Checks on collars, intervals and samples.", href: "/exploration/data-qc/", needs: true },
      { icon: Map, title: "Maps", desc: "Collars and project layers on one map.", href: "/exploration/maps/", needs: true },
      { icon: Box, title: "3D Hole", desc: "Drillholes and assay intervals in 3D.", href: "/exploration/3d-hole/", needs: true },
      { icon: Database, title: "Requests", desc: "Ask for a dataset, a map or supporting files.", href: "/exploration/request-data/", needs: true },
    ]} />
);

export const DocumentsHub = () => (
  <HubLanding active="documents" tag="Library" title="Documents" accent=""
    lead="Site and head office reports, procedures and templates. What you see depends on your account."
    inside={[{ label: "Collections", value: "Reports · SOPs · Templates" }, { label: "Access", value: "By role and site" }, { label: "Document store", value: "Phase 5" }]}
    cards={[
      { icon: FileText, title: "Reports", desc: "Monthly, quarterly and annual reports.", href: "/documents/reports/", needs: true },
      { icon: BookOpen, title: "SOPs", desc: "Procedures for field work, safety and data.", href: "/documents/sops/", needs: true },
      { icon: FileSpreadsheet, title: "Templates", desc: "Templates for data entry and reporting.", href: "/documents/templates/", needs: true },
    ]} />
);

export const ToolsHub = () => (
  <HubLanding active="tools" tag="Tools & Calculators" title="Mining" accent="Tools"
    lead="Calculators for coordinates, tonnage and the nickel HPM today, with drillhole and cost tools to follow. They run in your browser and need no sign-in."
    inside={[{ label: "Available now", value: "2 tools" }, { label: "Sign-in", value: "Not needed" }, { label: "Coming from the old portal", value: "3 tools" }]}
    cards={[
      { icon: Calculator, title: "Calculators", desc: "UTM and latitude/longitude, and volume to wet and dry tonnes.", href: "/tools/calculators/", badge: "Open" },
      { icon: TrendingUp, title: "HPM Nickel Calculator", desc: "Nickel benchmark price for saprolite and limonite, from the Kepmen ESDM 363/2026 formula.", href: "/tools/hpm-nickel/", badge: "Open" },
      { icon: Layers, title: "Drillhole Analysis", desc: "Grade statistics and interval summaries from collar and assay data." },
      { icon: Truck, title: "Hauling Cost Calculator", desc: "Cost per tonne for one haul route." },
      { icon: TrendingUp, title: "Revenue Projection", desc: "Revenue for different tonnage, grade and price cases." },
    ]}
    note="The three planned tools already exist in the old portal. They move across one at a time." />
);

const P = { label: "Production", href: "/production/" };
const E = { label: "Exploration", href: "/exploration/" };
const D = { label: "Documents", href: "/documents/" };
export const ProductionInputs = () => <GatedPage active="production" parent={P} need="production" title="Uploads" lead="Send the daily production report. Your browser reads the file and checks it before anything is saved." will={["Upload the WKM, BM or TMS daily report", "Preview with warnings and rejected rows", "Load into the site database, with undo"]} />;
export const ProductionGuidelines = () => <GatedPage active="production" parent={P} need="production" title="Guides" lead="How to read the dashboard and fill each form." will={["Dashboard guide, page by page", "Data input guide per form", "Definitions of each measure"]} />;
export const ExplorationRequest = () => <GatedPage active="explo" parent={E} need="exploration" title="Requests" lead="Ask for a dataset, a map or supporting files." will={["A request form with the dataset, site and purpose", "Status of your earlier requests", "Approval by the site admin"]} />;
export const DocumentsReports = () => <GatedPage active="documents" parent={D} need="any" title="Reports" lead="Monthly, quarterly and annual reports." will={["Reports by site and period", "Search by title", "Download for the sites you can access"]} />;
export const DocumentsSops = () => <GatedPage active="documents" parent={D} need="any" title="SOPs" lead="Procedures for field work, safety and data." will={["One current version of each procedure", "Version history", "Download for offline reading"]} />;
export const DocumentsTemplates = () => <GatedPage active="documents" parent={D} need="any" title="Templates" lead="Templates for data entry and reporting." will={["Excel import templates for Exploration", "Daily report formats", "Checklists"]} />;
