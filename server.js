import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
app.use(bodyParser.json({ limit: "3mb" }));

const PORT = process.env.PORT || 3000;
const MFB_AUTH_TOKEN = process.env.MFB_AUTH_TOKEN; // MyFlightbook szAuthUserToken
if (!MFB_AUTH_TOKEN) {
  console.error("Missing env MFB_AUTH_TOKEN (MyFlightbook szAuthUserToken)");
  process.exit(1);
}

// ---- Offline airport coords ----
const AIRPORT_DB_PATH = "./airports.json";
let AIRPORTS = {};
try {
  AIRPORTS = JSON.parse(fs.readFileSync(AIRPORT_DB_PATH, "utf8"));
} catch {
  console.error(`Cannot read ${AIRPORT_DB_PATH}. Create it with ICAO->lat/lon mapping.`);
  process.exit(1);
}

function escapeXml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function toTitleCase(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function deg2rad(d) { return (d * Math.PI) / 180; }
function rad2deg(r) { return (r * 180) / Math.PI; }

// ---- Great-circle interpolation (slerp) between two lat/lon ----
function slerpLatLon(lat1, lon1, lat2, lon2, f) {
  // Convert to radians
  const φ1 = deg2rad(lat1), λ1 = deg2rad(lon1);
  const φ2 = deg2rad(lat2), λ2 = deg2rad(lon2);

  // Convert to 3D unit vectors
  const x1 = Math.cos(φ1) * Math.cos(λ1);
  const y1 = Math.cos(φ1) * Math.sin(λ1);
  const z1 = Math.sin(φ1);

  const x2 = Math.cos(φ2) * Math.cos(λ2);
  const y2 = Math.cos(φ2) * Math.sin(λ2);
  const z2 = Math.sin(φ2);

  // Angle between vectors
  const dot = clamp(x1 * x2 + y1 * y2 + z1 * z2, -1, 1);
  const ω = Math.acos(dot);

  if (ω < 1e-10) return { lat: lat1, lon: lon1 };

  const sinω = Math.sin(ω);
  const a = Math.sin((1 - f) * ω) / sinω;
  const b = Math.sin(f * ω) / sinω;

  const x = a * x1 + b * x2;
  const y = a * y1 + b * y2;
  const z = a * z1 + b * z2;

  // Back to lat/lon
  const φ = Math.atan2(z, Math.sqrt(x * x + y * y));
  const λ = Math.atan2(y, x);

  return { lat: rad2deg(φ), lon: rad2deg(λ) };
}

// ---- Solar altitude (NOAA-style approximation) ----
// Returns sun altitude in degrees for given UTC Date and location.
function solarAltitudeDeg(dateUTC, latDeg, lonDeg) {
  // Julian Day
  const ms = dateUTC.getTime();
  const jd = ms / 86400000 + 2440587.5;

  const T = (jd - 2451545.0) / 36525.0;

  // Geom mean longitude, anomaly of Sun (deg)
  let L0 = 280.46646 + T * (36000.76983 + 0.0003032 * T);
  L0 = ((L0 % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);

  // Eccentricity of Earth's orbit
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);

  // Sun equation of center
  const Mrad = deg2rad(M);
  const C =
    Math.sin(Mrad) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mrad) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mrad) * 0.000289;

  const trueLong = L0 + C; // deg

  // Apparent longitude (deg)
  const Ω = 125.04 - 1934.136 * T;
  const λ = trueLong - 0.00569 - 0.00478 * Math.sin(deg2rad(Ω));

  // Mean obliquity & corrected obliquity
  const ε0 =
    23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const ε = ε0 + 0.00256 * Math.cos(deg2rad(Ω));

  // Sun declination (deg)
  const δ = rad2deg(
    Math.asin(Math.sin(deg2rad(ε)) * Math.sin(deg2rad(λ)))
  );

  // Equation of time (minutes)
  const y = Math.tan(deg2rad(ε) / 2);
  const y2 = y * y;

  const L0rad = deg2rad(L0);
  const sin2L0 = Math.sin(2 * L0rad);
  const sinM = Math.sin(Mrad);
  const cos2L0 = Math.cos(2 * L0rad);
  const sin4L0 = Math.sin(4 * L0rad);
  const sin2M = Math.sin(2 * Mrad);

  const Etime =
    4 * rad2deg(
      y2 * sin2L0 -
      2 * e * sinM +
      4 * e * y2 * sinM * cos2L0 -
      0.5 * y2 * y2 * sin4L0 -
      1.25 * e * e * sin2M
    );

  // True solar time (minutes)
  const utcMinutes =
    dateUTC.getUTCHours() * 60 + dateUTC.getUTCMinutes() + dateUTC.getUTCSeconds() / 60;
  const trueSolarTime = (utcMinutes + Etime + 4 * lonDeg) % 1440;

  // Hour angle (deg)
  const ha = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;

  // Solar zenith
  const latRad = deg2rad(latDeg);
  const δRad = deg2rad(δ);
  const haRad = deg2rad(ha);

  const cosZenith =
    Math.sin(latRad) * Math.sin(δRad) + Math.cos(latRad) * Math.cos(δRad) * Math.cos(haRad);

  const zenith = rad2deg(Math.acos(clamp(cosZenith, -1, 1)));
  const altitude = 90 - zenith;

  return altitude;
}

