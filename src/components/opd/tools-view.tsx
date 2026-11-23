"use client";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { MaskedInput } from "@/components/ui/masked-input";
import { Field, FormGroup } from "@/components/ui/form-group";
import { Breadcrumb } from "@/components/opd/breadcrumb";
import { AppFrame, PageHead } from "@/components/opd/app-frame";
import { utmToLatLon, latLonToUtm, zoneOf } from "@/lib/core/utm.js";
import { maskDecimal, maskEasting, maskLat, maskLon, maskNorthing, maskPercent, maskZone } from "@/lib/opd/masks.js";

const num = (v: string) => (v.trim() === "" ? NaN : Number(v.replace(",", ".")));
const f = (n: number, d: number) => (Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }) : "–");
const Out = ({ label, value, id }: { label: string; value: string; id?: string }) => <div className="rounded-md border bg-muted/40 px-3 py-2"><div className="text-xs text-muted-foreground">{label}</div><div className="text-base font-semibold tabular-nums" id={id}>{value}</div></div>;
const maskVolume = (v: string) => maskDecimal(v, { int: 9, dec: 2 });
const maskDensity = (v: string) => maskDecimal(v, { int: 2, dec: 3 });

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
    <Card data-tool="utm" className="gap-5">
      <h2 className="text-base font-semibold">UTM and latitude/longitude (WGS84)</h2>
      <Field label="Convert"><Select value={dir} onChange={e => setDir(e.target.value as "u2l" | "l2u")} id="utm-dir"><option value="u2l">UTM to lat/lon</option><option value="l2u">Lat/lon to UTM</option></Select></Field>
      <FormGroup legend="Zone" hint={dir === "l2u" ? "Optional. Leave it empty to use the zone of the longitude." : "1 to 60. Indonesia is 46 to 54."}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Zone number"><MaskedInput mask={maskZone} inputMode="numeric" placeholder="e.g. 51" value={zone} onValueChange={setZone} id="utm-zone" /></Field>
          <Field label="Hemisphere"><Select value={hemi} onChange={e => setHemi(e.target.value)}><option value="S">South</option><option value="N">North</option></Select></Field>
        </div>
      </FormGroup>
      <FormGroup legend="Coordinates" hint={dir === "u2l" ? "In metres. A comma works as the decimal point." : "In decimal degrees. South and west are negative."}>
        <div className="grid gap-3 sm:grid-cols-2">
          {dir === "u2l"
            ? <>
                <Field label="Easting (m)"><MaskedInput mask={maskEasting} inputMode="decimal" placeholder="e.g. 412500.00" value={a} onValueChange={setA} id="utm-a" /></Field>
                <Field label="Northing (m)"><MaskedInput mask={maskNorthing} inputMode="decimal" placeholder="e.g. 9650000.00" value={b} onValueChange={setB} id="utm-b" /></Field>
              </>
            : <>
                <Field label="Latitude"><MaskedInput mask={maskLat} inputMode="decimal" placeholder="e.g. -3.512345" value={a} onValueChange={setA} id="utm-a" /></Field>
                <Field label="Longitude"><MaskedInput mask={maskLon} inputMode="decimal" placeholder="e.g. 122.123456" value={b} onValueChange={setB} id="utm-b" /></Field>
              </>}
        </div>
      </FormGroup>
      <div className="grid gap-3 sm:grid-cols-2" aria-live="polite">
        <Out label={r?.l1 ?? (dir === "u2l" ? "Latitude" : "Easting")} value={r?.v1 ?? "–"} id="utm-o1" />
        <Out label={r?.l2 ?? (dir === "u2l" ? "Longitude" : "Northing")} value={r?.v2 ?? "–"} id="utm-o2" />
      </div>
    </Card>
  );
}

function Tonnage() {
  const [vol, setVol] = useState(""), [den, setDen] = useState("1.6"), [moist, setMoist] = useState("30");
  const v = num(vol), d = num(den), m = num(moist);
  const ok = [v, d, m].every(Number.isFinite) && v >= 0 && d > 0 && m >= 0 && m < 100;
  const wet = ok ? v * d : NaN, dry = ok ? wet * (1 - m / 100) : NaN;
  return (
    <Card data-tool="tonnage" className="gap-5">
      <h2 className="text-base font-semibold">Volume to tonnes (wet and dry)</h2>
      <FormGroup legend="Material" hint="The density and moisture shown are placeholders. Use your site's measured values.">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Volume (bcm)"><MaskedInput mask={maskVolume} inputMode="decimal" placeholder="e.g. 1000" value={vol} onValueChange={setVol} id="t-vol" /></Field>
          <Field label="Wet density (t/m³)"><MaskedInput mask={maskDensity} inputMode="decimal" placeholder="e.g. 1.6" value={den} onValueChange={setDen} id="t-den" /></Field>
          <Field label="Moisture (%)"><MaskedInput mask={maskPercent} inputMode="decimal" placeholder="0 to 100" value={moist} onValueChange={setMoist} id="t-moist" /></Field>
        </div>
      </FormGroup>
      <div className="grid gap-3 sm:grid-cols-2" aria-live="polite"><Out label="Wet tonnes" value={f(wet, 1)} id="t-wet" /><Out label="Dry tonnes" value={f(dry, 1)} id="t-dry" /></div>
      <p className="text-xs text-muted-foreground">Dry t = wet t × (1 − moisture). Moisture is on a wet basis.</p>
    </Card>
  );
}

export const CalculatorsView = () => (
  <AppFrame active="tools">{() => (
    <>
      <Breadcrumb className="mb-4" items={[{ label: "Home", href: "/" }, { label: "Tools", href: "/tools/" }, { label: "Calculators" }]} />
      <PageHead title="Calculators" lead="Small calculators that run in your browser. Nothing you type is sent anywhere." />
      <div className="grid gap-4 lg:grid-cols-2"><Utm /><Tonnage /></div>
    </>
  )}</AppFrame>
);
