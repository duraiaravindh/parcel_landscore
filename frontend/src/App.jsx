/* App.jsx — Texas Counties as main vector basemap + compact UI with overlays + deep attributes */

import React, { useEffect, useRef, useState, useCallback } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";

import * as turf from "@turf/turf";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

/* --------- configuration / env --------- */
let REACT_APP_API_BASE = "";
let REACT_APP_TILE_BASE = "";

// CRA-style env (if present)
try {
  if (typeof process !== "undefined" && process?.env) {
    REACT_APP_API_BASE = process.env.REACT_APP_API_BASE || "";
    REACT_APP_TILE_BASE = process.env.REACT_APP_TILE_BASE || "";
  }
} catch {}

// Vite-style env (correct check: typeof import.meta, NOT typeof import)
try {
  if (typeof import.meta !== "undefined" && import.meta?.env) {
    REACT_APP_API_BASE =
      REACT_APP_API_BASE ||
      import.meta.env.VITE_API_BASE ||
      import.meta.env.REACT_APP_API_BASE ||
      "";
    REACT_APP_TILE_BASE =
      REACT_APP_TILE_BASE ||
      import.meta.env.VITE_TILE_BASE ||
      import.meta.env.REACT_APP_TILE_BASE ||
      "";
  }
} catch {}

const API_BASE =
  REACT_APP_API_BASE ||
  (typeof window !== "undefined" && window.location?.hostname === "localhost"
    ? "http://localhost:3000"
    : "");

const TILE_BASE =
  REACT_APP_TILE_BASE ||
  (typeof window !== "undefined" && window.location?.hostname === "localhost"
    ? "http://localhost:8081"
    : "");

/* 👉 use Texas counties as the main vector dataset */
const VECTOR_DATASET = "Texas_Counties_Baselayer";

/* --------- fallback data (only used if vector source fails) --------- */
const SAMPLE_PARCELS_GEOJSON = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {
        parcel_id: "P-100",
        prop_id: "PROP-100",
        owner: "Alice",
        market_value: 125000,
        master_id: "00000000-0000-0000-0000-000000000100"
      },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-97.75, 30.27],
            [-97.745, 30.27],
            [-97.745, 30.274],
            [-97.75, 30.274],
            [-97.75, 30.27]
          ]
        ]
      }
    }
  ]
};

