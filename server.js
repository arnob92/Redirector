// server.js — Multi-Country Geo Redirector
const express = require("express");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.text({ type: "*/*", limit: "2mb" }));
app.set("trust proxy", true);

// -------------------------------
// CONFIG
// -------------------------------
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change_this_token";
const DISABLE_ADMIN = process.env.DISABLE_ADMIN === "1";

const CITIES_FILE = path.join(__dirname, "cities.json");
const IPAPI_TIMEOUT_MS = 4000;
const IPAPI_CACHE_TTL_MS = 1000 * 60 * 60 * 24;

// simple IP cache
const ipCache = new Map();

// -------------------------------
// Helpers
// -------------------------------
function readCities() {
  try {
    return JSON.parse(fs.readFileSync(CITIES_FILE, "utf8"));
  } catch {
    return { INTERNATIONAL_LINK: "https://example.com/international" };
  }
}

function writeCities(obj) {
  fs.writeFileSync(CITIES_FILE, JSON.stringify(obj, null, 2), "utf8");
}

function toRad(x) {
  return x * Math.PI / 180;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function getClientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-real-ip"] ||
    (req.headers["x-forwarded-for"]
      ? req.headers["x-forwarded-for"].split(",")[0].trim()
      : null) ||
    req.ip ||
    null
  );
}

// -------------------------------
// IP API
// -------------------------------
async function getIpGeo(ip) {
  if (!ip) return null;

  const now = Date.now();
  const cached = ipCache.get(ip);
  if (cached && cached.expiresAt > now) return cached.data;

  const url = `https://ipapi.co/${encodeURIComponent(ip)}/json/`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IPAPI_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      ipCache.set(ip, { data: null, expiresAt: now + 60000 });
      return null;
    }

    const data = await res.json();
    ipCache.set(ip, { data, expiresAt: now + IPAPI_CACHE_TTL_MS });
    return data;
  } catch {
    ipCache.set(ip, { data: null, expiresAt: now + 60000 });
    return null;
  }
}

// -------------------------------
// REDIRECT CONTROLLER
// -------------------------------
app.get("/redirect", async (req, res) => {
  try {
    const cfg = readCities();
    const intl = cfg.INTERNATIONAL_LINK || "https://example.com/international";

    const ip = req.query.testip || getClientIp(req);
    const geo = await getIpGeo(ip);

    console.log("IP:", ip);
    console.log("Geo:", geo);

    // Validate
    if (!geo || !geo.country_code) return res.redirect(intl);

    const country = geo.country_code.toUpperCase();

    // Load this country's sections
    const countrySections = cfg[country];
    if (!countrySections || !Array.isArray(countrySections)) {
      console.warn("Country not found in JSON:", country);
      return res.redirect(intl);
    }

    const lat = parseFloat(geo.latitude);
    const lon = parseFloat(geo.longitude);

    if (!isFinite(lat) || !isFinite(lon)) return res.redirect(intl);

    const regionRaw = (
      geo.region_code ||
      geo.region ||
      ""
    )
      .toString()
      .trim()
      .toUpperCase();

    // 1) Region filtering
    function matchRegion(s) {
      const name = (s.state || s.division || s.name || "")
        .toString()
        .toUpperCase();
      const code = (s.code || "").toString().toUpperCase();

      return (
        regionRaw === name ||
        regionRaw === code ||
        name.includes(regionRaw) ||
        regionRaw.includes(name)
      );
    }

    let possibleStates = countrySections.filter(matchRegion);
    if (possibleStates.length === 0) possibleStates = countrySections;

    // 2) Nearest city selection
    let best = null;
    let bestD = Infinity;

    for (const st of possibleStates) {
      if (!Array.isArray(st.cities)) continue;
      for (const c of st.cities) {
        if (!c.lat || !c.lon) continue;
        const d = haversineKm(lat, lon, Number(c.lat), Number(c.lon));
        if (d < bestD) {
          best = c;
          bestD = d;
        }
      }
    }

    if (!best || !best.link) return res.redirect(intl);

    console.log("Redirecting to:", best.link);
    return res.redirect(best.link);
  } catch (err) {
    console.error("Redirect error:", err);
    const cfg = readCities();
    return res.redirect(cfg.INTERNATIONAL_LINK);
  }
});

// ROOT → redirect
app.get("/", (req, res) => res.redirect("/redirect"));

// -------------------------------
// ADMIN ENDPOINTS
// -------------------------------
if (!DISABLE_ADMIN) {
  function checkAdminToken(req, res, next) {
    const tok = req.headers["x-admin-token"] || req.query.token;
    if (!tok || tok !== ADMIN_TOKEN)
      return res.status(401).send("unauthorized");
    next();
  }

  app.get("/api/cities", checkAdminToken, (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.send(fs.readFileSync(CITIES_FILE, "utf8"));
  });

  app.post("/api/cities", checkAdminToken, (req, res) => {
    try {
      const json = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      writeCities(json);
      res.send("OK");
    } catch {
      res.status(400).send("invalid json");
    }
  });

  app.get("/api/debug-geo", checkAdminToken, async (req, res) => {
    const ip = req.query.ip || getClientIp(req);
    const g = ip ? await getIpGeo(ip) : null;
    res.json({ ip, geo: g });
  });
}

// -------------------------------
app.listen(PORT, () =>
  console.log(`Geo redirector ready on port ${PORT}`)
);
