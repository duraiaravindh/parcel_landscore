const PARCEL_SOURCE = "parcels";
const PARCEL_LAYER = "parcels-layer";
const PARCEL_OUTLINE = "parcels-outline";
const PARCEL_SOURCE_LAYER = "baseLayer";

let highlightedId = null;
let isLoading = false;

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      osm: {
        type: "raster",
        tiles: [
          "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
        ],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors",
      },
      satellite: {
        type: "raster",
        tiles: [
          "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        attribution: "© Esri, Maxar, Earthstar Geographics",
      },
      [PARCEL_SOURCE]: {
        type: "vector",
        tiles: ["http://localhost:8081/data/baseLayer/{z}/{x}/{y}.pbf"],
      },
    },
    layers: [
      {
        id: "osm-basemap",
        type: "raster",
        source: "osm",
      },
      {
        id: "satellite-basemap",
        type: "raster",
        source: "satellite",
        layout: { visibility: "none" },
      },
      {
        id: PARCEL_LAYER,
        type: "fill",
        source: PARCEL_SOURCE,
        "source-layer": PARCEL_SOURCE_LAYER,
        paint: {
          "fill-color": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            "#ffcccc",
            "#ffff00",
          ],
          "fill-opacity": 0.7,
        },
      },
      {
        id: PARCEL_OUTLINE,
        type: "line",
        source: PARCEL_SOURCE,
        "source-layer": PARCEL_SOURCE_LAYER,
        paint: {
          "line-color": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            "#FF0000", // red outline for selected parcel
            "#f1c40f", // default yellow
          ],
          "line-width": 2, // increase for better visibility
          "line-opacity": 1,
        },
      },
    ],
  },
  center: [-97.7431, 30.2672],
  zoom: 10,
  minZoom: 0.5,
  maxZoom: 16,
});

function renderParcelDetails(info) {
  const infoDiv = document.getElementById("info");

  infoDiv.innerHTML = `
    <!-- Overlay slot (always present) -->
    <div id="extra-info" style="display:none; margin-top: 16px;">
      <h3 style="font-size: 14px; margin-bottom: 6px;">Overlay Info</h3>
      <div id="extra-details"></div>
    </div>

    <!-- Your tabs -->
    <div class="tab-header">
      <button class="tab-btn active" data-tab="property">Property</button>
      <button class="tab-btn" data-tab="ownership">Ownership</button>
      <button class="tab-btn" data-tab="legal">Legal</button>
      <button class="tab-btn" data-tab="permits">Permits</button>
    </div>

    <div class="tab-content" id="property-tab">
      <p><strong>Parcel ID:</strong> ${info.parcel_id ?? "N/A"}</p>
      <p><strong>Property ID:</strong> ${info.prop_id ?? "N/A"}</p>
      <p><strong>Market Value:</strong> $${(
        info.market_value ?? 0
      ).toLocaleString()}</p>
      <p><strong>Site Address:</strong> ${info.situs_num ?? ""} ${
    info.situs_street ?? ""
  } ${info.situs_street_suffix ?? ""}, ${info.situs_zip ?? ""}</p>
    </div>

    <div class="tab-content" id="ownership-tab" style="display:none;">
      <p><strong>Owner:</strong> ${info.py_owner_name ?? "N/A"}</p>
      <p><strong>Owner Address:</strong> ${info.py_addr_line1 ?? ""}, ${
    info.py_addr_city ?? ""
  }, ${info.py_addr_state ?? ""} ${info.py_addr_zip ?? ""}</p>
    </div>

    <div class="tab-content" id="legal-tab" style="display:none;">
      <p><strong>Legal Description:</strong> ${info.legal_desc ?? "N/A"}</p>
    </div>

    <div class="tab-content" id="permits-tab" style="display:none;">
      <p>Coming soon…</p>
    </div>

    <div style="margin-top: 8px;">
      <button id="download-pdf">📄 Download PDF</button>
      <button id="download-csv">📊 Download CSV</button>
    </div>
  `;

  // (re)wire tabs
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".tab-btn")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelectorAll(".tab-content")
        .forEach((tab) => (tab.style.display = "none"));
      btn.classList.add("active");
      document.getElementById(`${btn.dataset.tab}-tab`).style.display = "block";
    });
  });
}

// ✅ Updated script.js to preserve extra-info block and fix null innerHTML error

