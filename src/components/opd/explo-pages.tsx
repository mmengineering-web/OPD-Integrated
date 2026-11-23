"use client";
import { ExploPage } from "@/components/opd/explo-page";
import { DashboardView } from "@/components/dashboard-view";
import { QcView } from "@/components/qc-view";
import { MapView } from "@/components/map-view";
import { Drill3dView } from "@/components/drill3d-view";

export const ExplorationDashboard = () => <ExploPage title="Dashboard" lead="Drilling progress, recovery and sampling for one site." render={info => <DashboardView info={info} />} />;
export const ExplorationDataQc = () => <ExploPage title="Data QC" lead="Checks on collars, intervals and samples before the data is used." render={info => <QcView info={info} />} />;
export const ExplorationMapsPage = () => <ExploPage title="Maps" lead="Collars, concession layers and overlays on one map." render={info => <MapView info={info} />} />;
export const ExplorationHole3d = () => <ExploPage title="3D Hole" lead="Drillholes and assay intervals in 3D." render={info => <Drill3dView info={info} />} />;
