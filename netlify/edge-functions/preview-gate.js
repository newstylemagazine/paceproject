// Password page for workshop previews. Netlify builds every branch and pull
// request at an address like "deploy-preview-3--<site>.netlify.app"; those
// addresses always contain "--". The live site's address doesn't, so it is
// never affected. The password is the PREVIEW_PASSWORD environment variable.
const COOKIE = "trace_preview";

async function token(secret) {
  const data = new TextEncoder().encode(`${secret}|trace-preview-v1`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function page(message, next, status = 401) {
  const safeNext = next.replace(/[^\w\-./?=&%#]/g, "");
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Trace · workshop preview</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf7f2;font-family:Georgia,serif;color:#1b1b1f}
form{background:#fff;border:1px solid #e6e2dc;border-radius:16px;padding:2rem 2.2rem;width:min(360px,90vw);text-align:center}
h1{font-weight:normal;font-size:1.6rem;margin:.2rem 0 .4rem}p{color:#6b665f;font:15px/1.5 -apple-system,Helvetica,Arial,sans-serif;margin:.2rem 0 1rem}
input{width:100%;box-sizing:border-box;border:1px solid #d9d4cc;border-radius:10px;padding:.75rem;font-size:1rem;margin-bottom:.9rem}
button{background:#c81d33;color:#fff;border:0;border-radius:999px;padding:.7rem 1.6rem;font:700 15px -apple-system,Helvetica,Arial,sans-serif;cursor:pointer}
.err{color:#8c1d2d}</style></head><body>
<form method="post" action="/__preview-login"><h1>Trace</h1><p>Workshop preview. This version isn't public yet.</p>
${message ? `<p class="err">${message}</p>` : ""}
<input type="password" name="password" placeholder="Password" autofocus aria-label="Password">
<input type="hidden" name="next" value="${safeNext}"><button type="submit">Enter</button></form></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } }
  );
}

export default async (request, context) => {
  const url = new URL(request.url);
  if (!url.hostname.includes("--")) return context.next(); // live site: untouched

  const secret = Netlify.env.get("PREVIEW_PASSWORD") || "";
  if (!secret) return page("This preview is locked until a PREVIEW_PASSWORD is set in Netlify.", "/", 503);
  const expected = await token(secret);

  if (url.pathname === "/__preview-login" && request.method === "POST") {
    const form = await request.formData();
    const next = String(form.get("next") || "/site/index.html");
    if (String(form.get("password") || "") !== secret) {
      await new Promise((r) => setTimeout(r, 700));
      return page("That password didn't work.", next);
    }
    context.cookies.set({
      name: COOKIE, value: expected, path: "/", httpOnly: true, secure: true, sameSite: "Lax",
      expires: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });
    return new Response(null, { status: 303, headers: { location: next.startsWith("/") ? next : "/site/index.html" } });
  }

  if (context.cookies.get(COOKIE) === expected) return context.next();
  if (url.pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "Preview login required." }), { status: 401, headers: { "content-type": "application/json" } });
  }
  return page("", url.pathname + url.search);
};

export const config = { path: "/*" };
