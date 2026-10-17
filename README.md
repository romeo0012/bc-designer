# bc-designer (Business Cloud Solution Designer)

Webová aplikace, která provede uživatele od obchodního zadání k návrhu infrastruktury, ceně a provozu Kubernetes clusteru. Vznikla na hackathonu (Business Cloud IaaS / PaaS).

Aplikace je **statická** (HTML + JavaScript, bez backendu a bez buildu), čeština a angličtina. Všechny výpočty a simulace běží v prohlížeči. **Nic se nikam neposílá a nic se nevytváří**, dokud není zapnutá exekuce (viz [Stav a plány](#stav-a-plány)).

## Co aplikace dělá

1. **Výběr use-case.** Předpřipravené scénáře: Kubernetes Cluster, Webová aplikace, E-commerce, Mikroslužby, API Gateway, Interní podnikové aplikace, Datová platforma a Event streaming.
2. **Sizing.** Pro každý use-case navrhne VM: vCPU, paměť, disk a třídu disku (Standard / Fast / Super Fast). Výkon ze schématu v GHz se převádí na vCPU (1 vCPU = 2,5 GHz). Dva pohledy:
   - *Business* popisuje funkce srozumitelně pro zadavatele,
   - *Architekt* ukazuje každou VM se všemi parametry.
3. **Chat s požadavky.** Zadání lze napsat vlastními slovy (počet uživatelů, dostupnost, objem dat, růst, špičky, prostředí) a sizing se přepočítá. Jde o pravidlové rozpoznání vzorů v textu, **bez AI**.
4. **Ceny IaaS a PaaS.**
   - IaaS se počítá ze sazeb za CPU, paměť a disk podle délky závazku (bez závazku, 12, 24, 36 měsíců).
   - PaaS vychází z cloudletů, posuvníků utilizace a rezervace a z objemových pásem.
   - Měny: Kč, EUR, USD.
   - Ceník a vzorce jsou převzaté z referenční aplikace, stav k 16. 10. 2026.
5. **Deploy VM (simulace).** Simuluje vytvoření VM v Business Cloud IaaS přímými voláními API (create → clone → wait → resize → attach → start). Každá skupina (větev) topologie má vlastní VLAN. Volí se v záhlaví skupiny, předvyplní se podle názvu skupiny a všechny VM skupiny se připojí do ní (skupina bez VLAN se vytvoří bez síťové karty). Karty VM se barví podle stavu (plánováno, ve frontě, nasazuje se, hotovo), dole běží protokol volání. Rychlost simulace jde měnit, lze simulovat chybu a stav přežije obnovení stránky.
6. **Deploy Kubernetes (simulace).** Nad stejnou topologií simuluje instalaci clusteru: příprava uzlů, containerd, kubeadm init, síť Calico, připojení workerů, ověření a add-ony (Grafana, Hello World). Běh lze zastavit nebo simulovat chybu.
7. **Provozní asistent.** Hlídá zdraví simulovaného clusteru: dashboardy Grafana a Kibana, detekce incidentů (nedostupný uzel, nezdravé etcd, pád aplikace, ImagePullBackOff a další) a jejich oprava. V chatu stačí napsat např. „Oprav aplikaci“.
8. **Dokumentace.** Historie všech nasazení včetně konfigurace a volání API, plus provozní příručky pro Kubernetes a aplikace (postupy, příkazy, řešení incidentů) ke stažení jako Markdown.

## Struktura repozitáře

| Soubor | Obsah |
|---|---|
| `index.html` | Celá aplikace (UI, záložky, chat, dokumentace) |
| `usecases.js` | Data use-case a jejich komponent (sdílí je `index.html` a `use-case.html`) |
| `sizing.js` | Pravidlový přepočet sizingu podle textového zadání |
| `pricing.js` | Ceny IaaS a PaaS, cloudlety, objemová pásma |
| `deploy.js` | Převod topologie na jednotlivé VM a validace vstupů |
| `deployer.js` | Postup nasazení VM voláními API |
| `cloudsim.js` | Simulovaný cloud (chová se jako CloudSigma API 2.0, běží v prohlížeči) |
| `k8sinstall.js` | Simulace instalace Kubernetes |
| `selfheal.js` | Simulace samoopravného nástroje a katalog incidentů |
| `i18n.js` | Překlady cs / en |
| `use-case.html` | Přesměrování na výběr use-case |
| `k8s.yaml` | Nasazení do Kubernetes (ConfigMap + Deployment + Service) |
| `ingress.yaml` | Ingress |
| `archiv/` | Starší verze a původní nasazovací skript v Pythonu |

## Spuštění lokálně

Není třeba nic instalovat ani sestavovat. Stačí spustit jednoduchý HTTP server a otevřít stránku:

```bash
python3 -m http.server 8080
# http://localhost:8080
```

## Nasazení do Kubernetes

Manifest `k8s.yaml` vytvoří v namespace `hackaithon`:

- **ConfigMap** `bc-designer` se soubory aplikace,
- **Deployment** `bc-designer` (`nginx:1.27-alpine`), ConfigMap je připojená do `/usr/share/nginx/html`,
- **Service** `bc-designer` na portu 80.

ConfigMap je větší než 256 kB, proto se `k8s.yaml` musí aplikovat s `--server-side`. Obyčejné `kubectl apply` selže s chybou „metadata.annotations: Too long“.

`ingress.yaml` publikuje aplikaci na `dev-kube.prg1paas.t-cloud.eu` pod cestou `/hackaithon`.

```bash
kubectl create namespace hackaithon   # pokud ještě neexistuje
kubectl apply --server-side --force-conflicts -f k8s.yaml
kubectl apply -f ingress.yaml
kubectl -n hackaithon rollout status deployment/bc-designer
```

Po změně souborů aplikace je potřeba ConfigMapu přegenerovat (obsah souborů je v `k8s.yaml` vložený) a znovu aplikovat. Soubor je velký (stovky kB), protože obsahuje celou aplikaci. Při přegenerování zůstávají Deployment a Service beze změny, mění se jen sekce ConfigMap:

```bash
kubectl create configmap bc-designer -n hackaithon --dry-run=client -o yaml \
  --from-file=brand.jpg --from-file=cloudsim.js --from-file=deploy.js --from-file=deployer.js \
  --from-file=i18n.js --from-file=index.html --from-file=k8sinstall.js --from-file=pricing.js \
  --from-file=selfheal.js --from-file=sizing.js --from-file=use-case.html --from-file=usecases.js
```

Po `kubectl apply` se obsah ConfigMapy v podech aktualizuje sám (adresář je připojený bez `subPath`, obvykle do minuty). Restart není nutný. Prohlížeč může mít staré soubory v cache, pomůže tvrdé obnovení stránky.

## Stav a plány

- Nasazení VM a Kubernetes i provozní asistent jsou zatím **simulace**. Přepínač Simulace / Exekuce, plán volání a mapování na nástroje MCP serveru jsou připravené, ale exekuce je vypnutá.
- MCP server zatím umí jen čtení a start VM. Pro ostré nasazení chybí nástroje pro vytvoření VM, klon disku, zvětšení disku a připojení disku.
- Další krok: zapnout exekuci přes MCP server se zápisovými nástroji a schvalováním a napojit živý tenant.
