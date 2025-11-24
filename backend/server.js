// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

/* --------------------- middleware --------------------- */
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// tiny request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

/* --------------------- database ----------------------- */
/**
 * ENV you can set:
 *   DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME, DB_SCHEMA (default: core)
 *   DB_SSL=true  (for managed Postgres like Neon/Render/Heroku)
 */
const TARGET_SCHEMA = process.env.DB_SCHEMA || "core";

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "landscore",
  application_name: "parcel-viewer-api",
  options: `-c search_path=${TARGET_SCHEMA},public`,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

pool.on("connect", () => {
  console.log(`✅ DB connected (schema=${TARGET_SCHEMA}, ssl=${process.env.DB_SSL === "true"})`);
});

pool.on("error", (err) => {
  console.error("🐘 PG pool error:", err);
});

/* --------------------- helpers ------------------------ */
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toPayload(row) {
  if (!row) return null;
  return {
    // ids
    master_id: row.master_id,
    prop_id: row.prop_id,

    // address / geo identity
    address: row.situs_address,
    city: row.situs_city,
    zip: row.situs_zip,
    situs_street_num: row.situs_street_num,
    situs_street_name: row.situs_street_name,
    geo_id: row.geo_id,
    block: row.block,
    tract_or_lot: row.tract_or_lot,

    // property / legal
    prop_type_cd: row.prop_type_cd,
    legal_desc: row.legal_desc,
    legal_loc_desc: row.legal_loc_desc,
    legal_acreage: row.legal_acreage,
    land_acres: row.land_acres,

    // valuation
    market_value: row.curr_market_val ?? row.market_val ?? 0,
    curr_assessed_val: row.curr_assessed_val ?? null,
    curr_land_val: row.curr_land_val ?? null,
    curr_imprv_val: row.curr_imprv_val ?? null,
    market_val: row.market_val ?? null,
    assessed_val: row.assessed_val ?? null,

    // derived
    area_acres: row.area_acres ?? 0,
    land_segments: row.land_segments ?? 0,
    improvements: row.improvements ?? 0,

    // lists
    land_segments_list: row.land_segments_list ?? [],
    improvements_list: row.improvements_list ?? [],
  };
}

/**
 * Robust master_id lookup with all requested fields
 */
async function getDetailsByMasterId(masterId) {
  const q = `
    WITH any_master AS (
      SELECT $1::uuid AS master_id
      WHERE EXISTS (SELECT 1 FROM ${TARGET_SCHEMA}.property_master p WHERE p.master_id = $1::uuid)
      UNION ALL
      SELECT $1::uuid
      WHERE EXISTS (SELECT 1 FROM ${TARGET_SCHEMA}.land_master l WHERE l.master_id = $1::uuid)
      UNION ALL
      SELECT $1::uuid
      WHERE EXISTS (SELECT 1 FROM ${TARGET_SCHEMA}.improvement_master m WHERE m.master_id = $1::uuid)
      LIMIT 1
    ),
    base AS (
      SELECT
        am.master_id,
        p.prop_id,
        -- property_master fields you asked for
        p.legal_desc,
        p.legal_loc_desc,
        p.legal_acreage,
        p.curr_assessed_val,
        p.curr_land_val,
        p.curr_imprv_val,
        p.market_val,
        p.assessed_val,
        p.situs_address,
        p.situs_street_num,
        p.situs_street_name,
        p.situs_city,
        p.situs_zip,
        p.prop_type_cd,
        p.geo_id,
        p.block,
        p.tract_or_lot,
        p.land_acres,
        p.curr_market_val
      FROM any_master am
      LEFT JOIN ${TARGET_SCHEMA}.property_master p
        ON p.master_id = am.master_id
      LIMIT 1
    ),
    land AS (
      SELECT
        COUNT(*)::int AS land_segments,
        COALESCE(SUM(size_acres), 0)::float AS area_acres,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'land_seg_id', lm.land_seg_id,
              'land_type_cd', lm.land_type_cd,
              'land_type_desc', lm.land_type_desc,
              'size_acres', lm.size_acres,
              'land_area_factor', lm.land_area_factor,
              'land_seg_mkt_val', lm.land_seg_mkt_val,
              'land_val', lm.land_val,
              'prop_val_yr', lm.prop_val_yr
            )
            ORDER BY lm.land_seg_id
          ), '[]'::jsonb
        ) AS land_segments_list
      FROM ${TARGET_SCHEMA}.land_master lm
      WHERE lm.master_id = $1::uuid
    ),
    impr AS (
      SELECT
        COUNT(*)::int AS improvements,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'improvement_id', im.improvement_id,
              'imprv_type_desc', im.imprv_type_desc,
              'imprv_val', im.imprv_val,
              'yr_built', im.yr_built,
              'imprv_det_area', im.imprv_det_area,
              'prop_num', im.prop_num
            )
            ORDER BY im.improvement_id
          ), '[]'::jsonb
        ) AS improvements_list
      FROM ${TARGET_SCHEMA}.improvement_master im
      WHERE im.master_id = $1::uuid
    )
    SELECT
      base.*,
      land.land_segments,
      land.area_acres,
      land.land_segments_list,
      impr.improvements,
      impr.improvements_list
    FROM base
    LEFT JOIN land ON TRUE
    LEFT JOIN impr ON TRUE
  `;
  const r = await pool.query(q, [masterId]);
  return r.rows?.[0] || null;
}

