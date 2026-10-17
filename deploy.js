// Pomocné funkce pro nasazení: převod řádků topologie na jednotlivé VM a kontrola vstupů. Čistá logika bez DOM.
const DP = (() => {
  const GHZ_PER_CORE = 2.5;            // stejné jako v cenách: 1 jádro = 2,5 GHz = 2 500 MHz
  const MIB = 1048576;
  const MAX_VMS = 50;
  const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

  // Název VM pro CloudSigma: malá písmena, čísla, tečka, podtržítko a pomlčka
  const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[^a-z0-9]+/, "").replace(/[-._]+$/, "");

  // Specifikace jedné VM v jednotkách CloudSigma: jádra po 2,5 GHz, celkem MHz, RAM v bajtech (celé MiB), disk v GiB
  function specOf(r) {
    const smp = Math.max(1, Math.ceil(r.ghz / GHZ_PER_CORE - 1e-9));
    return { smp, cpu_mhz: Math.round(smp * GHZ_PER_CORE * 1000), mem_bytes: Math.max(1, Math.round(r.ram * 1024)) * MIB,
             disk_gib: Math.max(1, Math.ceil(r.disk - 1e-9)), disk_tier: r.tier, ghz_requested: r.ghz, ghz_actual: smp * GHZ_PER_CORE };
  }

  // Rozbalí řádky topologie (počet × VM) na jednotlivé VM s jedinečnými názvy.
  // rows: [{key, name, role, count, ghz, ram, disk, tier}], prefix: předpona názvu
  function expand(rows, prefix) {
    const out = [], seen = new Set(), pre = slug(prefix || "");
    rows.forEach((r) => {
      const base = slug((pre ? pre + "-" : "") + r.name) || "vm", spec = specOf(r);
      for (let k = 1; k <= r.count; k++) {
        let name = (r.count > 1 ? base + "-" + k : base).slice(-64).replace(/^[^A-Za-z0-9]+/, ""), n = name, i = 2;
        while (seen.has(n)) n = name + "-" + (i++);
        seen.add(n);
        out.push(Object.assign({ name: n, role: r.role, row: r.key, net: r.net }, spec));
      }
    });
    return out;
  }

  // Kontrola vstupů; vrací kódy chyb a varování (text si doplňuje stránka podle jazyka)
  function validate(cfg, vms) {
    const errors = [], warnings = [];
    if (!UUID_RE.test(cfg.image || "")) errors.push({ code: "image" });
    if ((cfg.vlan || "").trim() && !UUID_RE.test(cfg.vlan.trim())) errors.push({ code: "vlan" });
    // VLAN po skupinách topologie: { název skupiny: UUID }; prázdná hodnota = skupina bez síťové karty
    Object.entries(cfg.vlans || {}).forEach(([group, id]) => { if ((id || "").trim() && !UUID_RE.test(id.trim())) errors.push({ code: "vlan", group }); });
    if ((cfg.key || "").trim() && !UUID_RE.test(cfg.key.trim())) errors.push({ code: "key", value: cfg.key });
    if (!vms.length) errors.push({ code: "none" });
    if (vms.length > MAX_VMS) errors.push({ code: "max", n: vms.length, max: MAX_VMS });
    vms.forEach((v) => { if (!NAME_RE.test(v.name)) errors.push({ code: "name", value: v.name }); });
    const rounded = {};
    vms.forEach((v) => { if (Math.abs(v.ghz_requested - v.ghz_actual) > 1e-9 && !rounded[v.row]) rounded[v.row] = v; });
    Object.values(rounded).forEach((v) => warnings.push({ code: "ghz", name: v.name, req: v.ghz_requested, act: v.ghz_actual, smp: v.smp }));
    return { errors, warnings };
  }

  return { GHZ_PER_CORE, MAX_VMS, UUID_RE, slug, specOf, expand, validate };
})();
if (typeof module !== "undefined") module.exports = DP;