map.on("click", async (e) => {
  if (isLoading) return;

  const parcelInfoEl = document.getElementById("info");
  const extraInfoEl = document.getElementById("extra-info");

  // --- 1. Detect clicked parcel
  const parcelFeatures = map.queryRenderedFeatures(e.point, {
    layers: [PARCEL_LAYER],
  });

  if (!parcelFeatures.length) {
    parcelInfoEl.innerHTML = `
      <h2>Parcel Information</h2>
      <p>No parcel selected.</p>
    `;
    extraInfoEl.innerHTML = "";
    extraInfoEl.style.display = "none";
    return;
  }

  const feature = parcelFeatures[0];
  const masterId = feature.properties.master_id;
  isLoading = true;
  showSpinner();

  try {
    if (highlightedId !== null) {
      map.setFeatureState(
        {
          source: PARCEL_SOURCE,
          sourceLayer: PARCEL_SOURCE_LAYER,
          id: highlightedId,
        },
        { selected: false }
      );
    }

    highlightedId = masterId;
    map.setFeatureState(
      {
        source: PARCEL_SOURCE,
        sourceLayer: PARCEL_SOURCE_LAYER,
        id: highlightedId,
      },
      { selected: true }
    );

    parcelInfoEl.innerHTML = "Loading details...";
    const res = await fetch(`http://localhost:3000/api/details/${masterId}`);
    const data = await res.json();

    if (!data.details) {
      parcelInfoEl.innerHTML = `
        <h2>Parcel Information</h2>
        <p>Parcel selected but no detailed data found in database.</p>
        <p><small>master_id: ${masterId}</small></p>
      `;
    } else {
      renderParcelDetails(data.details);
    }
  } catch (err) {
    console.error("Parcel API error:", err);
    alert("Error fetching parcel details.");
  } finally {
    isLoading = false;
    hideSpinner();
  }

  renderOverlayInfo(e);

  // --- 2. Always render overlay info (even if parcel info missing)
  // Step 2: Detect all visible overlay layers and fetch clicked features
  const visibleOverlayLayers = Array.from(
    document.querySelectorAll(".layer-toggle")
  )
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.layer + "-layer");

  const overlayFeatures = [];

  visibleOverlayLayers.forEach((layerId) => {
    const features = map.queryRenderedFeatures(e.point, { layers: [layerId] });

    if (features.length > 0) {
      overlayFeatures.push(...features);
    }
  });

  // Step 3: Render overlay feature info
  if (overlayFeatures.length > 0 && extraInfoEl) {
    const infoList = overlayFeatures.map((f) => {
      const props = Object.entries(f.properties)
        .map(([key, val]) => `<div><strong>${key}:</strong> ${val}</div>`)
        .join("");

      return `
      <div class="layer-info-box" style="margin-bottom: 12px;">
        <h4 style="font-size: 14px; margin-bottom: 6px; color: #0056b3;">
          📌 ${f.layer.id.replace("-layer", "").replace(/_/g, " ")}
        </h4>
        ${props}
      </div>
    `;
    });

    extraInfoEl.innerHTML = infoList.join("");
    extraInfoEl.style.display = "block";
  } else if (extraInfoEl) {
    extraInfoEl.innerHTML = "";
    extraInfoEl.style.display = "none";
  }
});

