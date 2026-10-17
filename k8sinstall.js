// Simulace instalace Kubernetes na nasazené VM. Pořadí kroků a příkazy odpovídají aplikaci cloudsigma-interactive
// (cs/KUBERNETES.md, install_kubernetes_guest.sh, README_GRAFANA/HELLOWORLD): příprava uzlu, containerd, kubelet/kubeadm/kubectl,
// kubeadm init + kubeconfig, Calico (Tigera operator + Installation/default, VXLAN), kubeadm join workerů, ověření a add-ony.
// Nic se nespouští a k žádné VM se nepřipojuje; příkazy a jejich výstupy jsou simulované.
const K8sInstaller = (() => {
  const NODE_STEPS = ["prepare", "runtime", "packages", "join", "ready"];
  const PHASES = ["nodes", "control", "cni", "workers", "verify", "addons"];

  function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // plan: { control: [{name, ip}], workers: [{name, ip}] }
  // opts: { version: "v1.31", podCidr, calico: "v3.30.4", addons: {grafana, hello}, concurrency, sleep(ms), failure: ""|"apt"|"join"|"cni", seed }
  // hooks: node(name, status, msg) step(name, step, status, detail) phase(phase, status, detail) log(entry) run(status, out)
  function start(plan, opts, hooks) {
    const h = hooks || {}, ctl = { halted: false, byUser: false }, rng = mulberry32(opts.seed || 11), sleep = opts.sleep;
    const control = plan.control, workers = plan.workers, nodes = control.concat(workers), cp0 = control[0];
    const hex = (n) => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join("");
    const token = "abcdef." + hex(16), hash = "sha256:" + hex(64), apiEp = cp0.ip + ":6443", ver = opts.version, cidr = opts.podCidr, calico = opts.calico;
    const out = { status: "ok", failed: null, nodes: [], addons: [], peak: 0 };
    const HALT = { halt: true };
    const log = (e) => h.log && h.log(e), phase = (p, s, d) => h.phase && h.phase(p, s, d);
    const failAt = { apt: nodes[Math.min(2, nodes.length - 1)].name, join: workers.length ? workers[Math.min(1, workers.length - 1)].name : null };

    // jeden simulovaný příkaz: počká (simulovaná doba), zapíše ho do protokolu a případné řádky výstupu
    const cmd = async (tag, text, base, lines) => {
      if (ctl.halted) throw HALT;
      const ms = Math.round(base * (0.7 + rng() * 0.6)); await sleep(ms);
      log({ tag, cmd: text, rc: 0, ms }); (lines || []).forEach((l) => log({ tag, out: l }));
    };
    const bad = async (tag, text, base, rc, lines, msg) => {
      const ms = Math.round(base * (0.7 + rng() * 0.6)); await sleep(ms); log({ tag, cmd: text, rc, ms }); (lines || []).forEach((l) => log({ tag, out: l }));
      const e = new Error(msg); e.rc = rc; throw e;
    };
    // fronta s omezeným počtem souběžných úloh; po chybě nebo zastavení se nové úlohy nezačínají
    async function pool(items, fn) {
      let next = 0, running = 0;
      const worker = async () => { while (!ctl.halted && next < items.length) { const it = items[next++]; running++; out.peak = Math.max(out.peak, running); try { await fn(it); } finally { running--; } } };
      await Promise.all(Array.from({ length: Math.min(Math.max(1, opts.concurrency || 1), items.length) }, worker));
    }
    // úloha nad uzlem se sledováním kroku; chyba označí krok i uzel, zastavení krok přeruší
    async function onNode(node, firstStep, fn) {
      const t = node.name; let cur = firstStep;
      const st = (s, status, d) => { cur = s; h.step && h.step(t, s, status, d); };
      try { await fn(st, t); }
      catch (e) {
        if (e === HALT) { h.step && h.step(t, cur, "stopped"); h.node && h.node(t, "stopped"); }
        else { ctl.halted = true; if (!out.failed) out.failed = { name: t, step: cur, message: e.message }; h.step && h.step(t, cur, "failed", e.message); h.node && h.node(t, "failed", e.message); }
        throw e;
      }
    }
    const swallow = (p) => p.catch(() => {});

    async function prepareNode(node) {
      h.node && h.node(node.name, "installing");
      await onNode(node, "prepare", async (st, t) => {
        st("prepare", "running");
        await cmd(t, "ssh -o StrictHostKeyChecking=accept-new cloudsigma@" + node.ip + " sudo -n true", 600, ["Warning: Permanently added '" + node.ip + "' (ED25519) to the list of known hosts."]);
        await cmd(t, "curl -fL https://pkgs.k8s.io/core:/stable:/" + ver + "/deb/Release.key -o /dev/null", 900);
        await cmd(t, "sudo swapoff -a && sudo sed -i '/ swap / s/^/#/' /etc/fstab", 1500, ["swap vypnut a zakomentován v /etc/fstab"]);
        await cmd(t, "sudo modprobe overlay br_netfilter && sudo sysctl --system", 900, ["* Applying /etc/sysctl.d/99-kubernetes.conf ..."]);
        st("prepare", "ok");
        st("runtime", "running");
        await cmd(t, "sudo apt-get update -qq && sudo apt-get install -y -qq containerd ca-certificates curl gpg apt-transport-https", 22000, ["Setting up containerd (1.7.x) ..."]);
        await cmd(t, "containerd config default | sudo tee /etc/containerd/config.toml; sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml; sudo systemctl enable --now containerd && sudo systemctl restart containerd", 3000);
        st("runtime", "ok");
        st("packages", "running");
        await cmd(t, "echo 'deb [signed-by=...] https://pkgs.k8s.io/core:/stable:/" + ver + "/deb/ /' | sudo tee /etc/apt/sources.list.d/kubernetes.list && sudo apt-get update -qq", 2500);
        if (opts.failure === "apt" && failAt.apt === t) await bad(t, "sudo apt-get install -y -qq kubelet kubeadm kubectl", 9000, 100, ["E: Unable to locate package kubelet", "E: Unable to locate package kubeadm", "E: Unable to locate package kubectl"], "apt-get install skončil s kódem 100: balíčky Kubernetes " + ver + " nebyly nalezeny");
        await cmd(t, "sudo apt-get install -y -qq kubelet kubeadm kubectl", 30000, ["Setting up kubelet (" + ver + ".x) ...", "Setting up kubeadm (" + ver + ".x) ...", "Setting up kubectl (" + ver + ".x) ..."]);
        await cmd(t, "sudo apt-mark hold kubelet kubeadm kubectl && sudo systemctl enable kubelet", 1500);
        st("packages", "ok");
      });
    }

    async function controlPlane() {
      const t = cp0.name;
      await onNode(cp0, "join", async (st) => {
        st("join", "running");
        await cmd(t, "sudo kubeadm init --pod-network-cidr=" + cidr + " --cri-socket unix:///run/containerd/containerd.sock", 65000,
          ["[init] Using Kubernetes version: " + ver + ".x", "[preflight] Pulling images required for setting up a Kubernetes cluster", "[certs] Generating \"apiserver\" certificate and key", "[control-plane] Creating static Pod manifest for \"kube-apiserver\"", "[etcd] Creating static Pod manifest for local etcd", "Your Kubernetes control-plane has initialized successfully!"]);
        await cmd(t, "mkdir -p ~/.kube && sudo cp /etc/kubernetes/admin.conf ~/.kube/config && sudo chown $(id -u):$(id -g) ~/.kube/config && chmod 600 ~/.kube/config", 800, ["kubectl configured for cloudsigma"]);
        st("join", "ok");
      });
      await pool(control.slice(1), (node) => swallow(onNode(node, "join", async (st, tg) => {
        st("join", "running");
        await cmd(tg, "sudo kubeadm join " + apiEp + " --token " + token + " --discovery-token-ca-cert-hash " + hash + " --control-plane --certificate-key " + hex(16) + "… --cri-socket unix:///run/containerd/containerd.sock", 45000,
          ["[preflight] Running pre-flight checks", "[control-plane-join] Using manifest folder \"/etc/kubernetes/manifests\"", "This node has joined the cluster and a new control plane instance was created"]);
        st("join", "ok");
      })));
      if (out.failed || ctl.halted) throw ctl.byUser && !out.failed ? HALT : new Error("control-plane");
    }

    async function cni() {
      const t = cp0.name, base = "https://raw.githubusercontent.com/projectcalico/calico/" + calico + "/manifests";
      await cmd(t, "kubectl create -f " + base + "/tigera-operator.yaml", 6000, ["namespace/tigera-operator created", "customresourcedefinition.apiextensions.k8s.io/installations.operator.tigera.io created", "deployment.apps/tigera-operator created"]);
      await cmd(t, "kubectl wait --for=condition=Established --timeout=240s crd/installations.operator.tigera.io", 5000, ["customresourcedefinition.apiextensions.k8s.io/installations.operator.tigera.io condition met"]);
      await cmd(t, "kubectl apply -f installation.yaml   # Installation/default, VXLAN, cidr: " + cidr, 1200, ["installation.operator.tigera.io/default created"]);
      if (opts.failure === "cni") await bad(t, "kubectl wait --for=condition=Available --timeout=600s tigerastatus/calico", 40000, 1, ["NAME     AVAILABLE   PROGRESSING   DEGRADED", "calico   False       False         True", "error: timed out waiting for the condition on tigerastatuses/calico"], "Calico zůstal ve stavu Degraded (tigerastatus/calico nedostupný)");
      await cmd(t, "kubectl wait --for=condition=Available --timeout=600s tigerastatus/calico", 40000, ["tigerstatus.operator.tigera.io/calico condition met"]);
      await cmd(t, "kubectl -n calico-system rollout status daemonset/calico-node --timeout=600s", 25000, ["daemon set \"calico-node\" successfully rolled out"]);
      await cmd(t, "kubectl -n calico-system rollout status deployment/calico-kube-controllers --timeout=600s", 8000, ["deployment \"calico-kube-controllers\" successfully rolled out"]);
      await cmd(t, "kubectl -n kube-system rollout status deployment/coredns --timeout=600s", 6000, ["deployment \"coredns\" successfully rolled out"]);
    }

    async function joinWorker(node) {
      await onNode(node, "join", async (st, t) => {
        st("join", "running");
        if (opts.failure === "join" && failAt.join === t) await bad(t, "sudo kubeadm join " + apiEp + " --token " + token + " --discovery-token-ca-cert-hash sha256:… --cri-socket unix:///run/containerd/containerd.sock", 30000, 1,
          ["[preflight] Running pre-flight checks", "error execution phase preflight: couldn't validate the identity of the API Server: Get \"https://" + apiEp + "/api/v1/namespaces/kube-public/configmaps/cluster-info?timeout=10s\": context deadline exceeded"],
          "kubeadm join selhal: nelze ověřit identitu API serveru (" + apiEp + ", timeout)");
        await cmd(t, "sudo kubeadm join " + apiEp + " --token " + token + " --discovery-token-ca-cert-hash " + hash + " --cri-socket unix:///run/containerd/containerd.sock", 22000,
          ["[preflight] Running pre-flight checks", "[kubelet-start] Starting the kubelet", "This node has joined the cluster:", "* The Kubelet was informed of the new secure connection details."]);
        st("join", "ok");
      });
    }

    function nodeTable(readyCount, order) {
      const rows = order.map((n, i) => { const cp = control.includes(n); return n.name.padEnd(26) + (i < readyCount ? "Ready   " : "NotReady") + "  " + (cp ? "control-plane" : "<none>       ") + "  " + ver + ".x  " + n.ip; });
      return ["NAME                      STATUS    ROLES          VERSION  INTERNAL-IP"].concat(rows);
    }
    async function verify() {
      const t = cp0.name, order = control.concat(workers); let marked = 0;
      for (let i = 1; i <= 4; i++) {
        const target = Math.ceil(order.length * i / 4);
        await cmd(t, "kubectl get nodes -o wide", 3500, nodeTable(target, order));
        for (; marked < target; marked++) { const n = order[marked]; h.step && h.step(n.name, "ready", "ok"); h.node && h.node(n.name, "ready"); }
      }
      await cmd(t, "kubectl get pods -A --no-headers | grep -vc Running", 1500, ["0"]);
      await cmd(t, "kubectl get tigerastatus", 1200, ["NAME     AVAILABLE   PROGRESSING   DEGRADED", "calico   True        False         False"]);
      out.nodes = order.map((n) => ({ name: n.name, ip: n.ip, role: control.includes(n) ? "control-plane" : "worker", version: ver + ".x", ready: true }));
    }
    async function addons() {
      const t = cp0.name;
      if (opts.addons && opts.addons.grafana) {
        await cmd(t, "helm repo add prometheus-community https://prometheus-community.github.io/helm-charts && helm repo update", 4000, ["\"prometheus-community\" has been added to your repositories"]);
        await cmd(t, "helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack -n monitoring --create-namespace", 55000, ["Release \"kube-prometheus-stack\" does not exist. Installing it now.", "STATUS: deployed"]);
        await cmd(t, "kubectl -n monitoring rollout status deployment/kube-prometheus-stack-grafana", 30000, ["deployment \"kube-prometheus-stack-grafana\" successfully rolled out"]);
        out.addons.push({ id: "grafana", note: "kubectl -n monitoring port-forward --address 127.0.0.1 svc/kube-prometheus-stack-grafana 3000:80" });
      }
      if (opts.addons && opts.addons.hello) {
        await cmd(t, "kubectl create namespace demo", 700, ["namespace/demo created"]);
        await cmd(t, "kubectl -n demo apply -f hello-world.yaml   # ConfigMap + Deployment (nginx) + Service ClusterIP", 1200, ["configmap/hello-world created", "deployment.apps/hello-world created", "service/hello-world created"]);
        await cmd(t, "kubectl -n demo rollout status deployment/hello-world", 9000, ["deployment \"hello-world\" successfully rolled out"]);
        out.addons.push({ id: "hello", note: "Lens: Network > Services > demo/hello-world > Port Forward 80 -> 8080" });
      }
    }

    async function phaseRun(name, fn, skipIf) {
      if (skipIf) { phase(name, "skipped"); return; }
      if (ctl.halted) throw HALT;
      phase(name, "running");
      try { await fn(); }
      catch (e) {
        if (e === HALT || (ctl.byUser && !out.failed)) { phase(name, "stopped"); throw HALT; }
        if (!out.failed) out.failed = { name: cp0.name, step: name, message: e.message };
        phase(name, "failed", out.failed.message); throw e;
      }
      phase(name, "ok");
    }

    async function runAll() {
      h.run && h.run("running");
      try {
        await phaseRun("nodes", async () => { await pool(nodes, (n) => swallow(prepareNode(n))); if (out.failed) throw new Error(out.failed.message); if (ctl.halted) throw HALT; });
        await phaseRun("control", controlPlane);
        await phaseRun("cni", cni);
        await phaseRun("workers", async () => { await pool(workers, (n) => swallow(joinWorker(n))); if (out.failed) throw new Error(out.failed.message); if (ctl.halted) throw HALT; }, !workers.length);
        await phaseRun("verify", verify);
        await phaseRun("addons", addons, !(opts.addons && (opts.addons.grafana || opts.addons.hello)));
        out.status = "ok";
      } catch (e) { out.status = out.failed ? "failed" : "stopped"; }
      h.run && h.run(out.status, out); return out;
    }
    const done = runAll();
    return { halt: () => { ctl.halted = true; ctl.byUser = true; }, done };
  }

  return { NODE_STEPS, PHASES, start };
})();
if (typeof module !== "undefined") module.exports = K8sInstaller;
