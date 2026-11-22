"use client";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Breadcrumb } from "@/components/opd/breadcrumb";
import { AppFrame, PageHead } from "@/components/opd/app-frame";
import { utmToLatLon, latLonToUtm, zoneOf } from "@/lib/core/utm.js";

const num = (v: string) => (v.trim() === "" ? NaN : Number(v.replace(",", ".")));
const f = (n: number, d: number) => (Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }) : "–");
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="flex flex-col gap-1.5 text-sm font-medium"><span>{label}</span>{children}</label>;
const Out = ({ label, value, id }: { label: string; value: string; id?: string }) => <div className="rounded-md border bg-muted/40 px-3 py-2"><div className="text-xs text-muted-foreground">{label}</div><div className="text-base font-semibold tabular-nums" id={id}>{value}</div></div>;

function Utm() {
  const [dir, setDir] = useState<"u2l" | "l2u">("u2l");
  const [a, setA] = useState(""), [b, setB] = useState(""), [zone, setZone] = useState("51"), [hemi, setHemi] = useState("S");
  const r = useMemo(() => {
    const x = num(a), y = num(b), z = Math.round(num(zone));
    if (![x, y].every(Number.isFinite)) return null;
    if (dir === "u2l") { if (!(z >= 1 && z <= 60)) return null; const p = utmToLatLon(x, y, z, hemi); return { l1: "Latitude", v1: f(p.lat, 6), l2: "Longitude", v2: f(p.lon, 6) }; }
    const zz = Number.isFinite(z) && z >= 1 && z <= 60 ? z : zoneOf(y);
    const p = latLonToUtm(x, y, zz, hemi); return { l1: `Easting (zone ${zz})`, v1: f(p.e, 1), l2: "Northing", v2: f(p.n, 1) };
  }, [a, b, zone, hemi, dir]);
  return (
    <Card data-tool="utm">
      <h2 className="text-base font-semibold">UTM and latitude/longitude (WGS84)</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Direction"><Select value={dir} onChange={e => setDir(e.target.value as "u2l" | "l2u")} id="utm-dir"><option value="u2l">UTM to lat/lon</option><option value="l2u">Lat/lon to UTM</option></Select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Zone"><Input inputMode="numeric" value={zone} onChange={e => setZone(e.target.value)} id="utm-zone" /></Field>
          <Field label="Hemisphere"><Select value={hemi} onChange={e => setHemi(e.target.value)}><option value="S">South</option><option value="N">North</option></Select></Field>
        </div>
        <Field label={dir === "u2l" ? "Easting (m)" : "Latitude"}><Input inputMode="decimal" value={a} onChange={e => setA(e.target.value)} id="utm-a" /></Field>
        <Field label={dir === "u2l" ? "Northing (m)" : "Longitude"}><Input inputMode="decimal" value={b} onChange={e => setB(e.target.value)} id="utm-b" /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Out label={r?.l1 ?? (dir === "u2l" ? "Latitude" : "Easting")} value={r?.v1 ?? "–"} id="utm-o1" />
        <Out label={r?.l2 ?? (dir === "u2l" ? "Longitude" : "Northing")} value={r?.v2 ?? "–"} id="utm-o2" />
      </div>
      {dir === "l2u" && <p className="text-xs text-muted-foreground">Leave the zone empty or invalid to use the zone of the longitude.</p>}
    </Card>
  );
}

function Tonnage() {
  const [vol, setVol] = useState(""), [den, setDen] = useState("1.6"), [moist, setMoist] = useState("30");
  const v = num(vol), d = num(den), m = num(moist);
  const ok = [v, d, m].every(Number.isFinite) && v >= 0 && d > 0 && m >= 0 && m < 100;
  const wet = ok ? v * d : NaN, dry = ok ? wet * (1 - m / 100) : NaN;
  return (
    <Card data-tool="tonnage">
      <h2 className="text-base font-semibold">Volume to tonnes (wet and dry)</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Volume (bcm)"><Input inputMode="decimal" value={vol} onChange={e => setVol(e.target.value)} id="t-vol" /></Field>
        <Field label="Wet density (t/m³)"><Input inputMode="decimal" value={den} onChange={e => setDen(e.target.value)} id="t-den" /></Field>
        <Field label="Moisture (% wet basis)"><Input inputMode="decimal" value={moist} onChange={e => setMoist(e.target.value)} id="t-moist" /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2"><Out label="Wet tonnes" value={f(wet, 1)} id="t-wet" /><Out label="Dry tonnes" value={f(dry, 1)} id="t-dry" /></div>
      <p className="text-xs text-muted-foreground">Dry t = wet t × (1 − moisture). The default density and moisture are placeholders; use your site's measured values.</p>
    </Card>
  );
}

export const ToolsView = () => (
  <AppFrame active="tools">{() => (
    <>
      <Breadcrumb className="mb-4" items={[{ label: "Home", href: "/portal/" }, { label: "Mining Tools" }]} />
      <PageHead title="Mining Tools" lead="Small calculators that run in your browser. Nothing you type is sent anywhere." />
      <div className="grid gap-4 lg:grid-cols-2"><Utm /><Tonnage /></div>
    </>
  )}</AppFrame>
);
