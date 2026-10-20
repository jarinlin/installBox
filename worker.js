// InstaBox keepalive on Cloudflare Workers — renews activity leases from a cron
// trigger, so no machine of your own has to stay up doing it.
//
// 每 9 分钟续一次 15 分钟的租约。密钥放在 Cloudflare Secret 里：
// INSTABOX_API_KEY、TOKEN、TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID。
//
//   GET /                     续租一次（手动触发，必写一条日志）
//   GET /status               机器状态
//   GET /log                  最近 48 条保活日志（需要 KV 绑定 LOG）
//   GET /release              放掉租约
// 都要带 ?token=...（设了 TOKEN 变量时）；可加 &format=text 看纯文本。
//
// 变量 INSTABOX_LOG_MODE 控制写 KV 的频次（免费额度 1000 次写/天）：
//   hourly（默认）同一小时的连续成功只写 1 条 ≈24 次/天，失败立刻记
//   every  每次续租都写（*/9 = 160 次/天，仍在额度内）
//   off    完全不写 KV，/log 会是空的
//
// 机器被平台挂起（suspended）或停掉时，续租会 409 machine_not_running —— 此时光续租没用，
// 得先唤醒：自动 POST /resume（stopped 的用 /start 兜底）→ 等 running → 再续租。
// INSTABOX_AUTO_RESUME=0 可以关掉这个自愈。
//
// Telegram 默认每小时汇总一次（北京时间），不跟每次续租走。两个 secret：
//   TELEGRAM_BOT_TOKEN  BotFather 给的 token
//   TELEGRAM_CHAT_ID    接收人的 chat id（群是负数）
// INSTABOX_TG_MODE：hourly（默认，上一小时的检测次数和状态）/ every / off
const API_DEFAULT = "https://api.instabox.sh";
const LEASE_DEFAULT = "keepalive";
const TTL_DEFAULT = 300;

function cfg(env) {
  const ttl = Number.parseInt(env.INSTABOX_LEASE_TTL ?? TTL_DEFAULT, 10);
  return {
    api: (env.INSTABOX_API_URL || API_DEFAULT).replace(/\/+$/, ""),
    key: env.INSTABOX_API_KEY || "",
    machine: (env.INSTABOX_MACHINE || "").trim(),
    lease: env.INSTABOX_LEASE || LEASE_DEFAULT,
    ttl: Number.isFinite(ttl) && ttl >= 30 && ttl <= 3600 ? ttl : TTL_DEFAULT,
    kv: env.LOG || null,
    // 被平台挂起后光续租没用，默认自愈：409 machine_not_running → resume/start → 再续租
    autoResume: (env.INSTABOX_AUTO_RESUME ?? "1") !== "0",
    // hourly（默认）：同一小时的“成功”不重复写 KV，省额度；every：每次都写；off：不写
    logMode: (env.INSTABOX_LOG_MODE || "hourly").trim(),
    tgToken: env.TELEGRAM_BOT_TOKEN || "",
    tgChat: (env.TELEGRAM_CHAT_ID || "").trim(),
    tgMode: (env.INSTABOX_TG_MODE || "hourly").trim(),
  };
}

