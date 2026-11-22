"use client";
import { BookOpen, ClipboardList, FileSpreadsheet, FileText, HardHat, Layers } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Breadcrumb } from "@/components/opd/breadcrumb";
import { AppFrame, PageHead } from "@/components/opd/app-frame";

const SHELVES = [
  { icon: BookOpen, t: "Procedures and SOPs", d: "Field and office procedures, one current version each." },
  { icon: Layers, t: "Geology and exploration reports", d: "Programme reports, resource notes, drilling summaries per site." },
  { icon: FileSpreadsheet, t: "Production reports", d: "Monthly and annual summaries, reconciliations." },
  { icon: HardHat, t: "HSE", d: "Permits, inspection forms, incident learnings." },
  { icon: ClipboardList, t: "Templates and forms", d: "Excel import templates, report formats, checklists." },
  { icon: FileText, t: "Contracts and permits", d: "Restricted to head office roles." },
];

export const DocumentsView = () => (
  <AppFrame active="documents">{() => (
    <>
      <Breadcrumb className="mb-4" items={[{ label: "Home", href: "/portal/" }, { label: "Documents" }]} />
      <PageHead title="Documents" tag="Phase 5 · planned" lead="One place for site and head office documents, with access that follows your role and site. Nothing is public." />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {SHELVES.map(({ icon: Icon, t, d }) => (
          <Card key={t} className="gap-2 p-4" data-shelf={t}>
            <div className="flex items-center gap-2 text-sm font-semibold"><Icon className="size-4 text-brand" />{t}</div>
            <p className="text-sm text-muted-foreground">{d}</p>
            <span className="mt-auto text-xs text-muted-foreground">Empty until the document store is connected</span>
          </Card>
        ))}
      </div>
      <p className="mt-6 max-w-[62ch] text-xs text-muted-foreground">Files will live in private storage with per-folder access by role. Decision still open: which folders each site admin can manage.</p>
    </>
  )}</AppFrame>
);
