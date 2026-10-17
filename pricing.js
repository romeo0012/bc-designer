// Ceny IaaS a PaaS (cloudlety). Ceník a vzorce jsou převzaté z referenční aplikace
// https://iaas-api-mgmt-test.default.tmobile-demo.codenow.com/ (GET /api/pricing a main.js), stav k 2026-10-16.
// Všechny ceny jsou v Kč za měsíc.
const PR = (() => {
  const COMMITS = [0, 12, 24, 36];   // délka závazku v měsících (0 = bez závazku)
  const IAAS = {
    cpu: { 0: 157.06, 12: 108.73, 24: 102.69, 36: 96.65 },    // Kč / GHz
    ram: { 0: 68.33, 12: 47.3, 24: 44.68, 36: 42.05 },        // Kč / GiB
    disk: {                                                   // Kč / GB podle tieru
      "Super Fast": { 0: 4.55, 12: 3.15, 24: 2.98, 36: 2.8 },
      "Fast": { 0: 2.6, 12: 1.8, 24: 1.7, 36: 1.6 },
      "Standard": { 0: 1.95, 12: 1.35, 24: 1.28, 36: 1.2 },
      "Basic": { 0: 1.3, 12: 0.9, 24: 0.85, 36: 0.8 }
    }
  };
  const PAAS = {
    reserved: [98.84, 93.88, 88.91, 84.02, 79.06],   // Kč / cloudlet / měsíc, pásma 1–16, 17–32, 33–64, 65–128, 129+
    dynamic: [148.26, 144.54, 140.82, 137.09, 133.44],
    bands: [16, 32, 64, 128, Infinity],
    cloudRamMiB: 128, cloudCpuMHz: 400                // 1 cloudlet = 128 MiB RAM + 400 MHz CPU
  };
  const DEFAULTS = { commit: 12, util: 40, res: 35 };  // délka závazku, utilizace %, rezervace %
  // Přepočet měn: kurzy ČNB (Kč za 1 jednotku), denní kurz z 15. 10. 2026
  // (https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt).
  // Ceník je v Kč, ostatní měny jsou orientační přepočet. Kurzy se tu aktualizují ručně.
  const FX = { CZK: 1, EUR: 24.35, USD: 21.732, date: "2026-10-15" };
  const CURRENCIES = ["CZK", "EUR", "USD"];

  // Cena jedné VM: součet cen CPU, RAM a disku (bez zaokrouhlení, zaokrouhluje se až při zobrazení)
  function iaasVm(r, cm) {
    const c = COMMITS.includes(cm) ? cm : DEFAULTS.commit;
    const tier = IAAS.disk[r.tier] || IAAS.disk.Standard;
    const cpu = r.ghz * IAAS.cpu[c], ram = r.ram * IAAS.ram[c], disk = r.disk * tier[c];
    return { cpu, ram, disk, total: cpu + ram + disk };
  }
  // Počet cloudletů, které VM potřebuje (limitující je CPU nebo RAM)
  const cloudletsOf = (ghz, ram) => Math.ceil(Math.max(ghz / (PAAS.cloudCpuMHz / 1000), ram / (PAAS.cloudRamMiB / 1024)));
  // Cena po pásmech: prvních 16 cloudletů za první sazbu, dalších 16 za druhou atd.
  function bandCost(cl, rates, bands) {
    if (cl <= 0) return 0;
    let rem = cl, cost = 0, i = 0;
    while (rem > 0 && i < bands.length) { const take = Math.min(rem, bands[i]); cost += take * rates[i]; rem -= take; i++; }
    if (rem > 0) cost += rem * (rates[rates.length - 1] || 0);
    return cost;
  }

  // PaaS: rows = [{ghz, ram, count}], util a res v % (posuvníky Utilizace a Rezervace).
  // Rezervované cloudlety se platí vždy, dynamické jen do výše utilizace. Cloudlety VM = potřeba × max(rezervace, utilizace).
  function paas(rows, util, res) {
    const per = rows.map((r) => cloudletsOf(r.ghz, r.ram));
    const total = rows.reduce((s, r, i) => s + r.count * per[i], 0);
    const reserved = Math.ceil(total * (res / 100));
    const dynamic = Math.max(0, Math.ceil(total * (util / 100)) - reserved);
    const cost = bandCost(reserved, PAAS.reserved, PAAS.bands) + bandCost(dynamic, PAAS.dynamic, PAAS.bands);
    const billed = reserved + dynamic;
    const eff = billed > 0 ? cost / billed : 0;      // Ø cena placeného cloudletu (nikdy pod nejnižší sazbou pásma)
    const share = total > 0 ? cost / total : 0;      // podíl ceny na cloudlet potřebný VM, pro rozpis ceny po řádcích
    const factor = Math.max(util, res) / 100;
    return {
      total, reserved, dynamic, cost, eff,
      // na VM: placené cloudlety, z toho rezervované (podle posuvníku Rezervace, nejvýše placené) a zbytek dynamické
      rows: per.map((cl) => {
        const billed = Math.round(cl * factor), rsv = Math.min(billed, Math.round(cl * (res / 100)));
        return { cl, billedPerVm: billed, reservedPerVm: rsv, dynamicPerVm: billed - rsv, priceVm: Math.round(cl * share) };
      })
    };
  }

  return { COMMITS, IAAS, PAAS, DEFAULTS, FX, CURRENCIES, iaasVm, cloudletsOf, bandCost, paas };
})();
if (typeof module !== "undefined") module.exports = PR;