async function call(c, method, path, body) {
  const res = await fetch(c.api + path, {
    method,
    headers: {
      "X-API-Key": c.key,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

// 机器列表：填了名字/id 就那一台，留空=这把 key 名下全部（isolate 内缓存 10 分钟）
let cache = { key: "", list: [], at: 0 };

async function machines(c) {
  const now = Date.now();
  if (cache.key === c.machine && now - cache.at < 600_000) return cache;
  let list = [];
  let detail = "";
  if (c.machine.startsWith("m_")) {
    list = [{ id: c.machine, name: c.machine, state: "" }];
  } else if (c.machine) {
    const r = await call(c, "GET", `/v1/machines/${c.machine}`);
    if (r.ok && r.json?.id) list = [{ id: r.json.id, name: r.json.name || c.machine, state: r.json.state || "" }];
    else detail = listDetail(r);
  } else {
    let cursor = "";
    do {
      const path = "/v1/machines?limit=100" + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const r = await call(c, "GET", path);
      if (!r.ok) {
        detail = listDetail(r);
        break;
      }
      const page = r.json?.machines || [];
      list.push(...page.map((m) => ({ id: m.id, name: m.name, state: m.state || "" })));
      cursor = r.json?.nextCursor || "";
      if (!list.length) detail = listDetail(r);
    } while (cursor);
  }
  cache = { key: c.machine, list, detail, at: now };
  return cache;
}

function listDetail(r) {
  const keys = r.json && typeof r.json === "object" ? Object.keys(r.json).join(",") : "";
  const text = String(r.text || "").replace(/ibk_[A-Za-z0-9_-]+/g, "ibk_…").slice(0, 280);
  return `HTTP ${r.status || 0}${keys ? " keys=" + keys : ""} ${text}`;
}

// 保活日志：绑了 KV（变量名 LOG）就留最近 48 条，没绑也能用，只是 /log 空
// hourly 模式下同一小时的连续成功只写 1 次（KV 免费额度每天 1000 次写），失败照样立刻记
async function logEvent(c, entry, force) {
  if (!c.kv || c.logMode === "off") return;
  try {
    const arr = JSON.parse((await c.kv.get("log")) || "[]");
    const last = arr[0];
    if (!force && c.logMode === "hourly" && entry.ok && last && String(last.at).slice(0, 13) === entry.at.slice(0, 13)) {
      return;
    }
    arr.unshift(entry);
    await c.kv.put("log", JSON.stringify(arr.slice(0, 48)), {
      expirationTtl: 604800,
    });
  } catch (e) {
    console.log("instabox-keepalive: 写日志失败", e.message);
  }
}

const lease = (c, id) =>
  call(c, "PUT", `/v1/machines/${id}/activity-leases/${c.lease}`, { ttlSeconds: c.ttl });

// 409 machine_not_running：机器被平台挂起（suspended）或停掉了，续租对它是无效的
const isNotRunning = (r) =>
  r.status === 409 && /not_running|suspended|stopped/i.test(r.text || "");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// 换状态的写操作要 Idempotency-Key（缺了 400）；key 带时间戳，重试不会撞旧 key
async function act(c, id, type) {
  const res = await fetch(`${c.api}/v1/machines/${id}/${type}`, {
    method: "POST",
    headers: { "X-API-Key": c.key, "Idempotency-Key": `ka-${type}-${id}-${Date.now()}` },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function stateOf(c, id) {
  const r = await call(c, "GET", `/v1/machines/${id}`);
  return r.ok ? r.json?.state || "" : "";
}

// 挂了就先唤醒再续租：resume 优先，stopped 的用 start 兜底；running 后立刻续租一次
async function wakeThenLease(c, m) {
  const wake = [];
  for (const type of ["resume", "start"]) {
    const a = await act(c, m.id, type);
    wake.push(`${type}:${a.status}`);
    if (a.ok) break;
  }
  for (let i = 0; i < 3; i++) {
    await sleep(5000);
    if ((await stateOf(c, m.id)) === "running") {
      const r = await lease(c, m.id);
      return r.ok
        ? { ok: true, resumed: true, expiresAt: r.json?.expiresAt, wake }
        : { ok: false, resumed: true, status: r.status, error: r.text.slice(0, 200), wake };
    }
  }
  return { ok: false, resumed: true, status: 409, error: "已发唤醒，机器还没 running（下一轮再续）", wake };
}

async function keepalive(c, forceLog) {
  if (!c.key) return finish(c, { ok: false, at: new Date().toISOString(), error: "缺 INSTABOX_API_KEY" }, forceLog);
  const found = await machines(c);
  const list = found.list || [];
  if (!list.length) {
    const why = found.detail ? `（${found.detail}）` : "";
    return finish(
      c,
      {
        ok: false,
        at: new Date().toISOString(),
        error: (c.machine ? `找不到机器 ${c.machine}（或 key 没权限）` : "这把 key 名下没有机器") + why,
      },
      forceLog,
    );
  }
  const results = [];
  for (const m of list) {
    const r = await lease(c, m.id);
    const base = { machine: m.name, id: m.id };
    if (r.ok) {
      results.push({ ...base, ok: true, expiresAt: r.json?.expiresAt });
    } else if (c.autoResume && isNotRunning(r)) {
      // 被挂起了：续租是空转，先把它弄醒再续
      results.push({ ...base, ...(await wakeThenLease(c, m)) });
    } else {
      results.push({ ...base, ok: false, status: r.status, error: r.text.slice(0, 200) });
    }
  }
  const out = {
    ok: results.every((r) => r.ok),
    at: new Date().toISOString(),
    lease: c.lease,
    ttl: c.ttl,
    count: results.length,
    machines: results,
  };
  return finish(c, out, forceLog);
}

async function finish(c, out, forceLog) {
  if (out.machines) await logEvent(c, out, forceLog);
  out.telegram = await notifyTelegram(c, out);
  return out;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 到期时间按 UTC+8 显示，和机器所在的使用习惯一致
function expiryText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

function beijingHour(iso) {
  const d = new Date(iso || Date.now());
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}`;
}

function machineLine(m) {
  if (m.ok) {
    const exp = m.expiresAt ? `，到期 ${expiryText(m.expiresAt)}` : "";
    const how = m.resumed ? "唤醒后已续租" : "已续租";
    return `· ${esc(m.machine)} ${how}${exp}`;
  }
  const why = m.error ? esc(String(m.error).slice(0, 120)) : `HTTP ${m.status || "?"}`;
  return `· ${esc(m.machine || "?")} 失败 ${why}`;
}

function currentText(out) {
  const machines = out.machines || [];
  const okCount = machines.filter((m) => m.ok).length;
  const lines = [];
  if (!machines.length) {
    lines.push(out.ok ? "InstaBox 续租成功" : "InstaBox 续租失败");
    if (out.error) lines.push(esc(out.error));
  } else if (out.ok) {
    lines.push(`InstaBox 续租成功 ${okCount} 台`);
  } else {
    lines.push(`InstaBox 续租 ${okCount}/${machines.length} 成功`);
  }
  for (const m of machines) lines.push(machineLine(m));
  return lines.join("\n");
}

function summaryText(bucket) {
  const [date, hh] = String(bucket.hour || "").split(" ");
  const next = String((Number(hh) + 1) % 24).padStart(2, "0");
  const lines = [
    `InstaBox ${date} ${hh}:00–${next}:00`,
    `检测 ${bucket.checks} 次，成功 ${bucket.ok} 次，失败 ${bucket.fail} 次`,
  ];
  const names = Object.keys(bucket.machines || {});
  if (!names.length && bucket.lastError) lines.push(esc(bucket.lastError));
  for (const name of names) {
    const m = bucket.machines[name];
    const total = (m.ok || 0) + (m.fail || 0);
    if (m.lastOk) {
      const exp = m.expiresAt ? `，到期 ${expiryText(m.expiresAt)}` : "";
      const woke = m.resumed ? `，唤醒 ${m.resumed} 次` : "";
      lines.push(`· ${esc(name)} ${m.ok}/${total} 成功${exp}${woke}`);
    } else {
      const why = m.error ? `，${esc(m.error)}` : "";
      lines.push(`· ${esc(name)} ${m.ok}/${total} 成功，最近一次失败${why}`);
    }
  }
  return lines.join("\n");
}

async function sendTelegram(c, text) {
  const res = await fetch(`https://api.telegram.org/bot${c.tgToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: c.tgChat, text, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.log("instabox-keepalive: TG 通知失败", res.status, body.slice(0, 200));
    return "failed";
  }
  return "sent";
}

function emptyBucket(hour) {
  return { hour, checks: 0, ok: 0, fail: 0, machines: {}, lastError: "" };
}

function addCheck(bucket, out) {
  bucket.checks += 1;
  if (out.ok) bucket.ok += 1;
  else bucket.fail += 1;
  const machines = out.machines || [];
  if (!machines.length && out.error) bucket.lastError = String(out.error).slice(0, 200);
  for (const m of machines) {
    const name = m.machine || "?";
    const cur = bucket.machines[name] || { ok: 0, fail: 0, lastOk: false, expiresAt: "", error: "", resumed: 0 };
    if (m.ok) {
      cur.ok += 1;
      cur.lastOk = true;
      cur.expiresAt = m.expiresAt || cur.expiresAt;
      cur.error = "";
    } else {
      cur.fail += 1;
      cur.lastOk = false;
      cur.error = String(m.error || m.status || "").slice(0, 120);
    }
    if (m.resumed) cur.resumed += 1;
    bucket.machines[name] = cur;
  }
}

async function notifyTelegram(c, out) {
  if (!c.tgToken || !c.tgChat || c.tgMode === "off") return "unconfigured";
  if (c.tgMode === "every" || !c.kv) {
    try {
      return await sendTelegram(c, currentText(out));
    } catch (e) {
      console.log("instabox-keepalive: TG 通知失败", e.message);
      return "failed";
    }
  }
  const hour = beijingHour(out.at);
  let bucket = emptyBucket(hour);
  let sent = "recorded";
  try {
    const raw = await c.kv.get("tg:bucket");
    const prev = raw ? JSON.parse(raw) : null;
    if (prev && prev.hour && prev.hour !== hour && prev.checks > 0) {
      try {
        sent = await sendTelegram(c, summaryText(prev));
      } catch (e) {
        console.log("instabox-keepalive: TG 通知失败", e.message);
        sent = "failed";
      }
    } else if (prev && prev.hour === hour) {
      bucket = prev;
    }
  } catch (e) {
    console.log("instabox-keepalive: 读 TG 汇总失败", e.message);
  }
  addCheck(bucket, out);
  try {
    await c.kv.put("tg:bucket", JSON.stringify(bucket), { expirationTtl: 172800 });
  } catch (e) {
    console.log("instabox-keepalive: 写 TG 汇总失败", e.message);
  }
  return sent;
}

export default {
  async scheduled(_event, env, ctx) {
    const out = await keepalive(cfg(env));
    if (out.ok) console.log("instabox-keepalive:", JSON.stringify(out));
    else console.error("instabox-keepalive:", JSON.stringify(out));
    ctx.waitUntil(Promise.resolve());
  },

  async fetch(request, env) {
    const c = cfg(env);
    const url = new URL(request.url);
    const asText = url.searchParams.get("format") === "text";
    if (env.TOKEN && url.searchParams.get("token") !== env.TOKEN) {
      return reply({ ok: false, error: "token 不对" }, 401, asText);
    }

    const route = url.pathname.replace(/\/+$/, "") || "/";

    if (route === "/") {
      const out = await keepalive(c, true);   // 手动触发不给去重，一定出现在 /log
      return reply(out, out.ok ? 200 : 502, asText);
    }

    if (route === "/status") {
      if (!c.key) return reply({ ok: false, error: "缺 INSTABOX_API_KEY" }, 502, asText);
      const found = await machines(c);
      const list = found.list || [];
      if (!list.length) return reply({ ok: false, error: "没有机器", detail: found.detail || "" }, 502, asText);
      const machinesOut = [];
      for (const m of list) {
        const r = await call(c, "GET", `/v1/machines/${m.id}`);
        machinesOut.push(
          r.ok
            ? {
                name: m.name,
                state: r.json?.state,
                autoSuspendAfterSeconds: r.json?.autoSuspendAfterSeconds,
                autoSuspendedAt: r.json?.autoSuspendedAt ?? null,
              }
            : { name: m.name, error: `HTTP ${r.status}` },
        );
      }
      return reply({ ok: true, count: machinesOut.length, machines: machinesOut }, 200, asText);
    }

    if (route === "/log") {
      const raw = c.kv ? await c.kv.get("log") : null;
      const entries = raw ? JSON.parse(raw) : [];
      return reply(
        {
          ok: true,
          storage: c.kv ? "KV 已绑定，保留最近 48 次（7 天）" : "未绑定 KV（变量 LOG），/log 为空",
          count: entries.length,
          entries,
        },
        200,
        asText,
      );
    }

    if (route === "/release") {
      const list = (await machines(c)).list || [];
      const out = [];
      for (const m of list) {
        const r = await call(c, "DELETE", `/v1/machines/${m.id}/activity-leases/${c.lease}`);
        out.push({ machine: m.name, ok: r.ok || r.status === 404, status: r.status });
      }
      const ok = out.length > 0 && out.every((r) => r.ok);
      return reply({ ok, machines: out }, ok ? 200 : 502, asText);
    }

    return reply(
      { ok: false, error: "用 / 续租、/status 状态、/log 日志、/release 放租约" },
      404,
      asText,
    );
  },
};

function reply(body, status, asText) {
  if (asText) {
    const lines = [`ok=${body.ok}`];
    if (body.error) lines.push(`error=${body.error}`);
    for (const m of body.machines || []) {
      lines.push(
        [m.machine || m.name, m.ok === false ? "FAIL" : "ok", m.expiresAt || m.state || m.status || ""]
          .filter(Boolean)
          .join(" "),
      );
    }
    for (const e of body.entries || []) {
      lines.push(`${e.at} ok=${e.ok} 续租 ${e.count} 台`);
    }
    return new Response(lines.join("\n") + "\n", {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
