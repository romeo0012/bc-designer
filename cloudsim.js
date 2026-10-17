// Simulovaný cloud: v prohlížeči se chová jako CloudSigma API 2.0 podle aplikace cloudsigma-interactive
// (stejné cesty, kódy odpovědí a tvary payloadů). Nic se nikam neposílá a nevytváří; slouží k simulaci nasazení.
const SimCloud = (() => {
  const GIB = 1073741824;
  // základní doba odpovědi jednotlivých volání v ms (simulovaná "reálná"; skutečné čekání se dělí rychlostí simulace)
  const BASE_MS = { list: 160, create: 420, clone: 520, poll: 180, put: 380, attach: 460, get: 200, start: 350 };

  function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  function create(options) {
    const opt = Object.assign({ seed: 7, speed: 4, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }, options);
    const rng = mulberry32(opt.seed);
    const hex = (n) => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join("");
    const uid = () => hex(8) + "-" + hex(4) + "-4" + hex(3) + "-a" + hex(3) + "-" + hex(12);
    let S;
    const fresh = () => ({
      servers: {}, drives: {},
      library: [["Ubuntu 22.04 LTS", 10], ["Ubuntu 24.04 LTS", 10], ["Debian 12", 8], ["Rocky Linux 9", 10], ["AlmaLinux 9", 10]]
        .map(([name, gib]) => ({ uuid: uid(), name, size: gib * GIB, media: "disk", image_type: "preinst", deprecated: false })),
      vlans: [["DMZ", ""], ["K8S", ""], ["OPS", ""], ["CICD", ""]].map(([name]) => ({ uuid: uid(), name })),
      keys: [{ uuid: uid(), name: "deploy-key" }, { uuid: uid(), name: "admin-key" }]
    });
    S = fresh();

    const strip = (d) => { const o = Object.assign({}, d); delete o._polls; delete o._need; return o; };
    const err = (status, type, message, point) => ({ status, ok: false, json: [{ error_type: type, error_point: point || null, error_message: message }] });
    const done = (status, json) => ({ status, ok: status < 400, json });
    const page = (items, params) => { const off = +((params || {}).offset || 0), lim = +((params || {}).limit || 100); return { meta: { total_count: items.length, offset: off, limit: lim }, objects: items.slice(off, off + lim) }; };

    // volání rozpoznané podle cesty (pro dobu odezvy a vložení chyby)
    function classify(method, p, params) {
      if (method === "GET" && /^(libdrives|vlans|pubkeys|servers)$/.test(p[0]) && p.length === 1) return ["list", "list"];
      if (method === "POST" && p[0] === "servers" && p.length === 1) return ["create", "create"];
      if (method === "POST" && p[0] === "libdrives" && p[2] === "action" && params && params.do === "clone") return ["clone", "clone"];
      if (method === "GET" && p[0] === "drives") return ["wait", "poll"];
      if (method === "PUT" && p[0] === "drives") return ["resize", "put"];
      if (method === "PUT" && p[0] === "servers") return ["attach", "attach"];
      if (method === "GET" && p[0] === "servers") return ["verify", "get"];
      if (method === "POST" && p[0] === "servers" && p[2] === "action" && params && params.do === "start") return ["start", "start"];
      return ["other", "get"];
    }

    function handle(method, p, body, params) {
      const res = p[0];
      if (method === "GET" && p.length === 1) {
        if (res === "libdrives") return done(200, page(S.library, params));
        if (res === "vlans") return done(200, page(S.vlans, params));
        if (res === "pubkeys") return done(200, page(S.keys, params));
        if (res === "servers") return done(200, page(Object.values(S.servers).map((s) => ({ uuid: s.uuid, name: s.name, status: s.status })), params));
      }
      if (method === "POST" && res === "servers" && p.length === 1) {
        const spec = body && body.objects && body.objects[0];
        if (!spec || !spec.name) return err(400, "validation", "name is required", "name");
        if (Object.values(S.servers).some((s) => s.name === spec.name)) return err(400, "validation", "server with this name already exists", "name");
        for (const k of ["cpu", "mem", "smp"]) if (!Number.isInteger(spec[k]) || spec[k] <= 0) return err(400, "validation", k + " must be a positive integer", k);
        if (!spec.vnc_password) return err(400, "validation", "vnc_password is required", "vnc_password");
        const s = Object.assign({}, spec, { uuid: uid(), status: "stopped", drives: [], nics: [], pubkeys: [], _starts: 0 });
        S.servers[s.uuid] = s; return done(201, { objects: [strip(s)] });
      }
      if (method === "POST" && res === "libdrives" && p[2] === "action" && params && params.do === "clone") {
        const img = S.library.find((i) => i.uuid === p[1]);
        if (!img) return err(404, "notexist", "library drive does not exist", "uuid");
        if (!body || !body.name) return err(400, "validation", "name is required", "name");
        const d = { uuid: uid(), name: body.name, size: img.size, media: "disk", storage_type: "nvme", status: "cloning_dst", mounted_on: [], _polls: 0, _need: 3 + Math.floor(rng() * 3) };
        S.drives[d.uuid] = d; return done(202, { objects: [{ uuid: d.uuid, name: d.name, status: d.status }] });
      }
      if (res === "drives" && p[1]) {
        const d = S.drives[p[1]]; if (!d) return err(404, "notexist", "drive does not exist", "uuid");
        if (method === "GET") { if (d.status === "cloning_dst" && ++d._polls >= d._need) d.status = "unmounted"; return done(200, strip(d)); }
        if (method === "PUT") {
          if (d.status !== "unmounted" || d.mounted_on.length) return err(400, "validation", "drive must be unmounted", "status");
          if (!body || !Number.isInteger(body.size) || body.size < d.size) return err(400, "validation", "size can only be increased", "size");
          d.size = body.size; return done(200, { objects: [strip(d)] });
        }
      }
      if (res === "servers" && p[1]) {
        const s = S.servers[p[1]]; if (!s) return err(404, "notexist", "server does not exist", "uuid");
        if (method === "GET") { if (s.status === "starting" && ++s._starts >= 2) s.status = "running"; return done(200, strip(s)); }
        if (method === "PUT" && p.length === 2) {
          if (s.status !== "stopped") return err(400, "validation", "server must be stopped", "status");
          for (const k of ["name", "cpu", "mem", "smp", "vnc_password"]) if (body[k] === undefined || body[k] === "") return err(400, "validation", k + " is required", k);
          const ds = body.drives || [];
          for (const d of ds) { const dr = S.drives[d.drive]; if (!dr) return err(404, "notexist", "drive does not exist", "drives"); if (dr.status !== "unmounted" || dr.mounted_on.length) return err(400, "validation", "drive is not available", "drives"); }
          s.drives.forEach((d) => { const dr = S.drives[d.drive]; if (dr) { dr.mounted_on = []; dr.status = "unmounted"; } });
          ds.forEach((d) => { const dr = S.drives[d.drive]; dr.mounted_on = [{ uuid: s.uuid }]; dr.status = "mounted"; });
          Object.assign(s, { drives: ds, nics: body.nics || [], pubkeys: body.pubkeys || [] }); return done(200, { objects: [strip(s)] });
        }
        if (method === "POST" && p[2] === "action" && params && params.do === "start") {
          if (s.status !== "stopped") return err(400, "validation", "server is not stopped", "status");
          if (!s.drives.length) return err(400, "validation", "server has no boot drive", "drives");
          s.status = "starting"; s._starts = 0; return done(202, { objects: [{ uuid: s.uuid, action: "start", result: "success" }] });
        }
      }
      return err(404, "notexist", "unknown resource " + method + " " + p.join("/"), null);
    }

    const api = {
      get speed() { return opt.speed; }, set speed(v) { opt.speed = Math.max(0.1, +v || 1); },
      failOn: null,                       // { vm: název VM, step: krok } - jednorázová simulovaná chyba tenantu
      sleep: (ms) => opt.sleep(ms / opt.speed),
      reset() { S = fresh(); api.failOn = null; },
      restore(snap) { S = JSON.parse(JSON.stringify(snap)); api.failOn = null; },   // obnova uloženého stavu simulovaného cloudu
      snapshot() { return JSON.parse(JSON.stringify(S)); },
      async request(method, path, o) {
        o = o || {}; const p = String(path).replace(/^\/+|\/+$/g, "").split("/"), [step, speedClass] = classify(method, p, o.params);
        const ms = Math.round(BASE_MS[speedClass] * (0.6 + rng() * 0.8));
        await opt.sleep(ms / opt.speed);
        if (api.failOn && api.failOn.vm === o.tag && api.failOn.step === step) {
          api.failOn = null; const r = err(403, "permission", "Access denied (simulated tenant error)", step); r.ms = ms; return r;
        }
        const r = handle(method, p, o.body, o.params); r.ms = ms; return r;
      }
    };
    return api;
  }
  return { create, GIB };
})();
if (typeof module !== "undefined") module.exports = SimCloud;
