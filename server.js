// server.js – Model-based geo redirector with country/state structure
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

const DATA_FILE = path.join(__dirname, "cities.json");
const IPAPI_TIMEOUT_MS = 4000;
const IPAPI_CACHE_TTL_MS = 1000 * 60 * 60 * 24;

// IP cache
const ipCache = new Map();

// -------------------------------
// Helpers
// -------------------------------
function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (err) {
    console.error("Could not read cities.json:", err);
    return {};
  }
}

function writeData(obj) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), "utf8");
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

// Root route - return nothing
app.get("/", (req, res) => {
  res.status(404).send("Not found");
});

// -------------------------------
// ADMIN UI & API - BEFORE /:model route to avoid conflicts
// -------------------------------
if (!DISABLE_ADMIN) {
  const checkAdminToken = (req, res, next) => {
    const tok = req.headers["x-admin-token"] || req.query.token;
    if (tok !== ADMIN_TOKEN) return res.status(401).send("unauthorized");
    next();
  };

  // Serve admin UI
  app.use("/admin", express.static(path.join(__dirname, "public")));
  app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin.html"));
  });

  // Load full JSON
  app.get("/api/data", checkAdminToken, (req, res) => {
    res.type("json").send(fs.readFileSync(DATA_FILE, "utf8"));
  });

  // Overwrite entire JSON
  app.post("/api/data", checkAdminToken, (req, res) => {
    try {
      const json = JSON.parse(req.body);
      writeData(json);
      res.send("OK");
    } catch (err) {
      console.error("POST /api/data invalid json", err);
      res.status(400).send("invalid json");
    }
  });

  // -------------------------------
  // Model CRUD
  // -------------------------------
  app.post("/api/model/add", checkAdminToken, (req, res) => {
    try {
      const { name, default_link } = JSON.parse(req.body || '{}');
      if (!name || !default_link) return res.status(400).json({ success: false, error: "missing params" });

      const data = readData();
      if (data[name]) return res.status(400).json({ success: false, error: "model already exists" });
      
      data[name] = { default_link, countries: {} };
      writeData(data);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/model/update", checkAdminToken, (req, res) => {
    try {
      const { oldName, name, default_link } = JSON.parse(req.body || '{}');
      if (!oldName) return res.status(400).json({ success: false, error: "missing oldName" });

      const data = readData();
      if (!data[oldName]) return res.status(400).json({ success: false, error: "model not found" });
      
      // If name changed, rename the model
      if (name && name !== oldName) {
        data[name] = data[oldName];
        delete data[oldName];
        if (default_link !== undefined) data[name].default_link = default_link;
      } else if (default_link !== undefined) {
        data[oldName].default_link = default_link;
      }
      
      writeData(data);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/model/delete", checkAdminToken, (req, res) => {
    try {
      const { name } = JSON.parse(req.body || '{}');
      if (!name) return res.status(400).json({ success: false, error: "missing name" });

      const data = readData();
      delete data[name];
      writeData(data);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // -------------------------------
  // Country CRUD
  // -------------------------------
  app.post("/api/country/add", checkAdminToken, (req, res) => {
    try {
      const { model, code } = JSON.parse(req.body || '{}');
      if (!model || !code) return res.status(400).json({ success: false, error: "missing params" });

      const data = readData();
      if (!data[model]) return res.status(400).json({ success: false, error: "model not found" });
      if (!data[model].countries) data[model].countries = {};
      if (!data[model].countries[code]) data[model].countries[code] = [];
      
      writeData(data);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/country/delete", checkAdminToken, (req, res) => {
    try {
      const { model, code } = JSON.parse(req.body || '{}');
      if (!model || !code) return res.status(400).json({ success: false, error: "missing params" });

      const data = readData();
      if (!data[model] || !data[model].countries) return res.status(400).json({ success: false, error: "model/country not found" });
      
      delete data[model].countries[code];
      writeData(data);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // -------------------------------
  // State CRUD
  // -------------------------------
  app.post("/api/state/add", checkAdminToken, (req, res) => {
    try {
      const { model, country, name, code } = JSON.parse(req.body || '{}');
      if (!model || !country || !name) return res.status(400).json({ success: false, error: "missing params" });

      const data = readData();
      if (!data[model] || !data[model].countries || !data[model].countries[country]) {
        return res.status(400).json({ success: false, error: "model/country not found" });
      }
      
      data[model].countries[country].push({ name, code: code || '', cities: [] });
      writeData(data);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/state/delete", checkAdminToken, (req, res) => {
    try {
      const { model, country, stateIndex } = JSON.parse(req.body || '{}');
      if (!model || !country || stateIndex === undefined) return res.status(400).json({ success: false, error: "missing params" });

      const data = readData();
      if (!data[model] || !data[model].countries || !data[model].countries[country]) {
        return res.status(400).json({ success: false, error: "model/country not found" });
      }
      
      data[model].countries[country].splice(stateIndex, 1);
      writeData(data);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // -------------------------------
  // City CRUD
  // -------------------------------
  app.post("/api/city/add", checkAdminToken, (req, res) => {
    try {
      const { model, country, stateIndex, name, lat, lon, link } = JSON.parse(req.body || '{}');
      if (!model || !country || stateIndex === undefined || !name) {
        return res.status(400).json({ success: false, error: "missing params" });
      }

      const data = readData();
      const state = data[model]?.countries?.[country]?.[stateIndex];
      if (!state) return res.status(400).json({ success: false, error: "state not found" });

      if (!state.cities) state.cities = [];
      state.cities.push({ 
        name, 
        lat: lat === undefined || lat === null || lat === '' ? '' : lat, 
        lon: lon === undefined || lon === null || lon === '' ? '' : lon, 
        link: link || '' 
      });
      writeData(data);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/city/update", checkAdminToken, (req, res) => {
    try {
      const { model, country, stateIndex, cityIndex, name, lat, lon, link } = JSON.parse(req.body || '{}');
      
      if (!model || !country || stateIndex === undefined || cityIndex === undefined) {
        return res.status(400).json({ success: false, error: "missing params" });
      }

      const data = readData();
      const city = data[model]?.countries?.[country]?.[stateIndex]?.cities?.[cityIndex];
      if (!city) return res.status(400).json({ success: false, error: "city not found" });
      
      if (name !== undefined) city.name = name;
      if (lat !== undefined) city.lat = lat;
      if (lon !== undefined) city.lon = lon;
      if (link !== undefined) city.link = link;

      writeData(data);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/city/delete", checkAdminToken, (req, res) => {
    try {
      const { model, country, stateIndex, cityIndex } = JSON.parse(req.body || '{}');
      
      if (!model || !country || stateIndex === undefined || cityIndex === undefined) {
        return res.status(400).json({ success: false, error: "missing params" });
      }

      const data = readData();
      const state = data[model]?.countries?.[country]?.[stateIndex];
      if (!state || !state.cities) return res.status(400).json({ success: false, error: "state not found" });

      state.cities.splice(cityIndex, 1);
      writeData(data);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // debug geo
  app.get("/api/debug-geo", checkAdminToken, async (req, res) => {
    const ip = req.query.ip || getClientIp(req);
    const g = ip ? await getIpGeo(ip) : null;
    res.json({ ip, geo: g });
  });
}

// -------------------------------
// GEO REDIRECT BY MODEL - This comes LAST to avoid conflicts
// -------------------------------
app.get("/:model", async (req, res) => {
  try {
    const modelKey = req.params.model;
    const data = readData();
    const model = data[modelKey];

    if (!model || !model.default_link) {
      console.warn("Model not found:", modelKey);
      return res.status(404).send("Model not found");
    }

    const ip = req.query.testip || getClientIp(req);
    const geo = await getIpGeo(ip);

    console.log("Model:", modelKey);
    console.log("Visitor IP:", ip);
    console.log("Geo:", geo);

    // If no geo data or no countries, use default link
    if (!geo || !geo.latitude || !geo.longitude || !model.countries) {
      console.log("Using default link:", model.default_link);
      return res.redirect(model.default_link);
    }

    const lat = parseFloat(geo.latitude);
    const lon = parseFloat(geo.longitude);

    if (!isFinite(lat) || !isFinite(lon)) {
      console.warn("Invalid lat/lon");
      return res.redirect(model.default_link);
    }

    const country = geo.country_code?.toUpperCase();
    const countrySections = model.countries[country];

    if (!countrySections || !Array.isArray(countrySections)) {
      console.warn("Country not found in model:", country);
      return res.redirect(model.default_link);
    }

    // Find nearest city across all states
    let nearest = null;
    let bestDist = Infinity;

    for (const state of countrySections) {
      if (!Array.isArray(state.cities)) continue;
      
      for (const city of state.cities) {
        if (city.lat === undefined || city.lon === undefined || city.lat === null || city.lon === null) continue;
        if (city.lat === '' || city.lon === '') continue;

        const d = haversineKm(lat, lon, Number(city.lat), Number(city.lon));
        if (d < bestDist) {
          nearest = city;
          bestDist = d;
        }
      }
    }

    // Determine final link
    let finalLink = model.default_link;
    
    if (nearest) {
      if (nearest.link && nearest.link.trim() !== '') {
        finalLink = nearest.link;
        console.log("Redirect to custom link →", nearest.name, finalLink, `(${bestDist.toFixed(2)} km)`);
      } else {
        console.log("Redirect to default link (nearest city has no custom link) →", nearest.name, finalLink, `(${bestDist.toFixed(2)} km)`);
      }
    } else {
      console.log("No valid city found → default link:", finalLink);
    }

    return res.redirect(finalLink);

  } catch (err) {
    console.error("Redirect error:", err);
    const data = readData();
    const model = data[req.params.model];
    if (model && model.default_link) {
      return res.redirect(model.default_link);
    }
    return res.status(500).send("Error");
  }
});

app.listen(PORT, () =>
  console.log(`Geo Redirector running on port ${PORT}`)
);