// RunningCoach on the phone: the coach's own web app (Python) runs inside this page with Pyodide.
// Links, forms and fetch("/...") go to bridge.handle() in-process instead of a server; the
// database is a file under /data, kept in the browser's IndexedDB. Routes live in the hash
// (#/today), so reloads, the home-screen icon and share links (#/view/...) work on a static host.
"use strict";

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";
const PACKAGES = ["sqlite3", "pydantic", "jinja2", "anyio", "sniffio", "typing-extensions",
                  "annotated-types", "markupsafe", "idna", "micropip"];
const $ = (id) => document.getElementById(id);
const BASE = location.origin + location.pathname;          // …/coach/ : share links point here

let py, bridge, busy = Promise.resolve(), pageListeners = [];

function say(msg) { const m = $("boot-msg"); if (m) m.textContent = msg; }

async function boot() {
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* ok */ }
  say("Loading Python…");
  py = await loadPyodide({ indexURL: PYODIDE });
  const FS = py.FS;
  FS.mkdirTree("/data");
  FS.mount(py.FS.filesystems.IDBFS, {}, "/data");
  await syncfs(true);                                         // IndexedDB -> /data
  say("Loading the coach…");
  await py.loadPackage(PACKAGES);
  const ver = (await (await fetch("version.txt", { cache: "no-cache" })).text()).trim();
  const wheels = (await (await fetch("wheels/list.txt?v=" + ver)).text()).trim().split("\n");
  const micropip = py.pyimport("micropip");
  await micropip.install(wheels.map((w) => new URL("wheels/" + w, BASE).href), { deps: false });
  const zip = await (await fetch("app.zip?v=" + ver)).arrayBuffer();
  FS.mkdirTree("/app");
  py.unpackArchive(zip, "zip", { extractDir: "/app" });
  py.runPython("import sys; sys.path.insert(0, '/app')");
  bridge = py.pyimport("bridge");
  bridge.init(BASE);
  $("boot").hidden = true;
  $("app").hidden = false;
  window.addEventListener("hashchange", () => { if (!navigating) go(route()); });
  await go(route());
}

function syncfs(populate) {
  return new Promise((ok, bad) => py.FS.syncfs(populate, (err) => (err ? bad(err) : ok())));
}

// ------------------------------------------------------------------ requests
// "#/plan" -> "/plan"; "#/view/<payload>" -> "/view?p=<payload>"; "#/me?new=x#share" keeps #share.
function route() {
  const h = location.hash.slice(1) || "/today";
  if (h.startsWith("/view/")) return "/view?p=" + h.slice(6);
  return h;
}

function split(url) {
  const [pathq, frag] = url.split("#", 2);
  const [path, query] = pathq.split("?", 2);
  return { path: path || "/", query: query || "", frag: frag || "" };
}

async function request(method, url, body, ctype) {
  const u = split(url);
  const res = await bridge.handle(method, u.path, u.query, body || "", ctype || "");
  const [status, headers, data] = res.toJs();
  res.destroy();
  return { status, headers: headers instanceof Map ? Object.fromEntries(headers) : headers, data };
}

// Requests run one at a time (Python is single-threaded) and the database is saved after each.
function queued(fn) {
  const p = busy.then(fn, fn);
  busy = p.catch(() => {});
  return p;
}

let navigating = false;

async function go(url, method = "GET", body = null, ctype = "") {
  return queued(async () => {
    let r, frag = split(url).frag;
    for (let i = 0; i < 10; i++) {
      r = await request(method, url, body, ctype);
      if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
        url = r.headers.location;
        frag = split(url).frag || frag;
        if (r.status === 303 || r.status <= 302) { method = "GET"; body = null; ctype = ""; }
        continue;
      }
      break;
    }
    await syncfs(false).catch((e) => console.warn("save failed", e));
    const text = new TextDecoder().decode(r.data);
    const pathq = split(url).path + (split(url).query ? "?" + split(url).query : "");
    navigating = true;
    const target = "#" + pathq + (frag ? "#" + frag : "");
    if (!pathq.startsWith("/view")) {
      if (location.hash !== target) history.pushState(null, "", target);
    }
    navigating = false;
    if ((r.headers["content-type"] || "").startsWith("text/html")) render(text, frag);
    else render(`<main><h1>Something went wrong (${r.status})</h1><pre style="white-space:pre-wrap">${
      text.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</pre><p><a href="#/today">Back to Today</a></p></main>`, "");
  });
}