/**
 * prop_id lookup with same field coverage
 */
async function getDetailsByPropId(propId) {
  const q = `
    WITH base AS (
      SELECT
        p.master_id,
        p.prop_id,

        p.legal_desc,
        p.legal_loc_desc,
        p.legal_acreage,
        p.curr_assessed_val,
        p.curr_land_val,
        p.curr_imprv_val,
        p.market_val,
        p.assessed_val,
        p.situs_address,
        p.situs_street_num,
        p.situs_street_name,
        p.situs_city,
        p.situs_zip,
        p.prop_type_cd,
        p.geo_id,
        p.block,
        p.tract_or_lot,
        p.land_acres,
        p.curr_market_val

      FROM ${TARGET_SCHEMA}.property_master p
      WHERE p.prop_id = $1
      ORDER BY p.master_id NULLS LAST
      LIMIT 1
    ),
    land AS (
      SELECT
        COUNT(*)::int AS land_segments,
        COALESCE(SUM(size_acres), 0)::float AS area_acres,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'land_seg_id', lm.land_seg_id,
              'land_type_cd', lm.land_type_cd,
              'land_type_desc', lm.land_type_desc,
              'size_acres', lm.size_acres,
              'land_area_factor', lm.land_area_factor,
              'land_seg_mkt_val', lm.land_seg_mkt_val,
              'land_val', lm.land_val,
              'prop_val_yr', lm.prop_val_yr
            )
            ORDER BY lm.land_seg_id
          ), '[]'::jsonb
        ) AS land_segments_list
      FROM ${TARGET_SCHEMA}.land_master lm
      JOIN base b ON lm.master_id = b.master_id
    ),
    impr AS (
      SELECT
        COUNT(*)::int AS improvements,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'improvement_id', im.improvement_id,
              'imprv_type_desc', im.imprv_type_desc,
              'imprv_val', im.imprv_val,
              'yr_built', im.yr_built,
              'imprv_det_area', im.imprv_det_area,
              'prop_num', im.prop_num
            )
            ORDER BY im.improvement_id
          ), '[]'::jsonb
        ) AS improvements_list
      FROM ${TARGET_SCHEMA}.improvement_master im
      JOIN base b ON im.master_id = b.master_id
    )
    SELECT
      base.*,
      land.land_segments,
      land.area_acres,
      land.land_segments_list,
      impr.improvements,
      impr.improvements_list
    FROM base
    LEFT JOIN land ON TRUE
    LEFT JOIN impr ON TRUE
  `;
  const r = await pool.query(q, [propId]);
  return r.rows?.[0] || null;
}

/* ----------------------- routes ----------------------- */

// health
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/details/:id
 * :id may be a UUID master_id OR a prop_id (string/number).
 */
app.get("/api/details/:id", async (req, res) => {
  const id = (req.params.id || "").trim();
  try {
    let row = null;

    if (UUID_RX.test(id)) row = await getDetailsByMasterId(id);
    if (!row) row = await getDetailsByPropId(id);

    if (!row) return res.json({ details: null, note: "no_match" });

    return res.json({ details: toPayload(row) });
  } catch (err) {
    console.error("details route error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/parcels/:parcel_id
 * Used by the front-end “search” bar. Proxies by prop_id.
 */
app.get("/api/parcels/:parcel_id", async (req, res) => {
  const pid = (req.params.parcel_id || "").trim();
  try {
    const row = await getDetailsByPropId(pid);
    if (!row) return res.json({ details: null, note: "no_match" });
    return res.json({ details: toPayload(row) });
  } catch (err) {
    console.error("parcels route error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* --------------- final error handler ------------------ */
app.use((err, _req, res, _next) => {
  console.error("===== SERVER ERROR =====");
  console.error(err && err.stack ? err.stack : err);
  console.error("========================");
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ------------------------ start ----------------------- */
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`🚀 API on http://localhost:${PORT}`);
});
