// Pravidlový přepočet sizingu podle business požadavků zadaných volným textem.
// Běží v prohlížeči, nepoužívá AI: rozpoznává vzory v textu (uživatelé, dostupnost, objem dat, růst, špičky, prostředí).
const SZ = (() => {
  // Záložní zátěž pro scénář bez předpokládaného zadání (jinak platí zadání scénáře, viz adjust).
  const BASE = { users: 1000, concurrency: 0.1, rps: 50 };
  const GHZ_PER_VCPU = 2.5, HORIZON_DEFAULT = 2, EXP = 0.75;
  const RAM_STEPS = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
  // Řídicí komponenty, které s počtem uživatelů neroste (jen HA/prostředí).
  const FIXED = new Set(["etcd", "control-plane", "kafka-controller", "schema-registry", "orchestrator"]);
  // Strop na jednu VM (64 vCPU, 512 GiB); nad ním se přidávají další uzly.
  const GHZ_MAX = 160, RAM_MAX = 512;

  const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ /g, " ").replace(/×/g, "x").replace(/’/g, "'");
  const NUM = "(\\d{1,3}(?:[ .,]\\d{3})+(?!\\d)|\\d+(?:[.,]\\d+)?)";
  const MULT = "(?:\\s*(k|tis(?:ic\\w*|\\.)?|mil(?:ion\\w*|\\.)?|million\\w*|mln|thousand)(?![a-z]))?";
  const toNum = (s) => /^\d{1,3}([ .,]\d{3})+$/.test(s) ? parseFloat(s.replace(/[ .,]/g, "")) : parseFloat(s.replace(",", "."));
  const mult = (m) => !m ? 1 : /^(k|tis|thou)/.test(m) ? 1e3 : 1e6;
  const near = (t, i, len, re, w = 35) => re.test(t.slice(Math.max(0, i - w), i + len + w));

  // Jazyk popisků (cs / en). Rozpoznávání textu je vždy česky i anglicky, jazyk určuje jen výpis.
  let LANG = "cs";
  const LOC = () => LANG === "en" ? "en-GB" : "cs-CZ";
  const fmt = (n) => n.toLocaleString(LOC(), { maximumFractionDigits: 1 });
  const fmtGb = (gb) => gb >= 1000 ? fmt(gb / 1000) + " TB" : fmt(gb) + " GB";
  const L = {
    cs: { users: (n) => n + " uživatelů", conc: (n) => "souběžně " + n + " uživatelů",
      rps: { req: "požadavků/s", msg: "zpráv/s", tx: "transakcí/s", q: "dotazů/s", call: "volání/s", ev: "událostí/s" },
      data: (v) => v + " dat", avail: (a) => "dostupnost " + a + " %", ha: "vysoká dostupnost (HA)", none: "bez vysoké dostupnosti",
      nonprod: "neprodukční prostředí (test / PoC)",
      growth: (g, h) => "růst " + g + " % ročně, horizont " + h + (h >= 5 ? " let" : h > 1 ? " roky" : " rok"), peak: (x) => "špičky ×" + x },
    en: { users: (n) => n + " users", conc: (n) => n + " concurrent users",
      rps: { req: "requests/s", msg: "messages/s", tx: "transactions/s", q: "queries/s", call: "calls/s", ev: "events/s" },
      data: (v) => v + " of data", avail: (a) => "availability " + a + " %", ha: "high availability (HA)", none: "no high availability",
      nonprod: "non-production environment (test / PoC)",
      growth: (g, h) => "growth " + g + " % per year, horizon " + h + (h === 1 ? " year" : " years"), peak: (x) => "peaks ×" + x }
  };
  const rpsKind = (w) => /^(zprav|message)/.test(w) ? "msg" : /^(transakc|transaction)/.test(w) ? "tx" : /^(dotaz|quer)/.test(w) ? "q" : /^(volani|call)/.test(w) ? "call" : /^(udalost|event)/.test(w) ? "ev" : "req";

  function parse(text) {
    const t = norm(text), found = [], l = L[LANG];
    const p = { users: null, concurrent: null, rps: null, dataGB: null, availability: null, ha: "default", nonprod: false, growth: 0, horizon: HORIZON_DEFAULT, peak: 1 };
    let m, re;

    // uživatelé (celkem / souběžně)
    re = new RegExp(NUM + MULT + "\\s*(?:[a-z]+\\s+){0,2}(?:uzivatel|user|zakaznik|customer|zamestnan|employee|klient|client|navstevnik|visitor|ucastnik|participant|analytik|analyst|vyvojar|developer|people)\\w*", "g");
    const hits = [];
    while ((m = re.exec(t))) hits.push({ i: m.index, e: m.index + m[0].length, n: toNum(m[1]) * mult(m[2]) });
    // slovo "souběžně" patří k nejbližšímu číslu; čárka mezi frázemi vazbu oslabuje, číslo za slovem má malou přednost
    const conc = new Set(), kw = /soubezn\w*|soucasn\w*|concurrent|simultaneous\w*|online|naraz|at\s+once|same\s+time/g;
    let k;
    while ((k = kw.exec(t))) {
      const ke = k.index + k[0].length; let best = -1, bd = Infinity;
      hits.forEach((h, ix) => {
        const after = h.i >= ke, inside = !after && k.index < h.e;
        const gap = inside ? 0 : after ? t.slice(ke, h.i) : t.slice(h.e, k.index);
        const d = (inside ? 0 : gap.length + (after ? 0 : 3)) + (/[,;.]/.test(gap) ? 20 : 0);
        if (d < bd) { bd = d; best = ix; }
      });
      if (best >= 0 && bd <= 25) conc.add(best);
    }
    hits.forEach((h, ix) => { if (conc.has(ix)) p.concurrent = Math.max(p.concurrent || 0, h.n); else p.users = Math.max(p.users || 0, h.n); });
    if (p.users != null) found.push(l.users(fmt(p.users)));
    if (p.concurrent != null) found.push(l.conc(fmt(p.concurrent)));

    // požadavky / zprávy / transakce za jednotku času (bez jednotky se počítá za sekundu)
    re = new RegExp(NUM + MULT + "\\s*(rps|tps|req(?:uest\\w*)?|pozadavk\\w*|dotaz\\w*|transakc\\w*|transaction\\w*|volani|calls?|zprav\\w*|message\\w*|quer(?:y|ies)|udalost\\w*|events?)(?:(?:\\s*(?:/|za|per)\\s*|\\s+a\\s+)(s|sek\\w*|sec\\w*|min\\w*|h|hod\\w*|hour\\w*|den\\w*|day\\w*))?", "g");
    while ((m = re.exec(t))) {
      const per = !m[4] ? 1 : /^min/.test(m[4]) ? 60 : /^(h|hod)/.test(m[4]) ? 3600 : /^(den|day)/.test(m[4]) ? 86400 : 1;
      const r = toNum(m[1]) * mult(m[2]) / per;
      if (p.rps == null || r > p.rps) { p.rps = r; p.rpsKind = rpsKind(m[3]); }
    }
    if (p.rps != null) found.push(fmt(p.rps) + " " + l.rps[p.rpsKind]);

    // objem dat
    re = new RegExp(NUM + "\\s*(pb|tb|gb|mb|petabyt\\w*|terabyt\\w*|gigabyt\\w*|megabyt\\w*|petabajt\\w*|terabajt\\w*|gigabajt\\w*)", "g");
    while ((m = re.exec(t))) {
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 8);
      if (/^\s*(ram|pamet|operacni|memory)/.test(after)) continue;                // "16 GB RAM" není objem dat
      if (!near(t, m.index, m[0].length, /dat|uloz|archiv|objem|databaz|log|soubor|zaznam|storage|disk|file|volume|record/, 45)) continue;
      const u = m[2], f = /^p/.test(u) ? 1e6 : /^t/.test(u) ? 1e3 : /^m/.test(u) ? 0.001 : 1;
      p.dataGB = Math.max(p.dataGB || 0, toNum(m[1]) * f);
    }
    if (p.dataGB != null) found.push(l.data(fmtGb(p.dataGB)));

    // dostupnost
    const availPos = [];
    re = new RegExp(NUM + "\\s*%", "g");
    while ((m = re.exec(t))) {
      const v = toNum(m[1]);
      if (v >= 90 && v < 100 && (v >= 99 || near(t, m.index, m[0].length, /dostupn|sla|uptime|availab|vypadk|downtime/, 40))) {
        if (p.availability == null) p.availability = v;
        availPos.push(m.index);
      }
    }
    if (p.availability != null) {
      p.ha = p.availability >= 99.99 ? "very" : p.availability >= 99.5 ? "ha" : "default";
      found.push(l.avail(p.availability.toLocaleString(LOC(), { maximumFractionDigits: 3 })));
    }
    const noHa = /(nepotrebuj\w*|neni\s+treba|bez)\s+(?:\w+\s+){0,2}(ha\b|vysok\w*\s+dostupnost|redundanc\w*)|nekritick\w*|neni\s+kritick|(?:don'?t|do\s+not|no|not)\s+(?:need|require\w*|necessary)\s+(?:\w+\s+){0,3}(?:ha\b|high\s+availab\w*|redundanc\w*)|without\s+(?:\w+\s+){0,3}(?:ha\b|high\s+availab\w*|redundanc\w*)|\bno\s+(?:ha\b|high\s+availab\w*|redundanc\w*)|non-?critical|not\s+critical/.test(t);
    const wantHa = /24\s*\/\s*7|nepretrzit|bez\s+vypadk|vysok\w*\s+dostupnost|\bha\b|odoln\w+\s+vuci\s+vypadk|high\s+availab\w*|no\s+downtime|zero\s+downtime|always\s+on|round[- ]the[- ]clock/.test(t);
    if (noHa) { p.ha = "none"; found.push(l.none); }
    else if (wantHa && p.ha === "default") { p.ha = "ha"; found.push(l.ha); }

    // prostředí
    if (/\b(test|testovaci|pilot\w*|poc|demo|sandbox|dev|staging|nonprod|prototyp\w*|proof of concept)\b/.test(t) && !/produkc\w*|production/.test(t)) {
      p.nonprod = true; found.push(l.nonprod);
    }

    // růst a horizont
    re = new RegExp(NUM + "\\s*%", "g");
    while ((m = re.exec(t))) {
      if (availPos.includes(m.index)) continue;
      const v = toNum(m[1]);
      if (v > 0 && v <= 1000 && near(t, m.index, m[0].length, /rust|narust|rost|navys|rocne|za\s+rok|growth|grow\w*|increas\w*|annual\w*|yearly|per\s+year|a\s+year/, 40)) { p.growth = v / 100; break; }
    }
    const hz = t.match(/za\s+(\d+)\s*(?:let|roky|rok|roku)/) || t.match(/(?:in|over|within|next)\s+(\d+)\s*years?/);
    if (hz) p.horizon = Math.min(10, Math.max(1, parseInt(hz[1], 10)));
    if (p.growth > 0) found.push(l.growth(fmt(p.growth * 100), p.horizon));

    // špičky
    re = /spick\w*|sezon\w*|black\s*friday|kampan\w*|vanoc\w*|akcni\s+nabidk\w*|narazov\w*|burst|peak\w*|season\w*|campaign\w*|christmas|spike\w*/g;
    if ((m = re.exec(t))) {
      p.peak = 2;
      const w = t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).match(/(\d+(?:[.,]\d+)?)\s*(?:x|krat|nasobn\w*|nasobek|times|-?fold)/);
      if (w) p.peak = Math.min(10, Math.max(1, toNum(w[1])));
      found.push(l.peak(fmt(p.peak)));
    }
    p.found = found;
    return p;
  }

  const ceilGhz = (x) => Math.max(GHZ_PER_VCPU * 2, Math.ceil(x / GHZ_PER_VCPU - 1e-9) * GHZ_PER_VCPU);
  const ceilRam = (x) => RAM_STEPS.find((s) => s >= x - 1e-9 && s >= 4) || RAM_STEPS[RAM_STEPS.length - 1];
  const ceilDisk = (x) => Math.max(10, x <= 1000 ? Math.ceil(x / 10 - 1e-9) * 10 : Math.ceil(x / 100 - 1e-9) * 100);
  // kategorie role; anglické názvy (Application, Database, ...) se mapují na české klíče
  const CATKEY = { security: "Bezpečnost", application: "Aplikační", database: "Databázové", operations: "Provozní", development: "Vývojové" };
  const cat = (role) => { const c = String(role).split(" (")[0]; return CATKEY[c.toLowerCase()] || c; };
  const totals = (rows) => rows.reduce((t, r) => ({ vm: t.vm + r.count, ghz: t.ghz + r.count * r.ghz, ram: t.ram + r.count * r.ram, disk: t.disk + r.count * r.disk }), { vm: 0, ghz: 0, ram: 0, disk: 0 });

  // base: výchozí řádky use case (nemění se), vrací nové řádky a shrnutí
  // Efektivní zátěž (ekvivalent počtu uživatelů) včetně růstu, špiček a neprodukčního prostředí.
  const growthOf = (q) => Math.pow(1 + (q.growth || 0), q.horizon || HORIZON_DEFAULT);
  function load(q) {
    const c = [];
    if (q.users != null) c.push(q.users);
    if (q.concurrent != null) c.push(q.concurrent / BASE.concurrency);
    if (q.rps != null) c.push(q.rps / BASE.rps * BASE.users);
    return (c.length ? Math.max(...c) : BASE.users) * growthOf(q) * (q.peak || 1) * (q.nonprod ? 0.5 : 1);
  }

  // base: výchozí řádky use case (nemění se), p: nové zadání, p0: předpokládané zadání scénáře,
  // ke kterému výchozí hodnoty odpovídají (bez něj se počítá vůči BASE.users)
  function adjust(base, p, p0) {
    const growthF = growthOf(p);
    const u = load(p), u0 = p0 ? load(p0) : BASE.users;
    const f = Math.min(50, Math.max(0.2, Math.pow(u / u0, EXP)));
    // bez HA: výslovně, nebo neprodukční prostředí, pokud zadání dostupnost nežádá
    const noHa = p.ha === "none" || (p.nonprod && p.ha === "default");
    const floorApp = p.ha === "very" ? 3 : p.ha === "ha" ? 2 : noHa ? 1 : 2;
    const rows = base.map((r) => Object.assign({}, r));
    const dbDisks = rows.filter((r) => cat(r.role) === "Databázové").map((r) => r.disk);
    const maxDb = dbDisks.length ? Math.max(...dbDisks) : 0;
    // koeficient pro hlavní datová úložiště: vůči objemu dat v předpokládaném zadání, jinak vůči největšímu disku
    const D = p.dataGB == null ? f
      : p0 && p0.dataGB != null ? (p.dataGB * growthF) / (p0.dataGB * growthOf(p0))
      : maxDb ? (p.dataGB * growthF * 1.3) / maxDb : f;

    rows.forEach((r, i) => {
      const b = base[i], c = cat(r.role);
      if (FIXED.has(r.name)) { r.count = noHa ? 1 : b.count; return; }
      if (c === "Aplikační") {
        // bez zmínky o dostupnosti zůstává redundance z výchozího sizingu (nejvýše 2 instance)
        const floor = p.ha === "default" && !noHa ? Math.min(b.count, 2) : floorApp;
        const totG = b.count * b.ghz * f, totR = b.count * b.ram * f;
        r.count = Math.max(floor, Math.ceil(b.count * Math.min(f, 4) * (noHa ? 0.5 : 1) - 1e-9), Math.ceil(totG / GHZ_MAX - 1e-9), Math.ceil(totR / RAM_MAX - 1e-9));
        r.ghz = ceilGhz(totG / r.count);
        r.ram = ceilRam(totR / r.count);
      } else if (c === "Databázové") {
        const needG = b.ghz * f, needR = b.ram * f;
        const cnt = noHa ? 1 : p.ha === "very" ? Math.max(b.count, 3) : p.ha === "ha" ? Math.max(b.count, 2) : b.count;
        r.count = Math.max(cnt, Math.ceil(needG / GHZ_MAX - 1e-9), Math.ceil(needR / RAM_MAX - 1e-9));   // nad strop další uzly (repliky / shardy)
        r.ghz = ceilGhz(Math.min(needG, GHZ_MAX));
        r.ram = ceilRam(Math.min(needR, RAM_MAX));
        r.disk = ceilDisk(b.disk * (b.disk >= 0.5 * maxDb ? D : Math.pow(f, 0.5)));
      } else if (c === "Provozní") {
        r.count = noHa ? 1 : b.count;
        r.disk = ceilDisk(b.disk * Math.pow(f, 0.35));
      } else {
        r.count = noHa ? 1 : b.count;
      }
    });
    return { rows, f, users: u, before: totals(base), after: totals(rows) };
  }

  return { BASE, parse, adjust, totals, fmt, fmtGb, setLang: (x) => { LANG = x === "en" ? "en" : "cs"; }, getLang: () => LANG };
})();
if (typeof module !== "undefined") module.exports = SZ;
