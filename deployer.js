// Nasazení VM přímými voláními API (bez skriptů). Postup a tvary payloadů převzaté z aplikace cloudsigma-interactive:
//   1 create  POST servers/                          VM vzniká zastavená
//   2 clone   POST libdrives/<image>/action/?do=clone
//   3 wait    GET  drives/<uuid>/                    čeká na dokončení klonování (jen čtení)
//   4 resize  PUT  drives/<uuid>/                    jen zvětšení odpojeného disku
//   5 attach  PUT  servers/<uuid>/                   disk (virtio, 0:0, boot_order 1), VLAN své skupiny, SSH klíč
//   6 verify  GET  servers/<uuid>/
//   7 start   POST servers/<uuid>/action/?do=start   jen když je zvoleno
// Zápisy se při chybě neopakují. Volání jdou přes "transport": zde simulovaný cloud (cloudsim.js).
const Deployer = (() => {
  const STEPS = ["create", "clone", "wait", "resize", "attach", "verify", "start"];
  const GIB = 1073741824;
  // VLAN dané VM: každá skupina (větev) topologie má vlastní VLAN, proto má přednost opts.vlanOf(vm); opts.vlan je společná záloha
  const vlanFor = (vm, opts) => (opts.vlanOf ? opts.vlanOf(vm) : opts.vlan) || "";

  class ApiError extends Error {
    constructor(status, diagnostics) { super("CloudSigma HTTP " + status + (diagnostics ? ": " + diagnostics : "")); this.status = status; this.diagnostics = diagnostics; }
  }
  // jen povolená pole odpovědi s chybou (jako v aplikaci), nikdy celé tělo
  function diag(json) {
    const allowed = ["error_type", "error_point", "error_message", "error", "message", "detail", "code"];
    const rows = Array.isArray(json) ? json.slice(0, 5) : json && typeof json === "object" ? [json] : [];
    return rows.map((r) => allowed.filter((k) => r && r[k] != null).map((k) => k + "=" + String(r[k]).slice(0, 160)).join(", ")).filter(Boolean).join("; ");
  }
  // přímé volání API: zapíše do logu (metoda, cesta, stav, doba) a při chybě vyhodí ApiError
  function makeApi(transport, onLog) {
    return {
      async call(method, path, body, params, tag) {
        const r = await transport.request(method, path, { body, params, tag });
        if (onLog) onLog({ t: new Date(), tag: tag || "", method, path: path + (params && params.do ? "?do=" + params.do : ""), status: r.status, ms: r.ms, ok: r.ok });
        if (!r.ok) throw new ApiError(r.status, diag(r.json));
        return r.json;
      }
    };
  }
  const firstUuid = (json, what) => { const u = json && json.objects && json.objects[0] && json.objects[0].uuid; if (!u) throw new Error("API nevrátilo UUID: " + what); return u; };
  const vncPassword = () => { const b = new Uint8Array(24); (typeof crypto !== "undefined" && crypto.getRandomValues ? crypto : require("crypto").webcrypto).getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); };

  // Nasadí jednu VM. hooks.step(krok, stav, detail, uuid); stavy: running | ok | skipped | failed
  async function deployVm(api, vm, opts, hooks) {
    const tag = vm.name, step = (s, st, detail, uuid) => hooks && hooks.step && hooks.step(s, st, detail, uuid), created = {};
    let current = "create";
    try {
      step("create", "running"); current = "create";
      const spec = { name: vm.name, cpu: vm.cpu_mhz, mem: vm.mem_bytes, smp: vm.smp, vnc_password: vncPassword() };
      const sv = await api.call("POST", "servers/", { objects: [spec] }, null, tag); created.vm = firstUuid(sv, "VM");
      step("create", "ok", null, created.vm);

      step("clone", "running"); current = "clone";
      const cl = await api.call("POST", "libdrives/" + opts.image + "/action/", { name: vm.name + "-root" }, { do: "clone" }, tag); created.disk = firstUuid(cl, "disk");
      step("clone", "ok", null, created.disk);

      step("wait", "running"); current = "wait"; let drive, polls = 0;
      for (;;) {
        drive = await api.call("GET", "drives/" + created.disk + "/", null, null, tag); polls++;
        if (drive.status === "unmounted" && !(drive.mounted_on || []).length) break;
        if (polls >= (opts.maxPolls || 60)) throw new Error("Klonování disku neskončilo v limitu (" + polls + " kontrol)");
        step("wait", "running", "stav disku: " + drive.status + ", kontrola " + polls);
        await opts.sleep(opts.pollMs || 1000);
      }
      step("wait", "ok", polls + " kontrol");

      current = "resize"; const want = vm.disk_gib * GIB;
      if (want > drive.size) {
        step("resize", "running");
        await api.call("PUT", "drives/" + created.disk + "/", { name: drive.name, size: want, media: drive.media, storage_type: drive.storage_type }, null, tag);
        const chk = await api.call("GET", "drives/" + created.disk + "/", null, null, tag);
        if (chk.size !== want) throw new Error("Velikost disku se po zápisu neověřila");
        step("resize", "ok", "na " + vm.disk_gib + " GiB");
      } else step("resize", "skipped", "image má " + (drive.size / GIB).toFixed(1) + " GiB, disk se nezmenšuje");

      step("attach", "running"); current = "attach";
      const vlan = vlanFor(vm, opts);
      const fresh = await api.call("GET", "servers/" + created.vm + "/", null, null, tag);
      if (fresh.status !== "stopped") throw new Error("VM není zastavená");
      const body = { name: fresh.name, cpu: fresh.cpu, mem: fresh.mem, smp: fresh.smp, vnc_password: fresh.vnc_password,
        drives: [{ drive: created.disk, device: "virtio", dev_channel: "0:0", boot_order: 1 }], nics: vlan ? [{ model: "virtio", vlan }] : [] };
      if (opts.key) body.pubkeys = [opts.key];                 // ověřený formát tenantu: seznam holých UUID
      await api.call("PUT", "servers/" + created.vm + "/", body, null, tag);
      step("attach", "ok", (vlan ? "síť nastavena" : "bez NIC") + (opts.key ? ", SSH klíč přiřazen" : ""));

      step("verify", "running"); current = "verify";
      const ver = await api.call("GET", "servers/" + created.vm + "/", null, null, tag);
      if (!(ver.drives || []).some((d) => d.drive === created.disk)) throw new Error("Disk není u VM připojený");
      step("verify", "ok");

      if (opts.start) { step("start", "running"); current = "start"; await api.call("POST", "servers/" + created.vm + "/action/", {}, { do: "start" }, tag); step("start", "ok", "požadavek přijat"); }
      else step("start", "skipped", "bez spuštění");
      return created;
    } catch (e) { step(current, "failed", e.message); e.created = created; throw e; }
  }

  // Spustí nasazení více VM s omezeným počtem souběžně. Vrací { halt(), done }: při první chybě nebo po halt()
  // se další VM už nezačínají (rozpracované doběhnou). Nic se nemaže a zápisy se neopakují.
  function start(api, vms, opts, hooks) {
    const limit = Math.max(1, opts.concurrency || 1), ctl = { halted: false, byUser: false }, out = { ok: [], failed: [], notStarted: [], peak: 0 }, h = hooks || {};
    let next = 0, running = 0;
    async function worker() {
      while (!ctl.halted && next < vms.length) {
        const vm = vms[next++]; running++; out.peak = Math.max(out.peak, running);
        h.vm && h.vm(vm.name, "deploying");
        try { await deployVm(api, vm, opts, { step: (s, st, d, u) => h.step && h.step(vm.name, s, st, d, u) }); out.ok.push(vm.name); h.vm && h.vm(vm.name, "deployed"); }
        catch (e) { out.failed.push({ name: vm.name, message: e.message }); ctl.halted = true; h.vm && h.vm(vm.name, "failed", e.message); }
        finally { running--; }
      }
    }
    h.run && h.run("running");
    const done = Promise.all(Array.from({ length: Math.min(limit, vms.length) }, worker)).then(() => {
      out.notStarted = vms.slice(next).map((v) => v.name);
      out.status = out.failed.length ? "failed" : ctl.byUser ? "stopped" : "ok";
      h.run && h.run(out.status, out); return out;
    });
    return { halt: () => { ctl.halted = true; ctl.byUser = true; }, done };
  }

  // --- příprava režimu Exekuce (zatím vypnuto) ---
  // Exekuce má používat stejné deployVm/start, jen s jiným "transportem": MCP server s nástroji pro Business Cloud API místo SimCloud.
  // Dokud je LIVE_ENABLED false, žádné skutečné volání se neodešle; plan() jen vypíše, co by se volalo (dry-run).
  // Nástroje MCP serveru (adresáře clients a tools): čtení cs_api_list/cs_api_get, iaas_list_library_drives a zápis jen
  // iaas_server_action (start/stop/restart s potvrzením "akce:uuid"). Nástroje pro vytvoření VM, klon, zvětšení a připojení disku neexistují.
  const LIVE_ENABLED = false;
  function mcpMap(method, path, params, body) {
    const q = (params && params.do) || ((path.match(/\?do=(\w+)$/) || [])[1]), p = path.replace(/\?.*$/, "");
    let m;
    if (method === "GET" && p === "libdrives/") return { tool: "iaas_list_library_drives", arguments: {} };
    if (method === "GET" && (m = p.match(/^(drives|servers)\/([^/]+)\/$/))) return { tool: "cs_api_get", arguments: { resource: m[1], uuid: m[2] } };
    if (method === "POST" && q === "start" && (m = p.match(/^servers\/([^/]+)\/action\/$/))) return { tool: "iaas_server_action", arguments: { uuid: m[1], action: "start", confirmation: "start:" + m[1] } };
    return null;                       // zápis (create, clone, resize, attach) v MCP serveru zatím není
  }
  const mcpCall = (call) => { const r = mcpMap(call.method, call.path, null, call.body); return r ? { jsonrpc: "2.0", method: "tools/call", params: { name: r.tool, arguments: r.arguments } } : null; };
  function liveTransport(cfg) {
    let id = 0;
    return { async request(method, path, o) {
      if (!LIVE_ENABLED) throw new Error("Exekuce není zapnuta: žádná volání se neposílají");
      const r = mcpMap(method, path, o && o.params, o && o.body); if (!r) throw new Error("MCP server nemá nástroj pro " + method + " " + path);
      const t0 = Date.now(), res = await fetch(cfg.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: r.tool, arguments: r.arguments } }) });
      const msg = await res.json(), txt = msg && msg.result && msg.result.content && msg.result.content[0] && msg.result.content[0].text;
      return { status: res.status, ok: res.ok && !(msg && msg.error) && !(msg && msg.result && msg.result.isError), json: txt ? JSON.parse(txt) : msg, ms: Date.now() - t0 };   // tvar odpovědi nástrojů je třeba ověřit na živém serveru
    } };
  }
  function plan(vm, opts) {
    const spec = { name: vm.name, cpu: vm.cpu_mhz, mem: vm.mem_bytes, smp: vm.smp, vnc_password: "<vygeneruje se>" };
    const out = [
      { step: "create", method: "POST", path: "servers/", body: { objects: [spec] } },
      { step: "clone", method: "POST", path: "libdrives/" + opts.image + "/action/?do=clone", body: { name: vm.name + "-root" } },
      { step: "wait", method: "GET", path: "drives/<uuid disku>/", body: null, note: "opakuje se do stavu unmounted (jen čtení)" },
      { step: "resize", method: "PUT", path: "drives/<uuid disku>/", body: { name: vm.name + "-root", size: vm.disk_gib * GIB, media: "disk", storage_type: "<z image>" }, note: "jen když je image menší než " + vm.disk_gib + " GiB" },
      { step: "attach", method: "PUT", path: "servers/<uuid VM>/", body: Object.assign({ name: vm.name, cpu: vm.cpu_mhz, mem: vm.mem_bytes, smp: vm.smp, vnc_password: "<z VM>", drives: [{ drive: "<uuid disku>", device: "virtio", dev_channel: "0:0", boot_order: 1 }], nics: vlanFor(vm, opts) ? [{ model: "virtio", vlan: vlanFor(vm, opts) }] : [] }, opts.key ? { pubkeys: [opts.key] } : {}) },
      { step: "verify", method: "GET", path: "servers/<uuid VM>/", body: null }
    ];
    if (opts.start) out.push({ step: "start", method: "POST", path: "servers/<uuid VM>/action/?do=start", body: {} });
    return out;
  }
  return { STEPS, ApiError, makeApi, deployVm, start, diag, LIVE_ENABLED, mcpMap, mcpCall, liveTransport, plan };
})();
if (typeof module !== "undefined") module.exports = Deployer;
