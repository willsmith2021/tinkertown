// Tinkertown — Cloudflare Pages "_worker.js"
// Serves the game, the name-voice helper (/api/name) and the admin panel (/admin).
//
// Required settings (Cloudflare Pages project -> Settings):
//   KV namespace binding:  TT                    (stores encrypted key, settings, made names)
//   Secret:  MASTER_KEY          32 random bytes, base64  (Mac Terminal:  openssl rand -base64 32)
//   Variable: ADMIN_EMAIL        rishubhteotia007@gmail.com
//   Variable: ACCESS_TEAM_DOMAIN e.g. yourteam.cloudflareaccess.com
//   Variable: ACCESS_AUD         the "Application Audience (AUD) Tag" of the Access app protecting /admin
//
// Security model
//   * /admin and /admin/api/* answer ONLY when Cloudflare Access has signed the visitor in
//     (email code + authenticator app) AND the signed token says the email is ADMIN_EMAIL.
//     The token's signature is checked here too, so the panel stays shut even if the Access
//     rule is ever removed by mistake ("fail closed").
//   * The ElevenLabs key is encrypted with AES-256-GCM using MASTER_KEY before it is stored.
//     It is never sent back to any browser - the panel only shows the last 4 characters.
//   * /api/name only makes NEW clips up to a daily limit; names made before are served from storage.

const VOICE_ID = "L2s8m9SlLFEtvsBA4vSf";   // Kiara - same Indian-English voice as Tara
const MODEL_ID = "eleven_multilingual_v2";
const KINDS = {
  hello:  n => `Hello, ${n}! I am Tara. Welcome to Tinkertown!`,
  cheer1: n => `Yay, ${n}! You did it!`,
  cheer2: n => `Well done, ${n}!`,
  cheer3: n => `Super, ${n}! You are a star!`,
};
const DEFAULT_CFG = { enabled: true, dailyLimit: 10, perDeviceLimit: 3 };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === "/api/name") return await nameEndpoint(request, env, url);
      if (p === "/admin" || p === "/admin/" || p.startsWith("/admin/")) return await adminRouter(request, env, url);
    } catch (e) {
      return json({ error: "Something went wrong" }, 500);
    }
    if (p === "/_worker.js") return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);   // the game itself
  },
};