map.on("load", () => {
  const overlays = [
    { id: "zoning_base", layer: "base_zoning" },
    { id: "board_adjustment_review", layer: "board_adjustment_review" },
    { id: "build_insp", layer: "build_insp" },
    { id: "envi_insp", layer: "envi_insp" },
  ];

  const overlayColors = {
    zoning_base: "#088",
    board_adjustment_review: "#2196F3",
    build_insp: "#FF9800",
    envi_insp: "#4CAF50",
  };

  overlays.forEach(({ id, layer }) => {
    map.addSource(id, {
      type: "vector",
      tiles: [`http://localhost:8081/data/${id}/{z}/{x}/{y}.pbf`],
    });

    map.addLayer({
      id: `${id}-layer`,
      type: "fill",
      source: id,
      "source-layer": id,
      paint: {
        "fill-color": overlayColors[id] || "#444",
        "fill-opacity": 0.3,
      },
    });

    map.addLayer({
      id: `${id}-outline`,
      type: "line",
      source: id,
      "source-layer": id, // same as above
      paint: {
        "line-color": "#444", // or color by layer type
        "line-width": 1,
        "line-opacity": 0.8,
      },
    });
  });

  map.addLayer({
    id: "baseLayer-outline-highlight",
    type: "line",
    source: PARCEL_SOURCE, // "parcels"
    "source-layer": PARCEL_SOURCE_LAYER, // "baseLayer"
    paint: {
      "line-color": [
        "case",
        ["boolean", ["feature-state", "selected"], false],
        "#ff0000",
        "rgba(0,0,0,0)", // make others invisible
      ],
      "line-width": [
        "case",
        ["boolean", ["feature-state", "selected"], false],
        3,
        0,
      ],
    },
  });

  // Add parcel labels only once
  if (!map.getLayer("parcel-labels")) {
    map.addLayer(
      {
        id: "parcel-labels",
        type: "symbol",
        source: PARCEL_SOURCE,
        "source-layer": PARCEL_SOURCE_LAYER,
        layout: {
          "text-field": ["get", "Parcel_Id"],
          "text-size": 12,
          "text-anchor": "center",
        },
        paint: {
          "text-color": "#000",
          "text-halo-color": "#fff",
          "text-halo-width": 1,
        },
        layout: {
          "text-field": [
            "coalesce",
            ["get", "parcel_id"],
            ["get", "Parcel_Id"],
            "",
          ],
          "text-size": 12,
          "text-anchor": "center",
        },
        minzoom: 12,
      },
      PARCEL_OUTLINE
    );
  }

  // Layer toggle handler
  document.querySelectorAll(".layer-toggle").forEach((checkbox) => {
    checkbox.addEventListener("change", (e) => {
      const layerId = e.target.dataset.layer + "-layer";
      const visibility = e.target.checked ? "visible" : "none";
      map.setLayoutProperty(layerId, "visibility", visibility);
    });
  });

  // === Copilot highlight layer (vector-tile filter by parcel id) ===
  const COPILOT_HL_ID = "copilot-highlight";
  const PARCEL_ID_EXPR = [
    "coalesce",
    ["get", "parcel_id"],
    ["get", "Parcel_Id"],
  ];
  // ^ uses parcel_id if present, else Parcel_Id

  if (!map.getLayer(COPILOT_HL_ID)) {
    map.addLayer(
      {
        id: COPILOT_HL_ID,
        type: "line",
        source: PARCEL_SOURCE, // e.g., "parcels"
        "source-layer": PARCEL_SOURCE_LAYER, // e.g., "baseLayer"
        paint: { "line-width": 3, "line-color": "#ff0000" },
        // start with nothing selected
        filter: ["in", PARCEL_ID_EXPR, ["literal", []]],
      },
      "parcel-labels"
    ); // try to insert above labels (optional)
  }
});

document.querySelectorAll(".opacity-slider").forEach((slider) => {
  slider.addEventListener("input", (e) => {
    const layerId = e.target.dataset.layer;
    const value = parseFloat(e.target.value);
    if (map.getLayer(layerId)) {
      const t = map.getLayer(layerId).type;
      const prop =
        t === "fill"
          ? "fill-opacity"
          : t === "line"
          ? "line-opacity"
          : t === "circle"
          ? "circle-opacity"
          : null;
      if (prop) map.setPaintProperty(layerId, prop, value);
    }
  });
});

document.getElementById("toggle-basemap").addEventListener("change", (e) => {
  const base = e.target.value;
  map.setLayoutProperty(
    "osm-basemap",
    "visibility",
    base === "osm" ? "visible" : "none"
  );
  map.setLayoutProperty(
    "satellite-basemap",
    "visibility",
    base === "satellite" ? "visible" : "none"
  );
});

map.on("mousemove", (e) => {
  const lat = e.lngLat.lat.toFixed(5);
  const lon = e.lngLat.lng.toFixed(5);
  document.getElementById("coords").textContent = `Lat: ${lat}, Lon: ${lon}`;
});

// Spinner
function showSpinner() {
  document.getElementById("loading").style.display = "block";
}
function hideSpinner() {
  document.getElementById("loading").style.display = "none";
}

// Intro screen
function enterMap() {
  document.getElementById("intro-screen").style.display = "none";
  document.body.classList.remove("intro-active");
  const cp = document.getElementById("copilot");
  if (cp) cp.style.display = "flex"; // or "block" depending on your CSS
}

