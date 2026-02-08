import express from "express";

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;

const {
  MFB_CLIENT_ID,
  MFB_CLIENT_SECRET,
  MFB_REFRESH_TOKEN,
  MFB_TOKEN_URL,
  MFB_RESOURCE_URL, // 必须是 .../logbook/mvc/oAuth/OAuthResource
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

app.get("/health", (_req, res) => res.json({ ok: true, v: "v4-clean" }));

app.get("/oauth/check", async (_req, res) => {
  try {
    const t = await getAccessToken();
    res.json({
      ok: true,
      access_token: redact(t),
      expiresAt: new Date(cached.expMs).toISOString(),
      resourceUrlConfigured: !!MFB_RESOURCE_URL,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/**
 * POST /mfb/pending
 * Body: MyFlightbook flight JSON (先传 {} 测通路由也行)
 */
app.post("/mfb/pending", async (req, res) => {
  try {
    must("MFB_RESOURCE_URL", MFB_RESOURCE_URL);

    const accessToken = await getAccessToken();

    // ✅ TestBed: POST .../OAuthResource/CreatePendingFlight
    const base = MFB_RESOURCE_URL.replace(/\/+$/, "");
    const endpoint = `${base}/CreatePendingFlight`;

    // 我们允许你两种发法：
    // A) 你直接发 { ...flight fields... }
    // B) 你发 { le: { ...flight fields... } }
    const leObj =
      req.body && typeof req.body === "object" && req.body !== null && Object.prototype.hasOwnProperty.call(req.body, "le")
        ? req.body.le
        : (req.body ?? {});

    // ✅ 关键：MyFlightbook 这里要的 le 是“参数”，不是 JSON body 字段
    const form = new URLSearchParams();
    form.set("le", JSON.stringify(leObj));
    form.set("json", "1"); // 让它尽量返回 json（如果支持）

    const mfbResp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: form.toString(),
    });

    const text = await mfbResp.text();

    if (!mfbResp.ok) {
      return res.status(mfbResp.status).json({
        ok: false,
        status: mfbResp.status,
        error: text,
        hint: "如果不再提示 le missing，而开始提示缺字段/格式错误，说明参数传对了。",
      });
    }

    // MyFlightbook 可能返回 JSON 或 HTML/XML，这里都兜底返回
    try {
      return res.json({ ok: true, result: JSON.parse(text) });
    } catch {
      return res.json({ ok: true, result: text });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});


app.listen(PORT, () => console.log(`Listening on ${PORT}`));
