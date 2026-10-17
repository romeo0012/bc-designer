// Simulace samoopravného nástroje pro nasazený Kubernetes: zdravotní problémy, incidenty, jejich řešení a důležité události.
// Nic se nespouští a k žádnému clusteru se nepřipojuje; příkazy, výstupy i události jsou simulované.
const SelfHeal = (() => {
  const PENALTY = { critical: 25, major: 12, minor: 5 };
  // Katalog incidentů. kind: kde vzniká (worker | control | pod). impact: dopad na uzel. auto: zvládne to nástroj sám; jinak eskaluje a čeká na zásah.
  const TYPES = {
    crash: { sev: "major", kind: "pod", impact: "degraded", auto: true, reason: "BackOff", title: "Pod {app} je ve stavu CrashLoopBackOff",
      msg: "Back-off restarting failed container {app} in pod {pod}", cause: "Aplikace skončí chybou hned po startu (špatná konfigurace nebo chybějící závislost).",
      diag: ["kubectl -n {ns} describe pod {pod}", "kubectl -n {ns} logs {pod} --previous --tail=20"],
      fix: ["kubectl -n {ns} rollout restart deployment/{app}", "kubectl -n {ns} rollout status deployment/{app} --timeout=120s"], result: "Deployment byl restartován a pody běží." },
    oom: { sev: "major", kind: "pod", impact: "degraded", auto: true, reason: "OOMKilled", title: "Pod {app} byl ukončen pro nedostatek paměti (OOMKilled)",
      msg: "Container {app} in pod {pod} terminated with reason OOMKilled (exit code 137)", cause: "Kontejner překročil svůj paměťový limit.",
      diag: ["kubectl -n {ns} describe pod {pod}", "kubectl top pod -n {ns} {pod}"],
      fix: ["kubectl -n {ns} set resources deployment/{app} --limits=memory=1Gi", "kubectl -n {ns} rollout status deployment/{app} --timeout=120s"], result: "Paměťový limit byl zvýšen a pod běží stabilně." },
    node: { sev: "critical", kind: "worker", impact: "down", auto: true, reason: "NodeNotReady", title: "Uzel {node} není ve stavu Ready",
      msg: "Node {node} status is now: NodeNotReady (kubelet stopped posting node status)", cause: "Služba kubelet na uzlu neodpovídá.",
      diag: ["kubectl describe node {node}", "ssh cloudsigma@{ip} sudo systemctl status kubelet"],
      fix: ["ssh cloudsigma@{ip} sudo systemctl restart kubelet", "kubectl wait --for=condition=Ready node/{node} --timeout=120s"], result: "Kubelet byl restartován a uzel je opět Ready." },
    disk: { sev: "major", kind: "worker", impact: "degraded", auto: true, reason: "NodeHasDiskPressure", title: "Uzel {node} má plný disk (DiskPressure)",
      msg: "Node {node} status is now: NodeHasDiskPressure (nodefs.available below threshold)", cause: "Na disku uzlu došlo místo kvůli starým obrazům a logům.",
      diag: ["kubectl describe node {node}", "ssh cloudsigma@{ip} df -h /var/lib/containerd"],
      fix: ["ssh cloudsigma@{ip} sudo crictl rmi --prune", "ssh cloudsigma@{ip} sudo journalctl --vacuum-size=200M"], result: "Nepoužívané obrazy a logy byly odstraněny, místo na disku se uvolnilo." },
    calico: { sev: "major", kind: "worker", impact: "degraded", auto: true, reason: "Unhealthy", title: "Síťový agent calico-node na uzlu {node} není Ready",
      msg: "Readiness probe failed: calico/node is not ready: BIRD is not ready on {node}", cause: "Síťový agent Calico na uzlu ztratil spojení.",
      diag: ["kubectl -n calico-system get pods -o wide", "kubectl -n calico-system logs ds/calico-node --tail=20"],
      fix: ["kubectl -n calico-system delete pod -l k8s-app=calico-node --field-selector spec.nodeName={node}", "kubectl -n calico-system rollout status daemonset/calico-node --timeout=120s"], result: "Pod calico-node byl znovu vytvořen a síť uzlu funguje." },
    etcd: { sev: "critical", kind: "control", impact: "degraded", auto: true, reason: "EtcdUnhealthy", title: "Člen etcd na uzlu {node} je nezdravý",
      msg: "etcd member {node} is unhealthy: took too long (2.4s) to execute", cause: "Databáze etcd je fragmentovaná a pomalu odpovídá.",
      diag: ["kubectl -n kube-system exec etcd-{node} -- etcdctl endpoint health --cluster", "kubectl -n kube-system exec etcd-{node} -- etcdctl endpoint status -w table"],
      fix: ["kubectl -n kube-system exec etcd-{node} -- etcdctl defrag", "kubectl -n kube-system exec etcd-{node} -- etcdctl endpoint health --cluster"], result: "Defragmentace proběhla a člen etcd je zdravý." },
    cert: { sev: "minor", kind: "control", impact: "degraded", auto: true, reason: "CertificateExpiring", title: "Certifikáty clusteru na uzlu {node} brzy vyprší (7 dní)",
      msg: "kubeadm certificates on {node} expire in 7 days", cause: "Certifikáty vytvořené kubeadm mají roční platnost.",
      diag: ["ssh cloudsigma@{ip} sudo kubeadm certs check-expiration"],
      fix: ["ssh cloudsigma@{ip} sudo kubeadm certs renew all", "ssh cloudsigma@{ip} sudo crictl pods --name kube-apiserver"], result: "Certifikáty byly obnoveny na další rok." },
    image: { sev: "minor", kind: "pod", impact: "degraded", auto: false, reason: "Failed", title: "Pod {app} nemůže stáhnout obraz (ImagePullBackOff)",
      msg: "Failed to pull image \"registry.local/{app}:2.0.9\": manifest unknown", cause: "Tag obrazu v registru neexistuje.",
      escalate: "Chybný tag obrazu nelze opravit automaticky, je potřeba rozhodnout o verzi. Navržený postup: vrátit předchozí vydání.",
      diag: ["kubectl -n {ns} describe pod {pod}", "kubectl -n {ns} get deployment {app} -o jsonpath='{.spec.template.spec.containers[0].image}'"],
      fix: ["kubectl -n {ns} rollout undo deployment/{app}", "kubectl -n {ns} rollout status deployment/{app} --timeout=120s"], result: "Nasazení bylo vráceno na předchozí funkční verzi." },
    pending: { sev: "major", kind: "pod", impact: "degraded", auto: false, reason: "FailedScheduling", title: "Pody {app} čekají na naplánování (Pending)",
      msg: "0/{nodes} nodes are available: Insufficient cpu", cause: "V clusteru není dost volného výkonu CPU.",
      escalate: "Chybí kapacita clusteru. Navržený postup: snížit počet replik nebo přidat worker uzel.",
      diag: ["kubectl -n {ns} describe pod {pod}", "kubectl describe nodes | grep -A5 \"Allocated resources\""],
      fix: ["kubectl -n {ns} scale deployment/{app} --replicas=2", "kubectl -n {ns} rollout status deployment/{app} --timeout=120s"], result: "Počet replik byl snížen a pody jsou naplánované." }
  };
  // dopad incidentu na metriky (Grafana) a řádky logu (Kibana)
  const EFF = { crash: { cpu: 6, restarts: 4 }, oom: { mem: 18, restarts: 2 }, node: { cpu: 12, lat: 60 }, disk: { mem: 6, lat: 30 }, calico: { lat: 140 }, etcd: { lat: 260, cpu: 4 }, cert: {}, image: { restarts: 1 }, pending: { cpu: 28 } };
  const LOGS = { crash: ["ERROR", "{app}", "Unhandled exception: connect ECONNREFUSED db:5432"], oom: ["ERROR", "{app}", "java.lang.OutOfMemoryError: Java heap space"], node: ["WARN", "kubelet", "Node {node} not ready: kubelet stopped posting status"],
    disk: ["WARN", "kubelet", "eviction manager: attempting to reclaim ephemeral-storage on {node}"], calico: ["WARN", "calico-node", "BIRD is not ready: BGP not established on {node}"], etcd: ["ERROR", "etcd", "apply request took too long [2.4s] on {node}"],
    cert: ["WARN", "kube-apiserver", "client certificate expires in 7 days on {node}"], image: ["ERROR", "kubelet", "Failed to pull image registry.local/{app}:2.0.9: not found"], pending: ["WARN", "kube-scheduler", "0/{nodes} nodes are available: Insufficient cpu for {app}"] };
  const INFO = [["web", "GET /health 200 3ms"], ["api", "POST /orders 201 48ms"], ["api", "GET /orders/1042 200 12ms"], ["queue-worker", "processed job 8841 in 220ms"], ["grafana", "dashboard refresh ok"], ["hello-world", "GET / 200 1ms"], ["kube-apiserver", "audit: list pods 200"]];
  const APPS = [["web", "demo"], ["api", "demo"], ["queue-worker", "demo"], ["grafana", "monitoring"], ["hello-world", "demo"]];
  const NOISE = ["Pulled|Successfully pulled image \"nginx:1.27\" in 1.2s", "Started|Started container {app}", "Scheduled|Successfully assigned {ns}/{pod} to {node}", "ScalingReplicaSet|Scaled up replica set {app} to 2", "SuccessfulCreate|Created pod: {pod}", "LeaderElection|{node} became leader"];

  function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m));

  // opts: { nodes: [{name, role: "control"|"worker", ip}], sleep(ms), seed, auto, hooks: { change(), log(entry) } }
  function create(opts) {
    const rng = mulberry32(opts.seed || 5), sleep = opts.sleep, h = opts.hooks || {}, nodes = opts.nodes, HALT = { halt: true };
    const S = { series: [], hist: [], logs: [], tickNo: 0, prev: null, auto: opts.auto !== false, halted: false, incidents: [], events: [], seq: 0, nid: 0, resolved: 0, repairMs: [], node: {} };
    nodes.forEach((n) => { S.node[n.name] = { status: "healthy" }; });
    const pick = (a) => a[Math.floor(rng() * a.length)], change = () => h.change && h.change();
    const suffix = () => Array.from({ length: 5 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rng() * 36)]).join("");
    const ev = (type, reason, object, msg, important) => { S.events.push({ seq: ++S.seq, t: new Date(), type, reason, object, msg, important: !!important }); if (S.events.length > 300) S.events.shift(); };
    const open = () => S.incidents.filter((i) => i.status !== "resolved");
    function recompute() {
      nodes.forEach((n) => {
        const mine = open().filter((i) => i.node === n.name && TYPES[i.type].kind !== "pod");
        S.node[n.name].status = mine.some((i) => TYPES[i.type].impact === "down") ? "down" : mine.length ? "degraded" : "healthy";
      });
    }
    async function cmd(inc, text, base, lines) {
      if (S.halted) throw HALT;
      const ms = Math.round(base * (0.7 + rng() * 0.6)); await sleep(ms);
      h.log && h.log({ tag: inc.node, cmd: fill(text, inc.vars), rc: 0, ms }); (lines || []).forEach((l) => h.log && h.log({ tag: inc.node, out: fill(l, inc.vars) }));
    }
    function inject(typeId) {
      const t = TYPES[typeId] || TYPES[pick(Object.keys(TYPES))], id = TYPES[typeId] ? typeId : Object.keys(TYPES).find((k) => TYPES[k] === t);
      const pool = t.kind === "control" ? nodes.filter((n) => n.role === "control") : t.kind === "worker" ? nodes.filter((n) => n.role === "worker") : nodes.filter((n) => n.role === "worker");
      const free = (pool.length ? pool : nodes).filter((n) => !open().some((i) => i.type === id && i.node === n.name && t.kind !== "pod"));
      if (!free.length) return null;
      const node = pick(free), app = pick(APPS), pod = app[0] + "-" + suffix() + "-" + suffix().slice(0, 4);
      const inc = { id: ++S.nid, type: id, sev: t.sev, node: node.name, status: "open", t0: new Date(), t1: null, busy: false, outcome: "",
        vars: { app: app[0], ns: app[1], pod, node: node.name, ip: node.ip, nodes: String(nodes.length) } };
      S.incidents.push(inc);
      ev("Warning", t.reason, t.kind === "pod" ? "pod/" + pod : "node/" + node.name, fill(t.msg, inc.vars), true);
      if (t.impact === "down") ev("Warning", "NodeNotReady", "node/" + node.name, "Node " + node.name + " status is now: NodeNotReady", true);
      recompute(); change();
      if (S.auto) remediate(inc.id, "auto").catch(() => {});
      return inc;
    }
    // řešení incidentu: diagnostika -> oprava -> ověření; neřešitelné automaticky eskaluje (opraví se až ručním zásahem)
    async function remediate(id, mode) {
      const inc = S.incidents.find((i) => i.id === id), t = inc && TYPES[inc.type];
      if (!inc || inc.busy || inc.status === "resolved" || S.halted) return;
      inc.busy = true;
      try {
        inc.status = "diagnosing"; change(); await sleep(900);
        for (const c of t.diag) await cmd(inc, c, 1400);
        if (!t.auto && mode !== "manual") { inc.status = "escalated"; ev("Warning", "ManualActionRequired", "incident/" + inc.id, fill(t.title, inc.vars) + " - automatic remediation is not safe", true); change(); return; }
        inc.status = "fixing"; change();
        for (const c of t.fix) await cmd(inc, c, 3500, c.includes("rollout status") || c.includes("wait") ? ["successfully rolled out"] : []);
        inc.status = "verifying"; change();
        await cmd(inc, t.kind === "pod" ? "kubectl -n {ns} get pods -l app={app}" : "kubectl get nodes " + (t.kind === "control" ? "-l node-role.kubernetes.io/control-plane" : ""), 1500, t.kind === "pod" ? ["{app}-7d9f   1/1   Running   0   9s"] : ["{node}   Ready"]);
        inc.status = "resolved"; inc.t1 = new Date(); inc.outcome = mode === "manual" ? "manual" : "auto"; S.resolved++; S.repairMs.push(inc.t1 - inc.t0);
        ev("Normal", "Resolved", "incident/" + inc.id, fill(t.title, inc.vars) + " - resolved", true);
        recompute();
      } catch (e) { if (e !== HALT) throw e; inc.status = "open"; }
      finally { inc.busy = false; change(); }
    }
    // jeden krok času: metriky (Grafana), počty a řádky logu (Kibana) podle aktuálních incidentů
    function tick() {
      const eff = { cpu: 0, mem: 0, restarts: 0, lat: 0 }, inc = open();
      inc.forEach((i) => Object.entries(EFF[i.type] || {}).forEach(([k, v]) => { eff[k] += v; }));
      const tgt = { cpu: 34 + eff.cpu + rng() * 6, mem: 52 + eff.mem + rng() * 4, restarts: eff.restarts * (0.6 + rng() * 0.8), lat: 45 + eff.lat + rng() * 12 }, p = S.prev || tgt;
      const m = {}; Object.keys(tgt).forEach((k) => { m[k] = Math.round((k === "restarts" ? tgt[k] : 0.55 * p[k] + 0.45 * tgt[k]) * 10) / 10; });
      S.prev = m; m.ready = nodes.filter((n) => S.node[n.name].status !== "down").length; m.total = nodes.length; S.series.push(m); if (S.series.length > 60) S.series.shift();
      const cnt = { INFO: 0, WARN: 0, ERROR: 0 }, add = (lvl, svc, msg) => { S.logs.push({ seq: ++S.seq, t: new Date(), level: lvl, svc, msg }); cnt[lvl]++; };
      for (let k = 0; k < 2 + Math.floor(rng() * 3); k++) { const [svc, msg] = pick(INFO); add("INFO", svc, msg); }
      inc.forEach((i) => { const l = LOGS[i.type]; if (l && rng() < 0.9) { add(l[0], fill(l[1], i.vars), fill(l[2], i.vars)); if (rng() < 0.5) add(l[0], fill(l[1], i.vars), fill(l[2], i.vars)); } });
      if (S.logs.length > 400) S.logs.splice(0, S.logs.length - 400);
      S.hist.push(cnt); if (S.hist.length > 30) S.hist.shift(); S.tickNo++;
    }
    // preventivní restart aplikace na žádost (bez incidentu)
    async function restartApp(app) {
      const a = APPS.find((x) => x[0] === app); if (!a || S.halted) return false;
      const fake = { node: "cluster", vars: { app: a[0], ns: a[1] } };
      try {
        await cmd(fake, "kubectl -n {ns} rollout restart deployment/{app}", 2500, ["deployment.apps/{app} restarted"]);
        await cmd(fake, "kubectl -n {ns} rollout status deployment/{app} --timeout=120s", 4000, ["deployment \"{app}\" successfully rolled out"]);
        ev("Normal", "ScalingReplicaSet", "deployment/" + a[0], "Restarted deployment " + a[0] + " on request", true); change(); return true;
      } catch (e) { if (e !== HALT) throw e; return false; }
    }
    function noise() {
      const n = pick(nodes), app = pick(APPS), [reason, msg] = pick(NOISE).split("|"), v = { app: app[0], ns: app[1], pod: app[0] + "-" + suffix(), node: n.name };
      ev("Normal", reason, "pod/" + v.pod, fill(msg, v), false); change();
    }
    function score() {
      const pen = open().reduce((s, i) => s + PENALTY[i.sev], 0); return Math.max(0, 100 - pen);
    }
    return { S, TYPES, APPS, tick, restartApp, inject, remediate, noise, score, open, setAuto(v) { S.auto = !!v; if (S.auto) S.incidents.filter((i) => i.status === "open" && !i.busy).forEach((i) => remediate(i.id, "auto").catch(() => {})); },
      halt() { S.halted = true; } };
  }
  return { TYPES, PENALTY, APPS, create };
})();
if (typeof module !== "undefined") module.exports = SelfHeal;