// Accordion
document.querySelectorAll(".accordion").forEach((btn) => {
  btn.addEventListener("click", () => {
    btn.classList.toggle("active");
    const panel = btn.nextElementSibling;
    panel.style.display = panel.style.display === "block" ? "none" : "block";
  });
});

// Layer FAB
document.getElementById("toggle-layer-panel").onclick = () => {
  const panel = document.getElementById("layer-panel");
  panel.style.display = panel.style.display === "block" ? "none" : "block";
};
document.getElementById("layer-close").onclick = () => {
  document.getElementById("layer-panel").style.display = "none";
};

// Debounced Search
const debounce = (fn, delay) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
};

const searchBtn = document.getElementById("search-btn");
searchBtn.addEventListener("click", debounce(searchParcel, 300));

async function searchParcel() {
  const input = document.getElementById("parcelSearch").value.trim();
  if (!input) return alert("Enter Parcel ID.");

  showSpinner();
  searchBtn.disabled = true;

  try {
    const res = await fetch(`http://localhost:3000/api/parcels/${input}`);
    const result = await res.json();

    if (!result.details?.master_id) {
      alert("Parcel not found.");
      return;
    }

    const masterId = result.details.master_id;

    // 🔍 Step 1: Find matching feature from vector tile by master_id
    const visibleFeatures = map.querySourceFeatures(PARCEL_SOURCE, {
      sourceLayer: PARCEL_SOURCE_LAYER,
    });

    const matchedFeature = visibleFeatures.find(
      (f) => f.properties.master_id == masterId
    );

    if (!matchedFeature) {
      alert("Parcel geometry not found on map.");
      return;
    }

    // 🔄 Step 2: Unhighlight previously selected
    if (highlightedId !== null) {
      map.setFeatureState(
        {
          source: PARCEL_SOURCE,
          sourceLayer: PARCEL_SOURCE_LAYER,
          id: highlightedId,
        },
        { selected: false }
      );
    }

    // ✅ Step 3: Highlight matched feature
    highlightedId = matchedFeature.id;
    map.setFeatureState(
      {
        source: PARCEL_SOURCE,
        sourceLayer: PARCEL_SOURCE_LAYER,
        id: highlightedId,
      },
      { selected: true }
    );

    // 🎯 Step 4: Zoom or Fly to Parcel
    if (result.bbox?.length === 4) {
      map.fitBounds(result.bbox, { padding: 50, maxZoom: 17, duration: 1000 });
    } else if (
      result.details?.lon !== undefined &&
      result.details?.lat !== undefined &&
      !isNaN(result.details.lon) &&
      !isNaN(result.details.lat)
    ) {
      map.flyTo({ center: [result.details.lon, result.details.lat], zoom: 16 });
    } else {
      alert("Coordinates missing or invalid for selected parcel.");
    }

    // 🧾 Step 5: Show Parcel Info Panel
    renderParcelDetails(result.details);
  } catch (err) {
    console.error("Search error:", err);
    alert("Failed to fetch parcel.");
  } finally {
    hideSpinner();
    searchBtn.disabled = false;
  }
}

// CSV download logic
document.getElementById("download-csv").onclick = () => {
  const text = document.getElementById("info").innerText;
  const rows = [
    ["Field", "Value"],
    ["Raw", JSON.stringify(info)],
  ];
  const csv = rows.map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: "parcel-details.csv",
  });
  link.click();
};

document.getElementById("download-pdf").onclick = () => {
  const text = document.getElementById("info").innerText;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const link = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: "parcel-details.txt",
  });
  link.click();
};

// PDF/TXT fallback download
document.getElementById("download-pdf").onclick = () => {
  const text = document.getElementById("info").innerText;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "parcel-details.txt";
  link.click();
};

function clearSearch() {
  document.getElementById("parcelSearch").value = "";
  document.getElementById("info").innerHTML = `
    <h2>Parcel Information</h2>
    <p>Click on a parcel to view details.</p>
  `;

  if (highlightedId !== null) {
    map.setFeatureState(
      {
        source: PARCEL_SOURCE,
        sourceLayer: PARCEL_SOURCE_LAYER,
        id: highlightedId,
      },
      { selected: false }
    );
    highlightedId = null;
  }
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".tab-btn")
      .forEach((b) => b.classList.remove("active"));
    document
      .querySelectorAll(".tab-content")
      .forEach((tab) => (tab.style.display = "none"));

    btn.classList.add("active");
    document.getElementById(`${btn.dataset.tab}-tab`).style.display = "block";
  });
});

