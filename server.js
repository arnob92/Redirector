// server.js — Simplified version without state code dependency
const express = require("express");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.text({ type: "*/*", limit: "4mb" }));
app.set("trust proxy", true);

// -------------------------------
// CONFIG
// -------------------------------
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DISABLE_ADMIN = process.env.DISABLE_ADMIN === '1';

console.log("Admin panel disabled:", DISABLE_ADMIN ? "yes" : "no");
console.log(ADMIN_TOKEN);

const CITIES_FILE = path.join(__dirname, "cities.json");
const IPAPI_TIMEOUT_MS = 4000;
const IPAPI_CACHE_TTL_MS = 1000 * 60 * 60 * 24;

// IP cache
const ipCache = new Map();

// -------------------------------
// Helpers
// -------------------------------
function readCities() {
  try {
    return JSON.parse(fs.readFileSync(CITIES_FILE, "utf8"));
  } catch (err) {
    console.error("Could not read cities.json:", err);
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

  const url = `https://ipwho.is/${encodeURIComponent(ip)}`;

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
// GEO REDIRECT
// -------------------------------
app.get("/redirect", async (req, res) => {
  try {
    const cfg = readCities();
    const intl = cfg.INTERNATIONAL_LINK || "https://example.com/international";

    const ip = req.query.testip || getClientIp(req);
    const geo = await getIpGeo(ip);

    console.log("Visitor IP:", ip);
    console.log("Geo:", geo);

    if (!geo || !geo.country_code) {
      console.warn("Geo lookup failed → international fallback");
      return res.redirect(intl);
    }

    const country = geo.country_code.toUpperCase();
    const countrySections = cfg[country];

    if (!countrySections || !Array.isArray(countrySections)) {
      console.warn("Country not found:", country);
      return res.redirect(intl);
    }

    const lat = parseFloat(geo.latitude);
    const lon = parseFloat(geo.longitude);

    if (!isFinite(lat) || !isFinite(lon)) {
      console.warn("Invalid lat/lon");
      return res.redirect(intl);
    }

    const regionRaw = (
      geo.region_code ||
      geo.region ||
      ""
    ).toString().trim().toUpperCase();

    // Region match improvement - uses both name and code
    const regionMatcher = (s) => {
      const name = (s.name || "").toUpperCase();
      const code = (s.code || "").toUpperCase();
      if (!regionRaw) return false;

      return (
        regionRaw === name ||
        regionRaw === code ||
        name.includes(regionRaw) ||
        code.includes(regionRaw)
      );
    };

    let matchedStates = countrySections.filter(regionMatcher);
    if (matchedStates.length === 0) matchedStates = countrySections;

    // Find nearest city
    let nearest = null;
    let bestDist = Infinity;

    for (const state of matchedStates) {
      if (!Array.isArray(state.cities)) continue;
      for (const c of state.cities) {
        if (c.lat === undefined || c.lon === undefined || c.lat === null || c.lon === null) continue;

        const d = haversineKm(lat, lon, Number(c.lat), Number(c.lon));
        if (d < bestDist) {
          nearest = c;
          bestDist = d;
        }
      }
    }

    if (!nearest || !nearest.link) {
      console.warn("No valid city found → international fallback");
      return res.redirect(intl);
    }

    console.log("Redirect →", nearest.name, nearest.link, `(${bestDist.toFixed(2)} km)`);
    return res.redirect(nearest.link);

  } catch (err) {
    console.error("Redirect error:", err);
    const cfg = readCities();
    return res.redirect(cfg.INTERNATIONAL_LINK);
  }
});

// Root route
app.get("/", (req, res) => res.redirect("/redirect"));

// -------------------------------
// ADMIN ENDPOINTS (with CRUD) - SIMPLIFIED
// -------------------------------
if (!DISABLE_ADMIN) {
  const checkAdminToken = (req, res, next) => {
    const tok = req.headers["x-admin-token"] || req.query.token;
    if (tok !== ADMIN_TOKEN) return res.status(401).send("unauthorized");
    next();
  };

  // Load full JSON
  app.get("/api/cities", checkAdminToken, (req, res) => {
    res.type("json").send(fs.readFileSync(CITIES_FILE, "utf8"));
  });

  // Overwrite entire JSON (keeps compatibility)
  app.post("/api/cities", checkAdminToken, (req, res) => {
    try {
      const json = JSON.parse(req.body);
      writeCities(json);
      res.send("OK");
    } catch (err) {
      console.error("POST /api/cities invalid json", err);
      res.status(400).send("invalid json");
    }
  });

  // -------------------------------
  // Country CRUD
  // -------------------------------
  app.post("/api/country/add", checkAdminToken, (req, res) => {
    try {
      const { code, initialStateName } = JSON.parse(req.body || '{}');
      if (!code) return res.status(400).json({ success: false, error: "missing code" });

      const data = readCities();
      const key = code.toUpperCase();
      if (!data[key]) data[key] = [];
      if (initialStateName) {
        data[key].push({ name: initialStateName, code: '', cities: [] });
      }
      writeCities(data);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/country/delete", checkAdminToken, (req, res) => {
    try {
      const { code } = JSON.parse(req.body || '{}');
      if (!code) return res.status(400).json({ success: false, error: "missing code" });

      const data = readCities();
      delete data[code];
      writeCities(data);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // -------------------------------
  // State CRUD - Simplified (no code required)
  // -------------------------------
  app.post("/api/state/add", checkAdminToken, (req, res) => {
    try {
      const { country, name, code } = JSON.parse(req.body || '{}');
      if (!country || !name) return res.status(400).json({ success: false, error: "missing country or name" });

      const data = readCities();
      if (!data[country]) data[country] = [];
      data[country].push({ name, code: code || '', cities: [] });
      writeCities(data);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/state/delete", checkAdminToken, (req, res) => {
    try {
      const { country, stateName } = JSON.parse(req.body || '{}');
      if (!country || !stateName) return res.status(400).json({ success: false, error: "missing params" });

      const data = readCities();
      if (!data[country]) return res.status(400).json({ success: false, error: "country not found" });

      data[country] = data[country].filter(s => s.name !== stateName);
      writeCities(data);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // -------------------------------
  // City CRUD - Simplified (use stateName instead of stateCode)
  // -------------------------------
  // -------------------------------
// City CRUD - FIXED VERSION
// -------------------------------
app.post("/api/city/add", checkAdminToken, (req, res) => {
  try {
    const { country, stateName, name, lat, lon, link } = JSON.parse(req.body || '{}');
    if (!country || !stateName || !name) {
      return res.status(400).json({ success: false, error: "missing params" });
    }

    const data = readCities();
    const state = data[country]?.find(s => s.name === stateName);
    if (!state) return res.status(400).json({ success: false, error: "state not found" });

    state.cities = state.cities || [];
    state.cities.push({ 
      name, 
      lat: lat === undefined || lat === null ? '' : lat, 
      lon: lon === undefined || lon === null ? '' : lon, 
      link: link || '' 
    });
    writeCities(data);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/city/update", checkAdminToken, (req, res) => {
  try {
    const { country, stateName, cityIndex, name, lat, lon, link } = JSON.parse(req.body || '{}');
    
    // Only require country, stateName, and cityIndex
    if (!country || !stateName || cityIndex === undefined) {
      return res.status(400).json({ success: false, error: "missing params" });
    }

    const data = readCities();
    const state = data[country]?.find(s => s.name === stateName);
    if (!state) return res.status(400).json({ success: false, error: "state not found" });

    if (!state.cities || !state.cities[cityIndex]) {
      return res.status(400).json({ success: false, error: "city not found" });
    }

    const city = state.cities[cityIndex];
    
    // Only update if value is provided (not undefined)
    if (name !== undefined) city.name = name;
    if (lat !== undefined) city.lat = lat;
    if (lon !== undefined) city.lon = lon;
    if (link !== undefined) city.link = link;

    writeCities(data);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/city/delete", checkAdminToken, (req, res) => {
  try {
    const { country, stateName, cityIndex } = JSON.parse(req.body || '{}');
    
    // FIXED: Use cityIndex instead of name
    if (!country || !stateName || cityIndex === undefined) {
      return res.status(400).json({ success: false, error: "missing params" });
    }

    const data = readCities();
    const state = data[country]?.find(s => s.name === stateName);
    if (!state) return res.status(400).json({ success: false, error: "state not found" });

    if (!state.cities || !state.cities[cityIndex]) {
      return res.status(400).json({ success: false, error: "city not found" });
    }

    // Remove the city at the specified index
    state.cities.splice(cityIndex, 1);
    writeCities(data);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

  // debug geo (kept)
  app.get("/api/debug-geo", checkAdminToken, async (req, res) => {
    const ip = req.query.ip || getClientIp(req);
    const g = ip ? await getIpGeo(ip) : null;
    res.json({ ip, geo: g });
  });
}

// -------------------------------
// ADMIN UI SERVE
// -------------------------------
if (!DISABLE_ADMIN) {
  // Serve static files from /public
  app.use("/admin", express.static(path.join(__dirname, "public")));

  // Serve admin.html at /admin
  app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin.html"));
  });
}

app.listen(PORT, () =>
  console.log(`Geo Redirector running on port ${PORT}`)
);