function parseZuluHHMM(text, label) {
  // label e.g. "OUT" "IN" "OFF" "ON"
  // Matches: OUT 0414Z, OUT 0414, etc.
  const re = new RegExp(`\\b${label}\\s+([0-2]\\d)([0-5]\\d)Z?\\b`, "i");
  const m = text.match(re);
  if (!m) return null;
  return { hh: Number(m[1]), mm: Number(m[2]) };
}

function parseOFP(raw) {
  const text = String(raw || "").replace(/\r/g, "\n");

  const flightNumber = (text.match(/\bCJT\d{3,4}\b/) || [null])[0];

  const dateToken =
    (text.match(/\bDATE[:\s]*([0-3]\d[A-Z]{3}\d{2})\b/) || [null, null])[1] ||
    (text.match(/\b(\d{2}[A-Z]{3}\d{2})\/\d{2}\.\d{2}Z\b/) || [null, null])[1];

  const orig = (text.match(/\bORIG\s+([A-Z]{4})\b/) || [null, null])[1];
  const dest = (text.match(/\bDEST\s+([A-Z]{4})\b/) || [null, null])[1];

  const tail = (text.match(/\bC-[A-Z]{4}\b/) || [null])[0];

  let block =
    (text.match(/\bBLOCK[:\s]+(\d{1,2}(?:\.\d)?)\b/i) || [null, null])[1] ||
    (text.match(/\bBLOCK\s+(\d{1,2}\.\d)\b/i) || [null, null])[1];
  block = block ? Number(block) : null;

  const captainRaw =
    (text.match(/\bCAPTAIN[:\s]+([A-Z][A-Z\s'-]{2,})\b/) || [null, null])[1] || null;
  const foRaw =
    (text.match(/\bFO[:\s]+([A-Z][A-Z\s'-]{2,})\b/) || [null, null])[1] || null;

  const captain = captainRaw ? toTitleCase(captainRaw) : null;
  const fo = foRaw ? toTitleCase(foRaw) : null;

  // Times
  const out = parseZuluHHMM(text, "OUT");
  const inT = parseZuluHHMM(text, "IN");
  const off = parseZuluHHMM(text, "OFF");
  const on = parseZuluHHMM(text, "ON");

  // Date -> ISO yyyy-mm-dd
  let isoDate = null;
  if (dateToken) {
    const dd = dateToken.slice(0, 2);
    const mon = dateToken.slice(2, 5);
    const yy = dateToken.slice(5, 7);
    const months = {
      JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
      JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
    };
    const mm = months[mon];
    if (mm) isoDate = `20${yy}-${mm}-${dd}`;
  }

  const route = orig && dest ? `${orig} ${dest}` : null;

  const commentsParts = [];
  if (flightNumber) commentsParts.push(flightNumber);
  if (orig && dest) commentsParts.push(`${orig}-${dest}`);
  const comments = commentsParts.join(" ");

  return {
    flightNumber,
    isoDate,
    orig,
    dest,
    route,
    tail,
    block,
    captain,
    fo,
    times: { out, in: inT, off, on },
    comments,
  };
}

function makeUtcDate(isoDate, hhmm) {
  // isoDate: YYYY-MM-DD, hhmm: {hh,mm}
  return new Date(`${isoDate}T${String(hhmm.hh).padStart(2, "0")}:${String(hhmm.mm).padStart(2, "0")}:00Z`);
}

function diffMinutesWithMidnightWrap(t1, t2) {
  // t1,t2: Date objects in UTC same nominal date, allow wrap (e.g., OUT 23:50, IN 01:10)
  const m1 = t1.getUTCHours() * 60 + t1.getUTCMinutes();
  const m2 = t2.getUTCHours() * 60 + t2.getUTCMinutes();
  let d = m2 - m1;
  if (d < 0) d += 1440;
  return d;
}

function computeNightHours_BlockInterval(parsed, twilightAltDeg = -6) {
  // Use OUT->IN interval (block), sample each minute along great-circle ORIG->DEST
  const { isoDate, orig, dest, times } = parsed;
  if (!isoDate || !orig || !dest || !times?.out || !times?.in) {
    return { nightHours: null, reason: "Missing OUT/IN or route/date" };
  }
  const a = AIRPORTS[orig];
  const b = AIRPORTS[dest];
  if (!a || !b) {
    return { nightHours: null, reason: `Missing airport coords for ${!a ? orig : dest}` };
  }

  const tOut = makeUtcDate(isoDate, times.out);
  const tIn = makeUtcDate(isoDate, times.in);
  const totalMin = diffMinutesWithMidnightWrap(tOut, tIn);
  if (totalMin <= 0) return { nightHours: 0, reason: "Non-positive block minutes" };

  let nightMin = 0;
  for (let i = 0; i < totalMin; i++) {
    const f = totalMin === 1 ? 0 : i / (totalMin - 1);
    const p = slerpLatLon(a.lat, a.lon, b.lat, b.lon, f);

    const ti = new Date(tOut.getTime() + i * 60000);
    // If we wrapped midnight, Date will advance naturally because we add minutes.
    const alt = solarAltitudeDeg(ti, p.lat, p.lon);
    if (alt < twilightAltDeg) nightMin += 1;
  }

  return { nightHours: Math.round((nightMin / 60) * 10) / 10, reason: "ok" }; // round to 0.1
}

function computeLandingDayNight(parsed, twilightAltDeg = -6) {
  // Decide full-stop day/night using ON time at DEST; fallback to IN if ON missing
  const { isoDate, dest, times } = parsed;
  if (!isoDate || !dest) return { isNightLanding: null, reason: "Missing date/dest" };

  const destCoord = AIRPORTS[dest];
  if (!destCoord) return { isNightLanding: null, reason: `Missing airport coords for ${dest}` };

  const landingHHMM = times?.on || times?.in;
  if (!landingHHMM) return { isNightLanding: null, reason: "Missing ON/IN time" };

  const tLand = makeUtcDate(isoDate, landingHHMM);
  // If landing is after midnight vs OUT date, this will be wrong by 1 day.
  // Practical fix: if OUT exists and landing clock is "earlier", add 1 day.
  if (times?.out) {
    const tOut = makeUtcDate(isoDate, times.out);
    const outMin = tOut.getUTCHours() * 60 + tOut.getUTCMinutes();
    const landMin = tLand.getUTCHours() * 60 + tLand.getUTCMinutes();
    if (landMin < outMin) tLand.setUTCDate(tLand.getUTCDate() + 1);
  }

  const alt = solarAltitudeDeg(tLand, destCoord.lat, destCoord.lon);
  return { isNightLanding: alt < twilightAltDeg, reason: "ok", sunAltDeg: alt };
}

async function createPendingFlight(parsed, pfMode) {
  // Validate essentials
  if (!parsed.isoDate) throw new Error("Missing date");
  if (!parsed.tail) throw new Error("Missing tail (aircraft)");
  if (!parsed.route) throw new Error("Missing route");
  if (!parsed.block) throw new Error("Missing block time");

  // Your rules (Block-based)
  const block = parsed.block;
  const total = block;
  const sic = block; // FO default
  const pic = 0;

  const xc = block;
  const imc = Math.max(Math.round((block - 0.1) * 10) / 10, 0);

  const approaches = 1;
  const landings = 1;

  // Night (B: civil twilight -6°, using OUT->IN interval)
  const nightRes = computeNightHours_BlockInterval(parsed, -6);
  const night = nightRes.nightHours ?? 0;

  // Full stop day/night by landing time at DEST (-6°)
  const landRes = computeLandingDayNight(parsed, -6);
  const fullStopNight = landRes.isNightLanding === true ? 1 : 0;
  const fullStopDay = landRes.isNightLanding === false ? 1 : 0;

  // PF/PM by one-tap selection; times are Block-based
  const mode = pfMode === "PM" ? "PM" : "PF";
  const pfTime = mode === "PF" ? block : 0.0;
  const pmTime = mode === "PM" ? block : 0.0;

  const picName = parsed.captain || "";
  const sicName = parsed.fo || "";

  // NOTE:
  // Exact XML element names for some core fields depend on MyFlightbook's LogbookEntry schema.
  // The ones below are commonly used and match MyFlightbook imports/fields:
  // - CrossCountry, Night, IMC, Landings, FullStopLandings (day), FullStopNightLandings (night), Approaches
  // If your account returns a SOAP fault about unknown fields, we’ll adjust to the exact names from the WSDL response.
  const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <CreatePendingFlight xmlns="http://myflightbook.com/">
      <szAuthUserToken>${escapeXml(MFB_AUTH_TOKEN)}</szAuthUserToken>
      <le>
        <Date>${parsed.isoDate}</Date>
        <TailNumDisplay>${escapeXml(parsed.tail)}</TailNumDisplay>
        <Route>${escapeXml(parsed.route)}</Route>
        <TotalTime>${total}</TotalTime>
        <SIC>${sic}</SIC>
        <PIC>${pic}</PIC>
        <Comments>${escapeXml(parsed.comments || "")}</Comments>

        <CrossCountry>${xc}</CrossCountry>
        <Night>${night}</Night>
        <IMC>${imc}</IMC>

        <Landings>${landings}</Landings>
        <FullStopLandings>${fullStopDay}</FullStopLandings>
        <FullStopNightLandings>${fullStopNight}</FullStopNightLandings>

        <Approaches>${approaches}</Approaches>

        <Properties>
          <FlightProperty>
            <PropTypeID>183</PropTypeID>
            <TextValue>${escapeXml(picName)}</TextValue>
          </FlightProperty>
          <FlightProperty>
            <PropTypeID>184</PropTypeID>
            <TextValue>${escapeXml(sicName)}</TextValue>
          </FlightProperty>
          <FlightProperty>
            <PropTypeID>529</PropTypeID>
            <DecValue>${pfTime}</DecValue>
          </FlightProperty>
          <FlightProperty>
            <PropTypeID>530</PropTypeID>
            <DecValue>${pmTime}</DecValue>
          </FlightProperty>
        </Properties>
      </le>
    </CreatePendingFlight>
  </soap:Body>
</soap:Envelope>`;

  const res = await fetch("https://myflightbook.com/logbook/public/WebService.asmx", {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": "http://myflightbook.com/CreatePendingFlight",
    },
    body: soapEnvelope,
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`MyFlightbook HTTP ${res.status}: ${body.slice(0, 800)}`);

  return {
    soapSnippet: body.slice(0, 300),
    computed: {
      approaches, landings, fullStopDay, fullStopNight,
      xc, night, imc,
      nightReason: nightRes.reason,
      landingReason: landRes.reason,
      landingSunAltDeg: landRes.sunAltDeg ?? null
    }
  };
}

app.post("/ingest", async (req, res) => {
  try {
    const raw = req.body?.raw_text;
    const pfMode = req.body?.pf_mode; // "PF" or "PM"
    if (!raw) return res.status(400).json({ ok: false, error: "Missing raw_text" });

    const parsed = parseOFP(raw);

    // Aviation-safe: require key fields
    const missing = [];
    if (!parsed.isoDate) missing.push("date");
    if (!parsed.tail) missing.push("tail");
    if (!parsed.route) missing.push("route");
    if (!parsed.block) missing.push("block");
    if (!parsed.orig) missing.push("orig");
    if (!parsed.dest) missing.push("dest");
    if (!parsed.times?.out) missing.push("OUT");
    if (!parsed.times?.in) missing.push("IN");

    if (missing.length) {
      return res.status(422).json({ ok: false, error: "ParserMissingFields", missing, parsed });
    }

    // Require airport coords for orig/dest
    if (!AIRPORTS[parsed.orig] || !AIRPORTS[parsed.dest]) {
      return res.status(422).json({
        ok: false,
        error: "MissingAirportCoords",
        missing_airports: [parsed.orig, parsed.dest].filter((c) => !AIRPORTS[c]),
        hint: `Add them to ${AIRPORT_DB_PATH}`,
        parsed
      });
    }

    const result = await createPendingFlight(parsed, pfMode);

    return res.json({
      ok: true,
      pf_mode: pfMode === "PM" ? "PM" : "PF",
      parsed,
      computed: result.computed,
      result: "PendingFlightCreated",
      soapSnippet: result.soapSnippet
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
