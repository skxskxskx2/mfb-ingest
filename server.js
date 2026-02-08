import express from "express";

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;

const {
  MFB_CLIENT_ID,
  MFB_CLIENT_SECRET,
  MFB_REFRESH_TOKEN,
  MFB_TOKEN_URL,
  MFB_RESOURCE_URL,
  MFB_RESOURCE_ACTION, // 例如 AddPendingFlight
} = process.env;

function must(name, v) {
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function redact(s) {
  if (!s) return "";
  return s.length <= 10 ? "****" : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

let cached = { token: null, expMs: 0 };

async function getAccessToken() {
  must("MFB_CLIENT_ID", MFB_CLIENT_ID);
  must("MFB_CLIENT_SECRET", MFB_CLIENT_SECRET);
  must("MFB_REFRESH_TOKEN", MFB_REFRESH_TOKEN);
  must("MFB_TOKEN_URL", MFB_TOKEN_URL);

  const now = Date.now();
  if (cached.token && now < cached.expMs - 60_000) return cached.token;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: MFB_REFRESH_TOKEN,
    client_id: MFB_CLIENT_ID,
    client_secret: MFB_CLIENT_SECRET,
  });

  const resp = await fetch(MFB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Token refresh failed (${resp.status}): ${text}`);

  const data = JSON.parse(text);
  const access = data.access_token || data.authtoken;
  const expiresIn = Number(data.expires_in || 3600);
  if (!access) throw new Error(`No access_token in response: ${text}`);

  cached.token = access;
  cached.expMs = Date.now() + expiresIn * 1000;
  return access;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/oauth/check", async (_req, res) => {
  try {
    const t = await getAccessToken();
    res.json({
      ok: true,
      access_token: redact(t),
      expiresAt: new Date(cached.expMs).toISOString(),
      resourceUrlConfigured: !!MFB_RESOURCE_URL,
      resourceActionConfigured: !!MFB_RESOURCE_ACTION,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ✅ CreatePendingFlight 的正确 URL：/OAuthResource/CreatePendingFlight
const base = MFB_RESOURCE_URL.replace(/\/+$/, "");          // .../OAuthResource
const url = `${base}/CreatePendingFlight?json=1`;           // 固定动作名（别再用 query action）

const accessToken = await getAccessToken();                 // 这是 access_token
// ⚠️ 不要再把 token 放在 url.searchParams 里（不要 authtoken=）

const resp = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Authorization": `Bearer ${accessToken}`,               // ✅ 关键
  },
  body: JSON.stringify(req.body ?? {}),
});



    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(req.body ?? {}),
    });

    const text = await resp.text();
    if (!resp.ok) {
      return res.status(resp.status).json({
        ok: false,
        status: resp.status,
        error: text,
        hint: "Missing access token：确认请求是 /OAuthResource/CreatePendingFlight 且用 Authorization: Bearer <access_token>（不要 authtoken=）",
      });
    }

    try {
      return res.json({ ok: true, result: JSON.parse(text) });
    } catch {
      return res.json({ ok: true, result: text });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));

app.get("/mfb/actions", async (req, res) => {
  try {
    must("MFB_RESOURCE_URL", MFB_RESOURCE_URL);

    const authtoken = await getAccessToken();

    const url = new URL(MFB_RESOURCE_URL);
    url.searchParams.set("authtoken", authtoken);
    url.searchParams.set("json", "1");

    // 不传 action，很多实现会返回支持的 actions 或帮助信息
    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    const text = await resp.text();
    res.status(resp.status).send(text);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