let dragSrcEl = null;

document.querySelectorAll(".layer-entry").forEach((entry) => {
  entry.addEventListener("dragstart", (e) => {
    dragSrcEl = entry;
    e.dataTransfer.effectAllowed = "move";
  });

  entry.addEventListener("dragover", (e) => e.preventDefault());

  entry.addEventListener("drop", (e) => {
    e.preventDefault();
    if (dragSrcEl !== entry) {
      entry.parentNode.insertBefore(dragSrcEl, entry.nextSibling);

      const allEntries = Array.from(
        document.querySelectorAll("#overlay-panel .layer-entry")
      );

      // Reorder visible overlay layers from top to bottom
      for (let i = allEntries.length - 1; i >= 0; i--) {
        const el = allEntries[i];
        const layerId =
          el.querySelector("input.layer-toggle").dataset.layer + "-layer";
        const beforeEl = allEntries[i + 1];
        const beforeId = beforeEl
          ? beforeEl.querySelector("input.layer-toggle").dataset.layer +
            "-layer"
          : undefined;

        try {
          if (map.getLayer(layerId)) {
            map.moveLayer(layerId, beforeId); // Reorder on map
          }
        } catch (err) {
          console.warn("Layer move failed:", err);
        }
      }
    }
  });
});

function copyId() {
  const id = document.getElementById("copy-id").innerText;
  navigator.clipboard.writeText(id);
  alert("Copied master_id to clipboard!");
}

function renderOverlayInfo(e) {
  const extraInfoWrap = document.getElementById("extra-info");
  const extraDetails = document.getElementById("extra-details");
  if (!extraInfoWrap || !extraDetails) return;

  // Derive visible overlay layer IDs from your checkboxes (adjust selector if needed)
  const visibleOverlayLayers = Array.from(
    document.querySelectorAll(".layer-toggle")
  )
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.layer + "-layer"); // assumes your map style uses this suffix

  const overlayFeatures = [];
  visibleOverlayLayers.forEach((layerId) => {
    try {
      const feats = map.queryRenderedFeatures(e.point, { layers: [layerId] });
      overlayFeatures.push(...feats);
    } catch (_) {
      // layer may not exist in current style zoom; ignore
    }
  });

  if (!overlayFeatures.length) {
    extraDetails.innerHTML = "";
    extraInfoWrap.style.display = "none";
    return;
  }

  const list = overlayFeatures.map((f) => {
    const props = Object.entries(f.properties || {})
      .map(([k, v]) => `<div><strong>${k}:</strong> ${v}</div>`)
      .join("");
    const title = (f.layer && f.layer.id ? f.layer.id : "layer")
      .replace("-layer", "")
      .replace(/_/g, " ");
    return `<div class="layer-info-box" style="margin-bottom:12px;">
      <h4 style="font-size:14px;margin-bottom:6px;">📌 ${title}</h4>
      ${props}
    </div>`;
  });

  extraDetails.innerHTML = list.join("");
  extraInfoWrap.style.display = "block";
}

document.querySelectorAll(".layer-toggle").forEach((cb) => {
  cb.addEventListener("change", () => {
    const layerId = cb.dataset.layer + "-layer";
    map.setLayoutProperty(
      layerId,
      "visibility",
      cb.checked ? "visible" : "none"
    );
  });
});

// ===== Copilot helpers that use the layer created on 'load' =====
function highlightByParcelIds(ids) {
  if (!map.getLayer("copilot-highlight")) return;
  // Filter the layer to only the returned ids
  const parcelIdExpr = ["coalesce", ["get", "parcel_id"], ["get", "Parcel_Id"]];
  map.setFilter("copilot-highlight", ["in", parcelIdExpr, ["literal", ids]]);
}

function fitToBBox(bbox) {
  if (!bbox) return;
  const [minX, minY, maxX, maxY] = bbox;
  map.fitBounds(
    [
      [minX, minY],
      [maxX, maxY],
    ],
    { padding: 40, duration: 800 }
  );
}

function applyMapAction(action, features) {
  if (action?.type === "zoomToBBox") fitToBBox(action.bbox);
  // Prefer parcel_id for vector-tiles; switch to master_id only if your tiles include it
  const ids = (features || [])
    .map((f) => f.parcel_id ?? f.Parcel_Id)
    .filter(Boolean);
  if (ids.length) highlightByParcelIds(ids);
}