// ------------------------------------------------------------------ rendering
function render(html, frag) {
  for (const [t, f, o] of pageListeners) window.removeEventListener(t, f, o);
  pageListeners = [];
  html = html.replace(/(href|src)="\/static\//g, '$1="static/').replace(/href="\//g, 'href="#/');
  const doc = new DOMParser().parseFromString(html, "text/html");
  document.title = doc.title || "RunningCoach";
  const app = $("app");
  app.replaceChildren(...doc.body.childNodes);
  // scripts inserted this way don't run: re-create them, each in its own block so that page
  // scripts can declare the same names again on the next page
  const add = window.addEventListener;
  window.addEventListener = function (t, f, o) { pageListeners.push([t, f, o]); return add.call(window, t, f, o); };
  try {
    for (const old of app.querySelectorAll("script")) {
      const s = document.createElement("script");
      if (old.type && old.type !== "text/javascript") { s.type = old.type; s.textContent = old.textContent; }
      else s.textContent = "{\n" + old.textContent + "\n}";
      old.replaceWith(s);
    }
  } finally { window.addEventListener = add; }
  if (frag && document.getElementById(frag)) document.getElementById(frag).scrollIntoView();
  else window.scrollTo(0, 0);
}

// Links: "#/..." are handled by hashchange -> go(); plain "/..." (rare) are caught here.
document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a[href]");
  if (!a || e.defaultPrevented || a.target === "_blank") return;
  const href = a.getAttribute("href");
  if (href.startsWith("#/")) { e.preventDefault(); go(href.slice(1)); }
  else if (href.startsWith("/") && !href.startsWith("//")) { e.preventDefault(); go(href); }
});

// Forms: sent to the app unless the page handles them itself (the Progress what-if does).
document.addEventListener("submit", (e) => {
  if (e.defaultPrevented) return;
  const f = e.target;
  const action = f.getAttribute("action") || (location.hash.slice(1) || "/today");
  e.preventDefault();
  const fd = new FormData(f);
  if (e.submitter && e.submitter.name) fd.append(e.submitter.name, e.submitter.value);
  const q = new URLSearchParams(fd).toString();
  if ((f.method || "get").toLowerCase() === "post") {
    go(action, "POST", q, "application/x-www-form-urlencoded");
  } else {
    go(split(action).path + "?" + q);
  }
});

// fetch("/api/...") from page scripts goes to the app too.
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (bridge && url.startsWith("/") && !url.startsWith("//")) {
    const r = await queued(() => request((init && init.method) || "GET", url));
    return new Response(r.data, { status: r.status, headers: r.headers });
  }
  return realFetch(input, init);
};

// ------------------------------------------------------------------ backup
window.coachShell = {
  async backup() {
    await busy;
    const bytes = py.FS.readFile("/data/coach.db");
    const name = `runningcoach-${new Date().toISOString().slice(0, 10)}.db`;
    const file = new File([bytes], name, { type: "application/octet-stream" });
    // the app remembers the date, so Today stops reminding (and Settings shows it)
    const saved = async () => {
      await queued(() => request("POST", "/settings/backed-up"));
      await syncfs(false);
      document.querySelectorAll(".banner.backup").forEach((b) => b.remove());
    };
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "RunningCoach backup" }); await saved(); return; }
      catch (e) { if (e.name === "AbortError") return; }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    await saved();
  },
  restore() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".db,application/octet-stream";
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (new TextDecoder().decode(bytes.slice(0, 15)) !== "SQLite format 3") {
        alert("That isn't a RunningCoach backup.");
        return;
      }
      if (!confirm("Replace everything on this phone with this backup?")) return;
      await queued(async () => {
        py.runPython("from coach_app import main\nif main.db is not None:\n    main.db.con.close()\nmain.db = None");
        py.FS.writeFile("/data/coach.db", bytes);
        await syncfs(false);
      });
      go("/today");
    };
    inp.click();
  },
};

// ------------------------------------------------------------------ offline
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

boot().catch((e) => {
  console.error(e);
  say("Couldn't start: " + (e && e.message ? e.message : e) +
      ". The first start needs an internet connection; try again.");
});