const drawStylesForMapLibre = [
  { id: "gl-draw-polygon-fill-inactive", type: "fill", filter: ["all", ["==", "active", "false"], ["==", "$type", "Polygon"]], paint: { "fill-color": "#3bb2d0", "fill-outline-color": "#3bb2d0", "fill-opacity": 0.08 } },
  { id: "gl-draw-polygon-stroke-inactive", type: "line", filter: ["all", ["==", "active", "false"], ["==", "$type", "Polygon"]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#3bb2d0", "line-width": 2 } },
  { id: "gl-draw-polygon-fill-active", type: "fill", filter: ["all", ["==", "active", "true"], ["==", "$type", "Polygon"]], paint: { "fill-color": "#f59e0b", "fill-outline-color": "#f59e0b", "fill-opacity": 0.18 } },
  { id: "gl-draw-polygon-stroke-active", type: "line", filter: ["all", ["==", "active", "true"], ["==", "$type", "Polygon"]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#d97706", "line-width": 2.5 } },
  { id: "gl-draw-line-inactive", type: "line", filter: ["all", ["==", "active", "false"], ["==", "$type", "LineString"]], paint: { "line-color": "#3bb2d0", "line-width": 2 } },
  { id: "gl-draw-point-inactive", type: "circle", filter: ["all", ["==", "active", "false"], ["==", "$type", "Point"]], paint: { "circle-radius": 5, "circle-color": "#fff" } },
  { id: "gl-draw-point-active", type: "circle", filter: ["all", ["==", "active", "true"], ["==", "$type", "Point"]], paint: { "circle-radius": 7, "circle-color": "#f59e0b" } }
];

/* helpers */
async function safeFetch(url, opts) {
  try {
    const res = await fetch(url, opts);
    const ct = res.headers.get("content-type") || "";
    const isJson = ct.includes("application/json");
    if (!res.ok) {
      let body = null;
      try { body = isJson ? await res.json() : await res.text(); } catch { body = null; }
      return { __error: true, status: res.status, statusText: res.statusText, body };
    }
    return isJson ? await res.json() : null;
  } catch (err) {
    return { __error: true, status: 0, statusText: err.message, body: null };
  }
}

function featureToBBox(feature) {
  if (!feature) return null;
  const geom = feature.geometry || feature.geojson;
  if (!geom) return null;
  const [minX, minY, maxX, maxY] = turf.bbox({ type: "Feature", geometry: geom, properties: {} });
  return [[minX, minY], [maxX, maxY]];
}

/* correctly read fields map from TileJSON */
function pickIdPropertyNameFromLayerMeta(tj) {
  if (!tj) return "master_id";
  const candidates = ["master_id", "MASTER_ID", "masterId", "id", "gid", "fid", "parcel_id", "parcelId", "COUNTY_ID"];
  const first = Array.isArray(tj?.vector_layers) && tj.vector_layers[0];
  if (first && first.fields && typeof first.fields === "object") {
    const names = Object.keys(first.fields);
    for (const c of candidates) if (names.includes(c)) return c;
  }
  if (Array.isArray(tj?.__possible_props)) {
    for (const c of candidates) if (tj.__possible_props.includes(c)) return c;
  }
  return "master_id";
}
function getSourceLayerFromTilejson(tj, fallback) {
  if (!tj) return fallback;
  if (Array.isArray(tj.vector_layers) && tj.vector_layers.length) return tj.vector_layers[0].id || fallback;
  return fallback;
}

/* ---------- UI ---------- */
function Spinner({ text = "Loading map..." }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none">
      <div className="bg-slate-900/80 p-4 rounded-2xl flex items-center gap-3 shadow-2xl text-white">
        <svg className="animate-spin h-6 w-6" viewBox="0 0 24 24">
          <circle className="opacity-30" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none"/>
          <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
        </svg>
        <div className="text-sm font-medium">{text}</div>
      </div>
    </div>
  );
}

function Navbar({ status, onMenuToggle, menuOpen }) {
  return (
    <header className="absolute top-4 left-4 right-4 z-50 flex items-center justify-between">
      <div className="flex items-center gap-3 px-4 py-2 rounded-2xl bg-white/90 shadow-lg backdrop-blur">
        <div className="text-2xl">🗺️</div>
        <div>
          <div className="font-semibold text-slate-900">Parcel Viewer</div>
          <div className="text-xs text-slate-500 -mt-0.5">Texas counties as basemap</div>
        </div>
      </div>
      <div className="hidden sm:flex items-center gap-2 px-3 py-2 rounded-lg bg-white/90 shadow text-xs">
        <span className="text-slate-700">{status}</span>
      </div>
      <button onClick={onMenuToggle} title="Toggle controls" className="px-3 py-2 rounded-lg bg-white/90 shadow hover:scale-105 transition-transform">
        {menuOpen ? "✕ Close" : "☰ Controls"}
      </button>
    </header>
  );
}

function DetailRow({ label, value, highlight }) {
  return (
    <div className={`flex justify-between py-2 ${highlight ? 'bg-emerald-50 px-2 rounded' : ''}`}>
      <span className="text-slate-600 text-sm">{label}</span>
      <span className={`text-slate-900 text-sm ${highlight ? 'font-semibold' : ''}`}>{value}</span>
    </div>
  );
}

/* Collapsible overlays panel */
function ControlPanel({
  visible,
  searchText,
  setSearchText,
  onSearch,
  setBasemap,
  clearSelection,
  overlays,
  toggleOverlay,
  setOverlayOpacity,
  onExportCSV,
  onExportPDF,
  onStartDraw,
  onClearDrawings
}) {
  const [overlaysOpen, setOverlaysOpen] = useState(false);
  if (!visible) return null;

  return (
    <div className="absolute left-6 top-24 z-50 w-[360px] max-w-[92vw] space-y-3">
      {/* Search + quick actions */}
      <div className="bg-white/95 rounded-2xl p-4 shadow-xl border border-slate-100 backdrop-blur">
        <div className="flex items-center gap-3">
          <input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSearch()}
            placeholder="Search parcel / county id"
            className="flex-1 px-4 py-2 rounded-full border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-400 text-sm"
            aria-label="Search"
          />
          <button onClick={onSearch} className="px-4 py-2 rounded-full bg-indigo-600 text-white font-semibold shadow hover:opacity-95">Search</button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button onClick={() => setBasemap("osm")} className="px-3 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 text-sm shadow-sm">🗺 Streets</button>
          <button onClick={() => setBasemap("sat")} className="px-3 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 text-sm shadow-sm">🛰 Satellite</button>
          <button onClick={clearSelection} className="col-span-2 px-3 py-2 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 text-sm shadow-sm">Clear Selection</button>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button onClick={onStartDraw} className="flex-1 px-3 py-2 rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 text-sm font-semibold shadow hover:scale-105">
            ✏️ Draw Polygon
          </button>
          <button onClick={onClearDrawings} className="px-3 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold shadow hover:opacity-95">
            🗑 Delete
          </button>
        </div>
      </div>

      {/* Overlays — collapsible */}
      <div className="bg-white/95 rounded-2xl p-4 shadow-xl border border-slate-100 backdrop-blur">
        <button onClick={() => setOverlaysOpen(o => !o)} className="w-full flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-700">Overlay Layers</div>
            <div className="text-xs text-slate-500">Toggle & adjust opacity</div>
          </div>
          <span className="text-slate-500 text-base">{overlaysOpen ? "▴" : "▾"}</span>
        </button>

        {overlaysOpen && (
          <div className="mt-3 space-y-3 max-h-72 overflow-auto pr-1">
            {overlays.map(o => (
              <div key={o.id} className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl border border-slate-100 shadow-inner" style={{ backgroundColor: o.color }} />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={o.enabled} onChange={() => toggleOverlay(o.id)} className="w-4 h-4 text-indigo-600" />
                      <div className="text-sm font-medium text-slate-800">{o.title}</div>
                    </label>
                    <div className="text-xs text-slate-500">{Math.round(o.opacity * 100)}%</div>
                  </div>
                  <input
                    type="range" min="0" max="1" step="0.05" value={o.opacity}
                    onChange={(e) => setOverlayOpacity(o.id, parseFloat(e.target.value))}
                    className="w-full mt-2" disabled={!o.enabled}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Export */}
      <div className="bg-gradient-to-r from-white/90 to-white/60 rounded-2xl p-3 shadow-xl border border-slate-100 backdrop-blur flex items-center gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-700">Export</div>
          <div className="text-xs text-slate-500">Download selected parcel details</div>
        </div>
        <div className="ml-auto flex gap-2">
          <button onClick={onExportCSV} className="px-3 py-2 bg-indigo-600 text-white rounded-lg shadow text-sm font-semibold">Export CSV</button>
          <button onClick={onExportPDF} className="px-3 py-2 bg-indigo-500 text-white rounded-lg shadow text-sm font-semibold">Export PDF</button>
        </div>
      </div>
    </div>
  );
}

function Sidebar({ visible, parcelInfo, overlayInfo, onClose, onGenerateReport }) {
  if (!visible) return null;
  return (
    <aside className="absolute right-6 top-24 z-50 w-96 max-w-[94vw] bg-white/95 rounded-2xl shadow-2xl border border-slate-100 backdrop-blur p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Parcel Details</h3>
          <div className="text-xs text-slate-500 mt-1">Deep attributes & active overlays</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-700 rounded p-1">✕</button>
      </div>

      <div className="mt-4 overflow-auto max-h-[60vh] pr-2">
        {parcelInfo ? (
          <>
            {/* ID + address */}
            <div className="p-3 rounded-lg bg-gradient-to-r from-white to-emerald-50 border border-emerald-100">
              <div className="text-xs text-slate-600 uppercase tracking-wide">Parcel</div>
              <div className="text-xl font-semibold text-slate-900">
                {parcelInfo.prop_id || parcelInfo.master_id || "N/A"}
              </div>
              <div className="text-sm text-slate-500 mt-1">
                {[
                  parcelInfo.situs_street_num,
                  parcelInfo.situs_street_name || parcelInfo.address,
                  parcelInfo.city,
                  parcelInfo.zip
                ].filter(Boolean).join(", ")}
              </div>
              {parcelInfo.geo_id && (
                <div className="text-[11px] text-slate-500 mt-1">Geo ID: {parcelInfo.geo_id}</div>
              )}
            </div>

            {/* quick stats */}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <DetailRow label="Market Value" value={`$${Number(parcelInfo.market_value ?? 0).toLocaleString()}`} highlight />
              <DetailRow label="Assessed (All)" value={parcelInfo.assessed_val != null ? `$${Number(parcelInfo.assessed_val).toLocaleString()}` : "—"} />
              <DetailRow label="Curr Land Value" value={parcelInfo.curr_land_val != null ? `$${Number(parcelInfo.curr_land_val).toLocaleString()}` : "—"} />
              <DetailRow label="Curr Imprv Value" value={parcelInfo.curr_imprv_val != null ? `$${Number(parcelInfo.curr_imprv_val).toLocaleString()}` : "—"} />
              <DetailRow label="Area (acres)" value={parcelInfo.area_acres != null ? Number(parcelInfo.area_acres).toFixed(2) : "—"} />
              <DetailRow label="Land Acres" value={parcelInfo.land_acres != null ? Number(parcelInfo.land_acres).toFixed(2) : "—"} />
            </div>

            {/* property & legal */}
            <div className="mt-4 space-y-2">
              <div className="text-sm font-semibold text-slate-700">Property & Legal</div>
              <DetailRow label="Property Type" value={parcelInfo.prop_type_cd || "—"} />
              <DetailRow label="Legal Desc" value={parcelInfo.legal_desc || "—"} />
              <DetailRow label="Legal Loc Desc" value={parcelInfo.legal_loc_desc || "—"} />
              <DetailRow label="Legal Acreage" value={parcelInfo.legal_acreage != null ? Number(parcelInfo.legal_acreage).toFixed(2) : "—"} />
              <DetailRow label="Block" value={parcelInfo.block || "—"} />
              <DetailRow label="Tract/Lot" value={parcelInfo.tract_or_lot || "—"} />
            </div>

            {/* Land segments table with extra columns */}
            {Array.isArray(parcelInfo.land_segments_list) && parcelInfo.land_segments_list.length > 0 && (
              <div className="mt-4">
                <div className="text-sm font-semibold text-slate-700 mb-2">Land Segments</div>
                <div className="text-xs border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="p-2 text-left">Type</th>
                        <th className="p-2 text-right">Acres</th>
                        <th className="p-2 text-right">Area Factor</th>
                        <th className="p-2 text-right">Seg Market Val</th>
                        <th className="p-2 text-right">Year</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parcelInfo.land_segments_list.map((s, i) => (
                        <tr key={i} className="border-t">
                          <td className="p-2">{s.land_type_desc || s.land_type_cd || "-"}</td>
                          <td className="p-2 text-right">{Number(s.size_acres ?? 0).toFixed(2)}</td>
                          <td className="p-2 text-right">{s.land_area_factor ?? "-"}</td>
                          <td className="p-2 text-right">${Number(s.land_seg_mkt_val ?? 0).toLocaleString()}</td>
                          <td className="p-2 text-right">{s.prop_val_yr ?? "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Improvements table with prop_num */}
            {Array.isArray(parcelInfo.improvements_list) && parcelInfo.improvements_list.length > 0 && (
              <div className="mt-4">
                <div className="text-sm font-semibold text-slate-700 mb-2">Improvements</div>
                <div className="text-xs border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="p-2 text-left">Type</th>
                        <th className="p-2 text-right">Year</th>
                        <th className="p-2 text-right">Area</th>
                        <th className="p-2 text-right">Value</th>
                        <th className="p-2 text-right">Prop Num</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parcelInfo.improvements_list.map((it, i) => (
                        <tr key={i} className="border-t">
                          <td className="p-2">{it.imprv_type_desc || "-"}</td>
                          <td className="p-2 text-right">{it.yr_built ?? "-"}</td>
                          <td className="p-2 text-right">{Number(it.imprv_det_area ?? 0).toLocaleString()}</td>
                          <td className="p-2 text-right">${Number(it.imprv_val ?? 0).toLocaleString()}</td>
                          <td className="p-2 text-right">{it.prop_num ?? "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {parcelInfo.__notFound && (
              <div className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                No matching record in the database for this ID.
              </div>
            )}

            {overlayInfo && overlayInfo.length > 0 && (
              <div className="mt-4 pt-4 border-t border-slate-100">
                <h4 className="text-sm font-semibold mb-2 text-slate-700">Active Overlays</h4>
                <div className="space-y-2">
                  {overlayInfo.map((ov, idx) => (
                    <div key={idx} className="p-2 bg-slate-50 rounded text-sm">
                      <div className="font-medium text-slate-700">{ov.layer}</div>
                      <div className="text-xs text-slate-600 mt-1">
                        {Object.entries(ov.props || {}).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(" • ")}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4 flex justify-end">
              <button
                onClick={() => typeof onGenerateReport === "function" && onGenerateReport()}
                className="px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-semibold shadow hover:scale-105"
              >
                📊 Generate Report
              </button>
            </div>
          </>
        ) : (
          <div className="text-center py-12 text-slate-500">
            <div className="text-5xl mb-2">🗺️</div>
            <div className="text-sm">Click or search for a parcel to view details here</div>
          </div>
        )}
      </div>
    </aside>
  );
}

function ReportModal({ visible, parcelInfo, onClose, onDownload }) {
  if (!visible) return null;
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[9999]">
      <div className="bg-white/95 rounded-2xl shadow-2xl border border-slate-200 p-6 w-[520px] max-w-[95vw]">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-slate-900">📄 Parcel Report</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-700 px-2 py-1 rounded hover:bg-slate-100">✕</button>
        </div>

        {parcelInfo ? (
          <div className="space-y-3 text-sm text-slate-700">
            <div className="p-3 bg-slate-50 rounded-lg">
              <div className="font-semibold text-slate-900">
                Parcel ID: <span className="font-normal">{parcelInfo.parcel_id || parcelInfo.master_id}</span>
              </div>
              <div className="mt-1">Property ID: {parcelInfo.prop_id || "N/A"}</div>
              <div>Owner: {parcelInfo.owner || "N/A"}</div>
              <div>Market Value: ${Number(parcelInfo.market_value ?? 0).toLocaleString()}</div>
              <div>Land Use: {parcelInfo.land_type_ || "N/A"}</div>
              <div>Address: {parcelInfo.address || "N/A"}</div>
            </div>
            <div className="text-xs text-slate-500 italic">Generated dynamically from the latest parcel data.</div>
          </div>
        ) : (
          <div className="text-center py-10 text-slate-500">
            <div className="text-5xl mb-2">🗺️</div>
            <div>No parcel data available for report.</div>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button onClick={onDownload} className="px-4 py-2 rounded-lg bg-green-600 text-white font-semibold hover:bg-green-700">⬇️ Download Report</button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-200 text-slate-800 font-medium hover:bg-slate-300">Close</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Enter Gate ---------- */
function EnterGate({ onEnter }) {
  const [remember, setRemember] = React.useState(true); // default on

  return (
    <div className="w-full h-screen bg-slate-900 text-white flex items-center justify-center">
      <div className="max-w-lg w-[92vw] bg-white/10 backdrop-blur border border-white/15 rounded-2xl p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="text-3xl">🗺️</div>
          <div>
            <div className="text-xl font-bold">Parcel Viewer</div>
            <div className="text-sm text-slate-200">Texas Counties — Demo</div>
          </div>
        </div>

        <p className="mt-4 text-slate-200 text-sm leading-relaxed">
          Explore parcels, overlays and detailed property attributes. Click <b>Enter</b> to continue.
        </p>

        <label className="mt-4 flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Remember me (skip this page next time)
        </label>

        <div className="mt-5 flex gap-2">
          <button
            onClick={() => onEnter(remember)}
            className="px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-600 font-semibold"
          >
            Enter
          </button>
          <a
            href="https://austintexas.gov/" target="_blank" rel="noreferrer"
            className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15"
          >
            Learn more
          </a>
        </div>
      </div>
    </div>
  );
}

/* ======================= Main App ======================= */
const ENTER_KEY = "pv-entered-v1";

export default function App() {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const popupRef = useRef(null);
  const drawRef = useRef(null);
  const selectedFeatureRef = useRef(null);
  const parcelInfoRef = useRef(null);
  const overlaysRef = useRef([]);
  const lastFetchedIdRef = useRef(null); // duplicate-click guard

  /* -------- Enter-gate state -------- */
  const [entered, setEntered] = useState(() => {
    try {
      return localStorage.getItem(ENTER_KEY) === "1";
    } catch {
      return false;
    }
  });
  const handleEnter = (remember) => {
    if (remember) {
      try { localStorage.setItem(ENTER_KEY, "1"); } catch {}
    }
    setEntered(true);
  };

  /* -------- overlays / UI state -------- */
  const initialOverlays = [
    { id: "build_insp",               title: "Building Inspections",      tileset: "build_insp",               sourceLayer: "build_insp",               enabled: false, opacity: 0.4,  color: "#FF9800" },
    { id: "envi_insp",                title: "Environmental Inspections", tileset: "envi_insp",                sourceLayer: "envi_insp",                enabled: false, opacity: 0.4,  color: "#4CAF50" },
    { id: "board_adjustment_review",  title: "Board Adjustment Review",   tileset: "board_adjustment_review",  sourceLayer: "board_adjustment_review",  enabled: false, opacity: 0.35, color: "#673AB7" },
    { id: "communityRegistry",        title: "Community Registry",        tileset: "communityRegistry",        sourceLayer: "communityRegistry",        enabled: false, opacity: 0.35, color: "#3F51B5" },
    { id: "roadnetwork",              title: "Road Network",              tileset: "roadnetwork",              sourceLayer: "roadnetwork",              enabled: false, opacity: 0.35, color: "#795548" },
    { id: "demographicData",          title: "Demographic Data",          tileset: "demographicData",          sourceLayer: "demographicData",          enabled: false, opacity: 0.35, color: "#E91E63" }
  ];

  const [overlays, setOverlays] = useState(initialOverlays);
  useEffect(() => { overlaysRef.current = overlays; }, [overlays]);

  const [status, setStatus] = useState("Initializing map...");
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(true);

  const [parcelInfo, setParcelInfo] = useState(null);
  const [overlayInfo, setOverlayInfo] = useState(null);
  const [searchText, setSearchText] = useState("");
  const [reportVisible, setReportVisible] = useState(false);
  const [fetching, setFetching] = useState(false); // spinner while fetching

  useEffect(() => { parcelInfoRef.current = parcelInfo; }, [parcelInfo]);

  const clearHighlight = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      const sel = selectedFeatureRef.current;
      if (sel && sel.source && typeof sel.id !== "undefined") {
        const payload = { source: sel.source, id: sel.id };
        if (sel.sourceLayer) payload.sourceLayer = sel.sourceLayer;
        map.setFeatureState(payload, { selected: false });
      }
    } catch {}
    try { map.getSource("highlight-source")?.setData({ type: "FeatureCollection", features: [] }); } catch {}
    selectedFeatureRef.current = null;
  }, []);

  const setBasemap = useCallback((mode) => {
    const map = mapRef.current;
    if (!map) return;
    try {
      map.setLayoutProperty("osm-basemap", "visibility", mode === "osm" ? "visible" : "none");
      map.setLayoutProperty("satellite-basemap", "visibility", mode === "sat" ? "visible" : "none");
    } catch (err) { console.debug("setBasemap failed", err); }
  }, []);

  const toggleOverlay = useCallback((id) => {
    setOverlays(prev => prev.map(o => o.id === id ? { ...o, enabled: !o.enabled } : o));
    const map = mapRef.current;
    if (!map) return;
    try {
      const fillLayer = `${id}-fill`;
      const lineLayer = `${id}-line`;
      const currFillVis = map.getLayer(fillLayer) ? map.getLayoutProperty(fillLayer, "visibility") : null;
      const nextVis = currFillVis === "visible" ? "none" : "visible";
      if (map.getLayer(fillLayer)) map.setLayoutProperty(fillLayer, "visibility", nextVis);
      if (map.getLayer(lineLayer)) map.setLayoutProperty(lineLayer, "visibility", nextVis);
    } catch (err) {
      console.debug("toggle overlay failed", id, err);
    }
  }, []);

  const setOverlayOpacity = useCallback((id, opacity) => {
    setOverlays(prev => prev.map(o => o.id === id ? { ...o, opacity } : o));
    const map = mapRef.current;
    if (!map) return;
    try {
      const fillLayer = `${id}-fill`;
      if (map.getLayer(fillLayer)) map.setPaintProperty(fillLayer, "fill-opacity", opacity);
    } catch (err) {
      console.debug("set overlay opacity failed", id, err);
    }
  }, []);

  const clearSelection = useCallback(() => {
    setParcelInfo(null);
    setOverlayInfo(null);
    try { popupRef.current?.remove(); } catch {}
    popupRef.current = null;
    clearHighlight();
    setSidebarOpen(false);
    setStatus("Selection cleared");
  }, [clearHighlight]);

  const exportCSV = useCallback(() => {
    const info = parcelInfoRef.current;
    if (!info) return alert("No parcel selected to export.");

    const rows = [["Field","Value"], ...Object.entries(info)
      .filter(([k]) => !k.endsWith("_list"))
      .map(([k,v]) => [k, String(v ?? "")])];

    (info.land_segments_list || []).forEach((s,i)=>{
      rows.push([`land[${i}].type`, s.land_type_desc || s.land_type_cd || ""]);
      rows.push([`land[${i}].acres`, s.size_acres ?? ""]);
      rows.push([`land[${i}].value`, s.land_val ?? ""]);
      rows.push([`land[${i}].year`, s.prop_val_yr ?? ""]);
    });
    (info.improvements_list || []).forEach((it,i)=>{
      rows.push([`impr[${i}].type`, it.imprv_type_desc || ""]);
      rows.push([`impr[${i}].year`, it.yr_built ?? ""]);
      rows.push([`impr[${i}].area`, it.imprv_det_area ?? ""]);
      rows.push([`impr[${i}].value`, it.imprv_val ?? ""]);
    });

    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `parcel_${info.master_id ?? info.parcel_id ?? Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const exportPDF = useCallback(async () => {
    const info = parcelInfoRef.current;
    if (!info) return alert("No parcel selected to export.");

    const money = (n) => Number(n ?? 0).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
    const num = (n, d=2) => Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
    const now = new Date(), stamp = now.toLocaleString();

    // build styled HTML
    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.left = "-99999px";
    host.innerHTML = `
      <div class="report">
        <style>
          *{box-sizing:border-box}
          .report{width:794px;padding:28px;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:#0f172a;background:#fff}
          .hdr{display:flex;align-items:center;justify-content:space-between;background:linear-gradient(135deg,#1e3a8a,#4f46e5);color:#fff;border-radius:16px;padding:16px 18px;box-shadow:0 6px 24px rgba(15,23,42,.18)}
          .title{font-weight:800;font-size:20px}
          .badge{font-size:12px;padding:6px 10px;border-radius:999px;background:rgba(255,255,255,.22)}
          .mt-6{margin-top:24px}.mt-8{margin-top:32px}
          .grid{display:grid;gap:12px;grid-template-columns:repeat(3,1fr)}
          .card{border:1px solid #e2e8f0;background:#fbfbfb;border-radius:12px;padding:12px 14px}
          .k{font-size:12px;color:#64748b}.v{font-size:16px;font-weight:800;color:#0b1020}
          .section-title{font-size:14px;font-weight:800;color:#334155;letter-spacing:.2px;margin-bottom:8px}
          table{width:100%;border-collapse:collapse;font-size:12px;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden}
          thead{background:#f1f5f9}th,td{padding:10px 12px;text-align:left}th{font-weight:800;color:#334155}
          tbody tr{border-top:1px solid #e5e7eb}tbody tr:nth-child(odd){background:#fafafa}
          td.num{text-align:right;font-variant-numeric:tabular-nums}
          .subtle{color:#475569}
          .footer{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#64748b;margin-top:20px;border-top:1px solid #e5e7eb;padding-top:10px}
          .pill{display:inline-block;padding:4px 8px;border-radius:999px;background:#eef2ff;color:#3730a3;font-weight:700;font-size:11px}
        </style>

        <div class="hdr">
          <div class="title">Parcel Report</div>
          <div class="badge">Generated ${stamp}</div>
        </div>

        <div class="mt-6">
          <div class="subtle">Selected Parcel</div>
          <div style="font-size:22px;font-weight:800;margin-top:4px;">
            ${info.prop_id ?? info.master_id ?? "N/A"}
          </div>
          <div class="subtle" style="margin-top:4px;">
            ${
              [
                info.situs_street_num,
                info.situs_street_name || info.address,
                info.city,
                info.zip
              ].filter(Boolean).join(", ") || "Address: N/A"
            }
          </div>
        </div>

        <!-- Summary -->
        <div class="grid mt-6">
          <div class="card"><div class="k">Property ID</div><div class="v">${info.prop_id ?? "N/A"}</div></div>
          <div class="card"><div class="k">Market Value</div><div class="v">${money(info.market_value)}</div></div>
          <div class="card"><div class="k">Area (acres)</div><div class="v">${num(info.area_acres)}</div></div>
          <div class="card"><div class="k">Curr Land Value</div><div class="v">${info.curr_land_val!=null?money(info.curr_land_val):"—"}</div></div>
          <div class="card"><div class="k">Curr Imprv Value</div><div class="v">${info.curr_imprv_val!=null?money(info.curr_imprv_val):"—"}</div></div>
          <div class="card"><div class="k">Assessed (Current)</div><div class="v">${info.curr_assessed_val!=null?money(info.curr_assessed_val):"—"}</div></div>
        </div>

        <!-- Property & Legal -->
        <div class="mt-8">
          <div class="section-title">Property & Legal</div>
          <div class="grid">
            <div class="card"><div class="k">Property Type</div><div class="v">${info.prop_type_cd ?? "—"}</div></div>
            <div class="card"><div class="k">Geo ID</div><div class="v">${info.geo_id ?? "—"}</div></div>
            <div class="card"><div class="k">Block</div><div class="v">${info.block ?? "—"}</div></div>
            <div class="card"><div class="k">Tract/Lot</div><div class="v">${info.tract_or_lot ?? "—"}</div></div>
            <div class="card"><div class="k">Legal Acreage</div><div class="v">${info.legal_acreage!=null?num(info.legal_acreage):"—"}</div></div>
            <div class="card"><div class="k">Land Acres</div><div class="v">${info.land_acres!=null?num(info.land_acres):"—"}</div></div>
          </div>
          <div class="card mt-6"><div class="k">Legal Description</div><div class="v" style="font-weight:600;font-size:14px">${info.legal_desc ?? "—"}</div></div>
          <div class="card mt-2"><div class="k">Legal Location</div><div class="v" style="font-weight:600;font-size:14px">${info.legal_loc_desc ?? "—"}</div></div>
        </div>

        <!-- Valuation (extra) -->
        <div class="mt-8">
          <div class="section-title">Valuation (All)</div>
          <div class="grid">
            <div class="card"><div class="k">Market (All)</div><div class="v">${info.market_val!=null?money(info.market_val):"—"}</div></div>
            <div class="card"><div class="k">Assessed (All)</div><div class="v">${info.assessed_val!=null?money(info.assessed_val):"—"}</div></div>
          </div>
        </div>

        <!-- Land Segments -->
        ${
          Array.isArray(info.land_segments_list) && info.land_segments_list.length
            ? `
              <div class="mt-8">
                <div class="section-title">Land Segments</div>
                <table>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th class="num">Acres</th>
                      <th class="num">Area Factor</th>
                      <th class="num">Seg Market Val</th>
                      <th class="num">Year</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${info.land_segments_list.map(s => `
                      <tr>
                        <td>${s.land_type_desc || s.land_type_cd || "-"}</td>
                        <td class="num">${num(s.size_acres)}</td>
                        <td class="num">${s.land_area_factor ?? "—"}</td>
                        <td class="num">${money(s.land_seg_mkt_val)}</td>
                        <td class="num">${s.prop_val_yr ?? "—"}</td>
                      </tr>
                    `).join("")}
                  </tbody>
                </table>
              </div>
            `
            : `<div class="mt-8 subtle">No land segment records.</div>`
        }

        <!-- Improvements -->
        ${
          Array.isArray(info.improvements_list) && info.improvements_list.length
            ? `
              <div class="mt-8">
                <div class="section-title">Improvements</div>
                <table>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th class="num">Year</th>
                      <th class="num">Area</th>
                      <th class="num">Value</th>
                      <th class="num">Prop Num</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${info.improvements_list.map(it => `
                      <tr>
                        <td>${it.imprv_type_desc || "-"}</td>
                        <td class="num">${it.yr_built ?? "—"}</td>
                        <td class="num">${Number(it.imprv_det_area ?? 0).toLocaleString()}</td>
                        <td class="num">${money(it.imprv_val)}</td>
                        <td class="num">${it.prop_num ?? "—"}</td>
                      </tr>
                    `).join("")}
                  </tbody>
                </table>
              </div>
            `
            : `<div class="mt-8 subtle">No improvement records.</div>`
        }

        <div class="footer">
          <div>© ${now.getFullYear()} Parcel Viewer</div>
          <div class="pill">Auto-generated</div>
        </div>
      </div>
    `;

    document.body.appendChild(host);

    try {
      const el = host.querySelector(".report");
      const canvas = await html2canvas(el, { scale: 2, useCORS: true, backgroundColor: "#ffffff" });

      const a4w = 794, a4h = 1123;
      const pdf = new jsPDF({ unit: "px", format: [a4w, a4h] });

      const imgW = a4w;
      const imgH = canvas.height * (imgW / canvas.width);

      if (imgH <= a4h) {
        pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, imgW, imgH);
      } else {
        // naive multipage
        const pageCanvas = document.createElement("canvas");
        const ctx = pageCanvas.getContext("2d");
        pageCanvas.width = canvas.width;
        pageCanvas.height = Math.floor((a4h / imgW) * canvas.width);

        let y = 0;
        let first = true;
        while (y < canvas.height) {
          ctx.clearRect(0, 0, pageCanvas.width, pageCanvas.height);
          ctx.drawImage(canvas, 0, -y, canvas.width, canvas.height);
          const pageData = pageCanvas.toDataURL("image/png");
          if (first) {
            pdf.addImage(pageData, "PNG", 0, 0, imgW, a4h);
            first = false;
          } else {
            pdf.addPage([a4w, a4h]);
            pdf.addImage(pageData, "PNG", 0, 0, imgW, a4h);
          }
          y += pageCanvas.height;
        }
      }

      const name = `parcel_${info.master_id ?? info.prop_id ?? Date.now()}.pdf`;
      pdf.save(name);
    } catch (err) {
      console.error("PDF export failed", err);
      alert("Failed to export PDF.");
    } finally {
      document.body.removeChild(host);
    }
  }, []);

  const startDrawPolygon = useCallback(() => {
    try {
      const draw = drawRef.current;
      const mapLocal = mapRef.current;
      if (!draw || !mapLocal) return;
      draw.changeMode('draw_polygon');
      setStatus('Draw: polygon tool active — click map to draw');
      setSidebarOpen(false);
    } catch (err) { console.debug('startDrawPolygon failed', err); }
  }, []);

  const clearDrawings = useCallback(() => {
    try {
      const draw = drawRef.current;
      if (!draw) return;
      draw.deleteAll();
      draw.changeMode('simple_select');
      setStatus('Draw cleared');
    } catch (err) { console.debug('clearDrawings failed', err); }
  }, []);

  const handleSearch = useCallback(async () => {
    const text = (searchText || "").trim();
    if (!text) { setStatus("Enter parcel id"); return; }
    setStatus("Searching...");

    try {
      const base = API_BASE || "";
      const data = await safeFetch(`${base}/api/parcels/${encodeURIComponent(text)}`).catch(() => null);
      if (data && data.details) {
        setParcelInfo(data.details);
        setSidebarOpen(true);
        setStatus("Parcel found (server)");
        // keep selection in URL
        const url = new URL(window.location.href); url.searchParams.set("id", data.details.master_id); window.history.replaceState({}, "", url.toString());
        return;
      }
    } catch {}

    try {
      const map = mapRef.current;
      if (!map?.getLayer("parcels-fill")) throw new Error("parcels layer missing");
      const rendered = map.queryRenderedFeatures({ layers: ['parcels-fill'] }) || [];
      const searchLower = text.toLowerCase();
      const found = rendered.find(f => {
        const p = f.properties || {};
        const checks = [
          String(p.master_id || p.MASTER_ID || p.masterId || "").toLowerCase(),
          String(p.prop_id || p.Prop_Id || p.propId || "").toLowerCase(),
          String(p.parcel_id || p.parcelId || "").toLowerCase()
        ];
        return checks.includes(searchLower);
      });
      if (found) {
        const bbox = featureToBBox(found);
        if (bbox) map.fitBounds(bbox, { padding: 80, duration: 700 });
        setParcelInfo(found.properties || null); setSidebarOpen(true); setStatus("Parcel found (rendered)"); return;
      }
    } catch {}

    setStatus("Parcel not found");
    setTimeout(() => setStatus("Ready"), 1400);
  }, [searchText]);

  /* ---------- map init (guarded by `entered` and container existence) ---------- */
  useEffect(() => {
    // don't init until user has passed the Enter Gate
    if (!entered) return;
    // don't recreate if map already exists
    if (mapRef.current) return;

    const container = containerRef.current;
    if (!container) return;

    const raf = requestAnimationFrame(() => {
      try {
        const map = new maplibregl.Map({
          container, // HTMLElement guaranteed now
          style: {
            version: 8,
            glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
            sources: {
              osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256 },
              satellite: { type: "raster", tiles: ["https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256 }
            },
            layers: [
              { id: "osm-basemap", type: "raster", source: "osm" },
              { id: "satellite-basemap", type: "raster", source: "satellite", layout: { visibility: "none" } }
            ]
          },
          center: [-99.5, 31.25],
          zoom: 8.5,
          preserveDrawingBuffer: true
        });

        mapRef.current = map;
        setLoading(true);
        setStatus("Loading map...");

        const fetchTileJSON = async (baseUrl, name) => {
          if (!baseUrl) return null;
          const url = `${baseUrl.replace(/\/$/, "")}/data/${name}.json`;
          try { return await safeFetch(url).catch(() => null); } catch { return null; }
        };

        map.on('load', async () => {
          try {
            setStatus("Map loaded — preparing data...");
            let parcelsSourceLayer = VECTOR_DATASET;
            let parcelsTiles = [];
            let idProp = "master_id";
            let usedVector = false;

            if (TILE_BASE) {
              const tj = await fetchTileJSON(TILE_BASE, VECTOR_DATASET);
              if (tj && Array.isArray(tj.bounds) && tj.bounds.length === 4) {
                // tj.bounds = [west, south, east, north]
                const [[w,s],[e,n]] = [[tj.bounds[0], tj.bounds[1]], [tj.bounds[2], tj.bounds[3]]];
                try { map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 0 }); } catch {}
              }
              if (tj && !tj.__error) {
                parcelsSourceLayer = getSourceLayerFromTilejson(tj, VECTOR_DATASET);
                parcelsTiles = Array.isArray(tj.tiles) && tj.tiles.length ? tj.tiles :
                  [`${TILE_BASE.replace(/\/$/, "")}/data/${VECTOR_DATASET}/{z}/{x}/{y}.pbf`];
                idProp = pickIdPropertyNameFromLayerMeta(tj) || "master_id";
                usedVector = true;
              } else {
                parcelsTiles = [`${TILE_BASE.replace(/\/$/, "")}/data/${VECTOR_DATASET}/{z}/{x}/{y}.pbf`];
                parcelsSourceLayer = VECTOR_DATASET;
                usedVector = true;
              }
            }

            // Add main vector source (Texas counties as "parcels")
            try {
              if (usedVector && parcelsTiles.length) {
                const sourceOpts = { type: "vector", tiles: parcelsTiles, maxzoom: 14 };
                // promoteId must be on SOURCE for vector tiles
                if (idProp && parcelsSourceLayer) {
                  sourceOpts.promoteId = { [parcelsSourceLayer]: idProp };
                }
                if (!map.getSource("parcels")) map.addSource("parcels", sourceOpts);
              } else {
                if (!map.getSource("parcels")) map.addSource("parcels", { type: "geojson", data: SAMPLE_PARCELS_GEOJSON });
                parcelsSourceLayer = undefined;
              }

              if (!map.getLayer("parcels-fill")) {
                const layer = {
                  id: "parcels-fill",
                  type: "fill",
                  source: "parcels",
                  paint: {
                    "fill-color": ["case", ["boolean", ["feature-state", "selected"], false], "#2563eb", "#cbd5e1"],
                    "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.75, 0.55]
                  }
                };
                if (parcelsSourceLayer) layer["source-layer"] = parcelsSourceLayer;
                map.addLayer(layer);
              }
              if (!map.getLayer("parcels-outline")) {
                const outline = {
                  id: "parcels-outline",
                  type: "line",
                  source: "parcels",
                  paint: { "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#1e3a8a", "#64748b"], "line-width": 1 }
                };
                if (parcelsSourceLayer) outline["source-layer"] = parcelsSourceLayer;
                map.addLayer(outline);
              }
            } catch (err) {
              console.warn("Adding parcels source/layers failed:", err);
              setStatus("Warning: basemap unavailable");
            }

            // highlight ephemeral source (for non-promoted features)
            try {
              if (!map.getSource("highlight-source")) map.addSource("highlight-source", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
              if (!map.getLayer("highlight-fill")) map.addLayer({ id: "highlight-fill", type: "fill", source: "highlight-source", paint: { "fill-color": "#3b82f6", "fill-opacity": 0.25 } });
              if (!map.getLayer("highlight-line")) map.addLayer({ id: "highlight-line", type: "line", source: "highlight-source", paint: { "line-color": "#1e40af", "line-width": 2 } });
            } catch {}

            // Overlays
            (overlaysRef.current || []).forEach((ov) => {
              const ovName = ov.id;
              const ovTiles = [`${TILE_BASE.replace(/\/$/, "")}/data/${ovName}/{z}/{x}/{y}.pbf`];
              const ovSourceLayer = ovName;
              try {
                if (!map.getSource(ovName)) map.addSource(ovName, { type: "vector", tiles: ovTiles, maxzoom: 14 });
                if (!map.getLayer(`${ovName}-fill`)) {
                  map.addLayer({
                    id: `${ovName}-fill`,
                    type: "fill",
                    source: ovName,
                    "source-layer": ovSourceLayer,
                    paint: { "fill-color": ov.color || "#0088ff", "fill-opacity": ov.opacity },
                    layout: { visibility: ov.enabled ? "visible" : "none" }
                  });
                }
                if (!map.getLayer(`${ovName}-line`)) {
                  map.addLayer({
                    id: `${ovName}-line`,
                    type: "line",
                    source: ovName,
                    "source-layer": ovSourceLayer,
                    paint: { "line-color": "#222", "line-width": 1 },
                    layout: { visibility: ov.enabled ? "visible" : "none" }
                  });
                }
              } catch (err) {
                console.debug("Overlay add failed:", ovName, err);
              }
            });

            // Mapbox Draw
            try {
              const draw = new MapboxDraw({ displayControlsDefault: false, controls: { polygon: true, trash: true }, styles: drawStylesForMapLibre });
              if (!drawRef.current) {
                map.addControl(draw, 'top-left');
                drawRef.current = draw;
                try { map.getContainer().querySelector('.mapbox-gl-draw').style.display = 'none'; } catch {}
                map.on('draw.create', handleDrawCreateOrUpdate);
                map.on('draw.update', handleDrawCreateOrUpdate);
                map.on('draw.delete', () => {
                  setStatus("Draw cleared");
                  setParcelInfo(null);
                  setSidebarOpen(false);
                });
              }
            } catch {}

            setLoading(false);
            setStatus("Ready");

            // Deep-link load (?id=...)
            try {
              const idFromUrl = new URL(window.location.href).searchParams.get("id");
              if (idFromUrl) {
                const base = API_BASE || "";
                setFetching(true);
                const resp = await safeFetch(`${base}/api/details/${encodeURIComponent(idFromUrl)}`);
                setFetching(false);
                if (resp && resp.details) {
                  setParcelInfo(resp.details);
                  setStatus("Loaded from link");
                  // Try to restore a previously cached bbox (from a prior click)
                  try {
                    const cached = localStorage.getItem(`bbox:${idFromUrl}`);
                    if (cached) {
                      const bb = JSON.parse(cached);
                      if (Array.isArray(bb) && Array.isArray(bb[0]) && Array.isArray(bb[1])) {
                        map.fitBounds(bb, { padding: 60, duration: 400 });
                      }
                    }
                  } catch {}
                } else {
                  // no match; ensure panel is closed
                  setSidebarOpen(false);
                }
              } else {
                // If there is no deep-link id, ensure panel is closed on fresh load
                setSidebarOpen(false);
              }
            } catch {}
          } catch (err) {
            console.error("Error during map load flow:", err);
            setStatus("Map load error");
            setLoading(false);
          }
        });

        // Click handler
        map.on('click', async (e) => {
          try {
            const mapLocal = mapRef.current;
            if (!mapLocal?.getLayer("parcels-fill")) { clearSelection(); return; }

            const feats = mapLocal.queryRenderedFeatures(e.point, { layers: ['parcels-fill'] }) || [];
            if (!feats.length) { clearSelection(); return; }

            clearHighlight();

            const f = feats[0];
            const props = f.properties || {};
            const featureSourceLayer = (f.layer && (f.layer["source-layer"] || f.layer.sourceLayer)) || undefined;
            const fid = (typeof f.id !== "undefined")
              ? f.id
              : (props.master_id || props.MASTER_ID || props.masterId || props.id || props.__id);

            // fit to parcel bbox (nice UX) + remember bbox for deep link restore
            try {
              const bbox = featureToBBox(f);
              if (bbox) {
                mapLocal.fitBounds(bbox, { padding: 60, duration: 500 });
                const masterIdForCache = props.master_id || props.MASTER_ID || props.masterId || String(f.id || "");
                if (masterIdForCache) {
                  localStorage.setItem(`bbox:${masterIdForCache}`, JSON.stringify(bbox));
                }
              }
            } catch {}

            try {
              if (typeof fid !== "undefined" && mapLocal.getSource("parcels")) {
                const payload = { source: "parcels", id: fid };
                if (featureSourceLayer) payload.sourceLayer = featureSourceLayer;
                mapLocal.setFeatureState(payload, { selected: true });
                selectedFeatureRef.current = { source: "parcels", sourceLayer: featureSourceLayer, id: fid };
              } else {
                mapLocal.getSource("highlight-source")?.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: f.geometry || null }] });
                selectedFeatureRef.current = { ephemeral: true };
              }
            } catch {
              selectedFeatureRef.current = { ephemeral: true };
            }

            try { popupRef.current?.remove(); } catch {}
            popupRef.current = new maplibregl.Popup({ closeOnClick: true, offset: 15 })
              .setLngLat(e.lngLat)
              .setHTML(`<div style="min-width:200px;font-family:system-ui;"><div style="font-weight:600;margin-bottom:6px">Feature</div><div style="font-size:13px;color:#334155">${props.parcel_id || props.master_id || props.MASTER_ID || props.COUNTY || "N/A"}</div></div>`)
              .addTo(mapLocal);

            const masterId = props.master_id || props.MASTER_ID || props.masterId || (typeof f.id !== "undefined" ? String(f.id) : null);
            if (!masterId) { setParcelInfo({ master_id: "N/A", __notFound: true }); setSidebarOpen(true); return; }

            // duplicate-click guard
            if (lastFetchedIdRef.current === masterId) { setSidebarOpen(true); return; }
            lastFetchedIdRef.current = masterId;

            // keep selection in URL
            const url = new URL(window.location.href); url.searchParams.set("id", masterId); window.history.replaceState({}, "", url.toString());

            // fetch details
            const base = API_BASE || "";
            setFetching(true);
            const resp = await safeFetch(`${base}/api/details/${encodeURIComponent(masterId)}`);
            setFetching(false);
            if (resp && resp.details) {
              setParcelInfo(resp.details);
            } else {
              setParcelInfo({ master_id: masterId, __notFound: true });
            }
            setSidebarOpen(true);
            setStatus("Parcel details loaded");

            // overlay hits at click point
            const visibleOverlays = (overlaysRef.current || []).filter(o => o.enabled).map(o => `${o.id}-fill`);
            const overlayFeats = [];
            for (const layerId of visibleOverlays) {
              try {
                if (!mapLocal.getLayer(layerId)) continue;
                const of = mapLocal.queryRenderedFeatures(e.point, { layers: [layerId] }) || [];
                of.forEach(o_f => overlayFeats.push({ layer: layerId.replace(/-fill$/, ""), props: o_f.properties || {} }));
              } catch {}
            }
            setOverlayInfo(overlayFeats.length ? overlayFeats : null);
          } catch (err) {
            console.debug("map click handler error", err);
          }
        });

        map.on('mousemove', (e) => {
          try {
            const mapLocal = mapRef.current;
            if (!mapLocal?.getLayer("parcels-fill")) { mapLocal.getCanvas().style.cursor = ""; return; }
            const features = mapLocal.queryRenderedFeatures(e.point, { layers: ["parcels-fill"] }) || [];
            mapLocal.getCanvas().style.cursor = features.length ? "pointer" : "";
          } catch {}
        });

        map.on('error', () => setStatus("Map error"));

        // cleanup
        return () => {
          try { popupRef.current?.remove(); } catch {}
          try {
            if (drawRef.current && mapRef.current) { try { mapRef.current.removeControl(drawRef.current); } catch {} drawRef.current = null; }
          } catch {}
          try { map.remove(); } catch {}
          mapRef.current = null;
        };

        /* draw handler */
        async function handleDrawCreateOrUpdate(e) {
          try {
            const mapLocal = mapRef.current;
            if (!mapLocal?.getLayer("parcels-fill")) {
              setStatus("Draw: layer not ready");
              return;
            }
            const feats = e.features || [];
            if (!feats.length) return;
            const poly = feats[0];
            let rendered = [];
            try { rendered = mapLocal.queryRenderedFeatures({ layers: ['parcels-fill'] }) || []; } catch { rendered = []; }
            const selected = [];
            for (const rf of rendered) {
              try {
                if (turf.booleanIntersects(poly, rf)) selected.push({ master_id: rf.properties?.master_id || rf.properties?.parcel_id, properties: rf.properties });
                else {
                  const centroid = turf.centroid(rf);
                  if (turf.booleanPointInPolygon(centroid, poly)) selected.push({ master_id: rf.properties?.master_id || rf.properties?.parcel_id, properties: rf.properties });
                }
              } catch {}
            }
            setStatus(`${selected.length} features selected`);
            if (selected.length) { setParcelInfo(selected[0].properties); setSidebarOpen(true); } else { setParcelInfo(null); setSidebarOpen(true); }
          } catch (err) {
            console.debug("draw handler error", err);
          }
        }
      } catch (err) {
        console.error("Map init failed:", err);
        setStatus("Map init error");
      }
    });

    return () => cancelAnimationFrame(raf);
  }, [entered, clearSelection]);

  /* ---------- render ---------- */
  if (!entered) {
    return <EnterGate onEnter={handleEnter} />;
  }

  return (
    <div className="w-full h-screen relative bg-slate-50 text-slate-900">
      <Navbar status={status} onMenuToggle={() => setControlsOpen(!controlsOpen)} menuOpen={controlsOpen} />

      {/* full-screen map layer */}
      <div ref={containerRef} className="absolute inset-0" />

      {/* inline loading indicator for detail fetch */}
      {fetching && (
        <div className="absolute top-24 right-6 z-[60] bg-white/90 border border-slate-200 rounded-lg px-3 py-1 text-xs shadow">
          Loading parcel details…
        </div>
      )}

      <ControlPanel
        visible={controlsOpen}
        searchText={searchText}
        setSearchText={setSearchText}
        onSearch={handleSearch}
        setBasemap={setBasemap}
        clearSelection={clearSelection}
        overlays={overlays}
        toggleOverlay={toggleOverlay}
        setOverlayOpacity={setOverlayOpacity}
        onExportCSV={exportCSV}
        onExportPDF={exportPDF}
        onStartDraw={startDrawPolygon}
        onClearDrawings={clearDrawings}
      />

      <Sidebar
        visible={sidebarOpen}
        parcelInfo={parcelInfo}
        overlayInfo={overlayInfo}
        onClose={() => setSidebarOpen(false)}
        onGenerateReport={() => setReportVisible(true)}
      />

      <ReportModal
        visible={reportVisible}
        parcelInfo={parcelInfo}
        onClose={() => setReportVisible(false)}
        onDownload={() => { exportPDF(); setReportVisible(false); }}
      />

      {loading && <Spinner text="Loading Texas counties…" />}
    </div>
  );
}