/* ------------------------------------------------------------------ helpers */
const SEC = { "Strict-Transport-Security": "max-age=31536000; includeSubDomains", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const json = (o, status = 200, extra = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...SEC, ...extra } });
const text = (t, status) => new Response(t, { status, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", ...SEC } });
const audioResp = buf => new Response(buf, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400", ...SEC } });
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
async function sha256(s) { return b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
const today = () => new Date().toISOString().slice(0, 10);
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64url = s => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));

function cleanName(raw) {
  const n = String(raw || "").normalize("NFC").trim().replace(/\s+/g, " ");
  if (!n || n.length > 20 || !/^[\p{L}\p{M}' -]+$/u.test(n)) return null;
  return n.replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
}
function cleanSay(raw) {
  const n = String(raw || "").normalize("NFC").trim().replace(/\s+/g, " ");
  if (!n) return "";
  if (n.length > 30 || !/^[\p{L}\p{M}' -]+$/u.test(n)) return null;
  return n;
}
/* Latin spelling of an Indian name -> Hindi script, so the voice says it the Indian way
   ("Manik" -> "मनिक", "Aarav" -> "आरव", "Riya" -> "रिया"). Names already in another script are kept. */
const TV = [["aa","ा","आ"],["ai","ै","ऐ"],["au","ौ","औ"],["ee","ी","ई"],["ii","ी","ई"],["oo","ू","ऊ"],["uu","ू","ऊ"],
  ["a","","अ"],["i","ि","इ"],["u","ु","उ"],["e","े","ए"],["o","ो","ओ"]];
const TC = [["ksh","क्ष"],["chh","छ"],["ch","च"],["sh","श"],["kh","ख"],["gh","घ"],["th","थ"],["dh","ध"],["ph","फ"],
  ["bh","भ"],["jh","झ"],["k","क"],["g","ग"],["c","क"],["j","ज"],["t","त"],["d","द"],["n","न"],["p","प"],["b","ब"],
  ["m","म"],["y","य"],["r","र"],["l","ल"],["v","व"],["w","व"],["s","स"],["h","ह"],["f","फ़"],["z","ज़"],["q","क"],["x","क्स"]];
function toHindi(name) {
  if (!/^[A-Za-z' -]+$/.test(name)) return name;
  return name.split(/([ -])/).map(word => {
    const w = word.toLowerCase().replace(/'/g, "");
    if (!/^[a-z]+$/.test(w)) return word;
    let out = "", prevC = false, i = 0;
    while (i < w.length) {
      const v = TV.find(([l]) => w.startsWith(l, i));
      if (v) {
        const [l, mark, ind] = v;
        const last = i + l.length === w.length;
        out += prevC ? ((l === "a" && last && w.length > 2) ? "ा" : (l === "i" && last) ? "ी" : mark) : ind;
        prevC = false; i += l.length; continue;
      }
      const c = TC.find(([l]) => w.startsWith(l, i));
      if (w[i] === "y" && prevC && i + 1 === w.length) { out += "ी"; prevC = false; i++; continue; }   // Avy, Mary
      if (c) { if (prevC) out += "्"; out += c[1]; prevC = true; i += c[0].length; continue; }
      i++;
    }
    return out;
  }).join("");
}
async function getCfg(env) { return { ...DEFAULT_CFG, ...(JSON.parse((await env.TT.get("cfg")) || "{}")) }; }
async function getNames(env) { return JSON.parse((await env.TT.get("names")) || "[]"); }

/* ---- AES-256-GCM encryption of the ElevenLabs key ---- */
async function masterKey(env) {
  if (!env.MASTER_KEY) throw new Error("MASTER_KEY missing");
  const raw = unb64(env.MASTER_KEY);
  if (raw.length !== 32) throw new Error("MASTER_KEY must be 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function saveApiKey(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await masterKey(env), new TextEncoder().encode(plain));
  await env.TT.put("ek", JSON.stringify({ iv: b64(iv), ct: b64(ct), last4: plain.slice(-4), at: new Date().toISOString() }));
}
async function loadApiKey(env) {
  const rec = JSON.parse((await env.TT.get("ek")) || "null");
  if (!rec) return null;
  try {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(rec.iv) }, await masterKey(env), unb64(rec.ct));
  return new TextDecoder().decode(pt);
  } catch (e) { return null; }   // wrong/rotated MASTER_KEY or tampered record -> treat as "no key"
}

/* ---- ElevenLabs ---- */
async function makeClip(env, kind, spoken) {
  const key = await loadApiKey(env);
  if (!key) return { error: "No ElevenLabs key saved yet" };
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text: KINDS[kind](spoken), model_id: MODEL_ID,
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.45, use_speaker_boost: true } }),
  });
  if (!r.ok) return { error: `ElevenLabs said ${r.status}: ${(await r.text()).slice(0, 200)}` };
  return { audio: await r.arrayBuffer() };
}

/* ------------------------------------------------------------ /api/name (game) */
async function nameEndpoint(request, env, url) {
  if (request.method !== "GET") return text("Method not allowed", 405);
  // Only the game page itself may call this (browsers send Sec-Fetch-Site; other sites get "cross-site").
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin") return text("Not allowed", 403);

  const name = cleanName(url.searchParams.get("n"));
  const kind = url.searchParams.get("k");
  if (!name || !Object.prototype.hasOwnProperty.call(KINDS, kind)) return text("Bad request", 400);

  const say = cleanSay(url.searchParams.get("s"));
  if (say === null) return text("Bad request", 400);
  const spoken = say || toHindi(name);
  const id = `${name.toLowerCase()}|${spoken}`;
  const audioKey = `audio2:${kind}:${id}`;
  const stored = await env.TT.get(audioKey, "arrayBuffer");
  if (stored) return audioResp(stored);

  const cfg = await getCfg(env);
  if (!cfg.enabled) return text("Name voices are switched off", 503);

  // daily limit counts NEW names (all 4 clips of one name = 1)
  const names = await getNames(env);
  const isNewName = !names.some(x => `${x.name.toLowerCase()}|${x.spoken || ""}` === id);
  const ck = `count:${today()}`;
  const used = parseInt((await env.TT.get(ck)) || "0", 10);
  if (isNewName && used >= cfg.dailyLimit) return text("Daily limit reached", 429);
  // one device can only add a few new names a day (IP is stored only as a salted hash, deleted after 2 days)
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const dk = `dev:${today()}:${(await sha256(ip + "|" + env.MASTER_KEY)).slice(0, 22)}`;
  const devUsed = parseInt((await env.TT.get(dk)) || "0", 10);
  if (isNewName && devUsed >= cfg.perDeviceLimit) return text("Daily limit reached", 429);

  const out = await makeClip(env, kind, spoken);
  if (out.error) return text("Voice service unavailable", 502);
  await env.TT.put(audioKey, out.audio);
  if (isNewName) {
    names.unshift({ name, spoken, at: new Date().toISOString() });
    await env.TT.put("names", JSON.stringify(names.slice(0, 500)));
    await env.TT.put(ck, String(used + 1), { expirationTtl: 60 * 60 * 48 });
    await env.TT.put(dk, String(devUsed + 1), { expirationTtl: 60 * 60 * 48 });
  }
  return audioResp(out.audio);
}

/* ------------------------------------------------------------ admin: auth */
let CERTS = null, CERTS_AT = 0;
async function adminEmail(request, env) {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt || !env.ACCESS_AUD || !env.ADMIN_EMAIL) return null;
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(String(env.ACCESS_TEAM_DOMAIN || ""))) return null;   // only ever trust Cloudflare's own key server
  if (jwt.length > 8192) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = JSON.parse(new TextDecoder().decode(b64url(parts[0]))); payload = JSON.parse(new TextDecoder().decode(b64url(parts[1]))); } catch (e) { return null; }
  if (header.alg !== "RS256" || !header.kid) return null;
  if (!CERTS || Date.now() - CERTS_AT > 3600e3) {
    const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    CERTS = (await r.json()).keys; CERTS_AT = Date.now();
  }
  const jwk = (CERTS || []).find(k => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) { CERTS = null; return null; }   // keys rotate - fetch fresh ones next time
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (!(payload.exp > now) || (payload.nbf && payload.nbf > now + 60) || (payload.iat && payload.iat > now + 60)) return null;
  if (String(payload.iss || "").replace(/\/$/, "") !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  const email = String(payload.email || "").toLowerCase();
  return email === String(env.ADMIN_EMAIL).toLowerCase() ? email : null;
}

/* ------------------------------------------------------------ admin: routes */
async function adminRouter(request, env, url) {
  const email = await adminEmail(request, env);
  if (!email) return text("Admin only. Sign in through Cloudflare Access.", 403);

  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
    const csp = `default-src 'none'; connect-src 'self'; img-src 'self'; media-src blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
    return new Response(ADMIN_HTML.replace("%EMAIL%", escHtml(email)).replace("%NONCE%", nonce),
      { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": csp, ...SEC } });
  }

  if (!url.pathname.startsWith("/admin/api/")) return text("Not found", 404);
  // CSRF guard: every admin API call must carry the panel's own header AND come from this same site
  if (request.headers.get("X-TT-Admin") !== "1") return json({ error: "Bad request" }, 400);
  const fs = request.headers.get("Sec-Fetch-Site");
  if (fs && fs !== "same-origin") return json({ error: "Bad request" }, 400);
  if (request.method === "POST" && !(request.headers.get("Content-Type") || "").startsWith("application/json")) return json({ error: "Bad request" }, 400);
  if (Number(request.headers.get("Content-Length") || 0) > 4096) return json({ error: "Too large" }, 413);
  const route = url.pathname.slice("/admin/api/".length);
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

  if (route === "status" && request.method === "GET") {
    const rec = JSON.parse((await env.TT.get("ek")) || "null");
    const readable = rec ? !!(await loadApiKey(env)) : false;
    return json({ email, cfg: await getCfg(env), key: rec ? { last4: rec.last4, at: rec.at, readable } : null,
      usedToday: parseInt((await env.TT.get(`count:${today()}`)) || "0", 10), names: await getNames(env),
      masterKeyOk: !!env.MASTER_KEY && unb64(env.MASTER_KEY).length === 32 });
  }
  if (route === "key" && request.method === "POST") {
    const k = String(body.key || "").trim();
    if (k.length < 20 || k.length > 200 || !/^[A-Za-z0-9_\-]+$/.test(k)) return json({ error: "That doesn't look like an ElevenLabs key" }, 400);
    await saveApiKey(env, k);
    return json({ ok: true });
  }
  if (route === "key-delete" && request.method === "POST") { await env.TT.delete("ek"); return json({ ok: true }); }
  if (route === "settings" && request.method === "POST") {
    const cfg = await getCfg(env);
    if (typeof body.enabled === "boolean") cfg.enabled = body.enabled;
    if (Number.isFinite(body.dailyLimit)) cfg.dailyLimit = Math.max(0, Math.min(200, Math.round(body.dailyLimit)));
    if (Number.isFinite(body.perDeviceLimit)) cfg.perDeviceLimit = Math.max(0, Math.min(50, Math.round(body.perDeviceLimit)));
    await env.TT.put("cfg", JSON.stringify(cfg));
    return json({ ok: true, cfg });
  }
  if (route === "test" && request.method === "POST") {
    const name = cleanName(body.name);
    if (!name) return json({ error: "Use letters only, up to 20" }, 400);
    const say = cleanSay(body.say);
    if (say === null) return json({ error: "Say-it-like: letters only, up to 30" }, 400);
    const out = await makeClip(env, "cheer1", say || toHindi(name));
    if (out.error) return json({ error: out.error }, 502);
    return new Response(out.audio, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", ...SEC } });
  }
  if (route === "name-delete" && request.method === "POST") {
    const name = cleanName(body.name);
    if (!name) return json({ error: "Bad name" }, 400);
    const lower = name.toLowerCase();
    const old = Object.keys(KINDS).map(k => `audio:${k}:${lower}`);
    const made = [];
    for (const k of Object.keys(KINDS)) {
      const ls = await env.TT.list({ prefix: `audio2:${k}:${lower}|` });
      ls.keys.forEach(x => made.push(x.name));
    }
    await Promise.all([...old, ...made].map(k => env.TT.delete(k)));
    const names = (await getNames(env)).filter(x => x.name.toLowerCase() !== name.toLowerCase());
    await env.TT.put("names", JSON.stringify(names));
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}

/* ------------------------------------------------------------ admin page */
const ADMIN_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Tinkertown Admin</title>
<style>
 body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#F3F5FA;color:#2B2D42}
 header{background:#7B3FE4;color:#fff;padding:18px 22px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
 header h1{margin:0;font-size:22px} header span{opacity:.85;font-size:14px}
 main{max-width:860px;margin:0 auto;padding:18px;display:grid;gap:16px}
 .card{background:#fff;border-radius:16px;padding:18px 20px;box-shadow:0 2px 0 #0001}
 h2{margin:0 0 10px;font-size:18px} p.note{margin:4px 0 12px;font-size:14px;color:#5b6075}
 input[type=text],input[type=password],input[type=number]{font:inherit;padding:10px 12px;border:2px solid #DDE3EE;border-radius:10px;width:100%;box-sizing:border-box}
 button{font:inherit;font-weight:700;border:none;border-radius:999px;padding:10px 16px;cursor:pointer;background:#7B3FE4;color:#fff}
 button.ghost{background:#EEF2F8;color:#2B2D42} button.danger{background:#FFE8EC;color:#C1121F}
 .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}
 .pill{display:inline-block;padding:4px 10px;border-radius:999px;font-size:13px;font-weight:700}
 .ok{background:#E3F8EA;color:#1F7A3D} .warn{background:#FFF3D6;color:#8A5A00} .bad{background:#FFE8EC;color:#C1121F}
 table{width:100%;border-collapse:collapse;font-size:14px} td,th{padding:8px 6px;border-bottom:1px solid #EEF1F6;text-align:left}
 .switch{display:flex;align-items:center;gap:10px;font-weight:700}
 #msg{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:#2B2D42;color:#fff;padding:10px 16px;border-radius:12px;opacity:0;transition:.3s}
</style></head><body>
<header><h1>🏗️ Tinkertown Admin</h1><span>Signed in as %EMAIL% · <a style="color:#fff" href="/cdn-cgi/access/logout">Sign out</a></span></header>
<main>
 <div class="card"><h2>ElevenLabs key</h2>
  <p class="note">Stored encrypted (AES-256). It can never be shown again - you can only replace or remove it.</p>
  <div id="keystate"></div>
  <div class="row"><input id="key" type="password" autocomplete="off" placeholder="Paste a new ElevenLabs API key"></div>
  <div class="row"><button id="savekey">Save key</button><button class="danger" id="delkey">Remove key</button></div>
 </div>
 <div class="card"><h2>Name voices</h2>
  <div class="row switch"><input type="checkbox" id="enabled" style="width:22px;height:22px"> <label for="enabled">Tara says children's names</label></div>
  <div class="row"><label for="limit" style="font-weight:700">New names allowed per day (all devices)</label><input id="limit" type="number" min="0" max="200" style="width:110px"></div>
  <div class="row"><label for="dlimit" style="font-weight:700">New names per day from one device</label><input id="dlimit" type="number" min="0" max="50" style="width:110px"><button class="ghost" id="savecfg">Save</button></div>
  <p class="note" id="usage"></p>
 </div>
 <div class="card"><h2>Test the voice</h2>
  <p class="note">Hear Tara say "Yay, ___! You did it!" before a child does. Uses a few credits.</p>
  <div class="row"><input id="tname" type="text" maxlength="20" placeholder="e.g. Aarav" style="max-width:200px"><input id="tsay" type="text" maxlength="30" placeholder="say it like (optional)" style="max-width:200px"><button id="test">▶ Play</button></div>
 </div>
 <div class="card"><h2>Names made so far</h2>
  <p class="note">Remove a name to make Tara record it again next time (for example if it sounded wrong).</p>
  <table><thead><tr><th>Name</th><th>Made on</th><th></th></tr></thead><tbody id="names"></tbody></table>
 </div>
</main><div id="msg"></div>
<script nonce="%NONCE%">
const $=id=>document.getElementById(id);
const api=(path,body)=>fetch('/admin/api/'+path,body===undefined?{headers:{'X-TT-Admin':'1'},credentials:'same-origin'}:{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-TT-Admin':'1'},body:JSON.stringify(body)});
function toast(t){const m=$('msg');m.textContent=t;m.style.opacity=1;setTimeout(()=>m.style.opacity=0,2500);}
const escHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function load(){
  const r=await api('status'); if(!r.ok){toast('Could not load');return;} const s=await r.json();
  $('keystate').innerHTML = !s.masterKeyOk ? '<span class="pill bad">MASTER_KEY secret is missing or wrong - set it in Cloudflare first</span>'
    : s.key && !s.key.readable ? '<span class="pill bad">Saved key can no longer be unlocked (MASTER_KEY changed) - save the key again</span>'
    : s.key ? '<span class="pill ok">Key saved ••••'+escHtml(s.key.last4)+'</span> <span class="note">since '+new Date(s.key.at).toLocaleString()+'</span>'
    : '<span class="pill warn">No key saved yet</span>';
  $('enabled').checked=s.cfg.enabled; $('limit').value=s.cfg.dailyLimit; $('dlimit').value=s.cfg.perDeviceLimit;
  $('usage').textContent='New names made today: '+s.usedToday+' of '+s.cfg.dailyLimit+'.';
  $('names').innerHTML = s.names.length ? s.names.map(n=>'<tr><td>'+escHtml(n.name)+(n.spoken&&n.spoken!==n.name?' <span class="note">('+escHtml(n.spoken)+')</span>':'')+'</td><td>'+new Date(n.at).toLocaleDateString()+'</td><td><button class="danger" data-n="'+escHtml(n.name)+'">Remove</button></td></tr>').join('')
    : '<tr><td colspan="3" class="note">No names yet.</td></tr>';
  document.querySelectorAll('[data-n]').forEach(b=>b.onclick=async()=>{ if(!confirm('Remove '+b.dataset.n+'?'))return; await api('name-delete',{name:b.dataset.n}); toast('Removed'); load(); });
}
$('savekey').onclick=async()=>{const k=$('key').value.trim(); if(!k)return; const r=await api('key',{key:k}); const j=await r.json(); $('key').value=''; toast(j.ok?'Key saved and encrypted':j.error); load();};
$('delkey').onclick=async()=>{ if(!confirm('Remove the ElevenLabs key? Name voices stop until a new key is saved.'))return; await api('key-delete',{}); toast('Key removed'); load(); };
$('enabled').onchange=async()=>{await api('settings',{enabled:$('enabled').checked}); toast($('enabled').checked?'Name voices ON':'Name voices OFF');};
$('savecfg').onclick=async()=>{await api('settings',{dailyLimit:Number($('limit').value),perDeviceLimit:Number($('dlimit').value)}); toast('Saved'); load();};
$('test').onclick=async()=>{ const n=$('tname').value.trim(); if(!n)return; $('test').disabled=true;
  const r=await api('test',{name:n,say:$('tsay').value.trim()}); $('test').disabled=false;
  if(!r.ok){ const j=await r.json().catch(()=>({})); toast(j.error||'Test failed'); return; }
  new Audio(URL.createObjectURL(await r.blob())).play(); };
load();
</script></body></html>`;
