#!/usr/bin/env python3
"""Vytvoření VM v Business Cloud IaaS (CloudSigma API 2.0) podle plánu ze stránky "Deployment mód".

Postup a formáty zápisů jsou převzaté z aplikace cloudsigma-interactive (cs/cloudsigma_menu.py, README
"Recommended new VM workflow"):

  1. POST servers/                              vytvoří VM (zastavenou)
  2. POST libdrives/<image>/action/?do=clone    naklonuje předinstalovaný Linux image
  3. čekání na dokončení klonování              jen čtení: GET drives/<uuid>/
  4. PUT  drives/<uuid>/                        zvětší disk na požadovanou velikost (jen zvětšení, odpojený disk)
  5. PUT  servers/<uuid>/                       připojí disk (virtio, 0:0, boot_order 1), VLAN a SSH klíče
  6. GET  servers/<uuid>/                       ověření
  7. POST servers/<uuid>/action/?do=start       jen s --start

Bezpečnost (stejné zásady jako v aplikaci):
  * Výchozí je DRY-RUN: nic se nezapisuje, nečtou se přihlašovací údaje a nevolá se síť.
  * Zápis vyžaduje --execute, CS_PROVISIONING_ENABLED=true, interaktivní terminál a ruční opsání potvrzení.
  * Přihlášení (heslo + OTP) řeší IaaSClient z aplikace, tento skript hesla ani OTP nečte ani nevypisuje.
  * Zápisy se při chybě NEOPAKUJÍ a nic se nemaže. Při chybě se vypíše, co už vzniklo.
  * Audit zapisuje jen povolené metadata (metoda, zdroj, UUID, stav), nikdy payloady, cookies ani hesla.

Použití (z adresáře mcp-server):
  python3 cloudsigma_deploy.py --list-images                   # jen čtení: seznam image pro výběr ve stránce
  python3 cloudsigma_deploy.py plan.json                      # dry-run
  CS_PROVISIONING_ENABLED=true .venv/bin/python cloudsigma_deploy.py plan.json --execute --only demo-web-1
"""
import argparse
import hashlib
import json
import os
import re
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1
# Kroky nasazení jedné VM (stejné identifikátory čte stránka v panelu Průběh nasazení)
STEPS = ['create', 'clone', 'wait', 'resize', 'attach', 'verify', 'start']
MAX_VMS = 50
MAX_CPU_MHZ = 100000000
UUID_RE = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
GIB = 1024 ** 3
MIB = 1048576


# ---------- plán: kanonický JSON, kontrolní součet, validace ----------

def canonical(obj):
    """Stejný zápis jako ve stránce: seřazené klíče, bez mezer, UTF-8."""
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def plan_checksum(plan):
    body = {k: v for k, v in plan.items() if k != 'checksum'}
    return hashlib.sha256(canonical(body).encode('utf-8')).hexdigest()[:16]


def is_uuid(value):
    return isinstance(value, str) and bool(UUID_RE.match(value))


def validate_plan(plan):
    """Vrátí seznam chyb (prázdný = plán je v pořádku)."""
    errors = []
    if not isinstance(plan, dict):
        return ['Plán musí být JSON objekt']
    if plan.get('version') != SCHEMA_VERSION:
        errors.append('Nepodporovaná verze plánu: %r (očekáváno %d)' % (plan.get('version'), SCHEMA_VERSION))
    if plan.get('checksum') and plan['checksum'] != plan_checksum(plan):
        errors.append('Kontrolní součet neodpovídá: plán byl po vygenerování změněn')
    opts = plan.get('options')
    if not isinstance(opts, dict):
        return errors + ['Chybí sekce options']
    if not is_uuid(opts.get('image_uuid')):
        errors.append('options.image_uuid musí být UUID předinstalovaného image (library drive)')
    if opts.get('vlan_uuid') not in (None, '') and not is_uuid(opts.get('vlan_uuid')):
        errors.append('options.vlan_uuid není platné UUID')
    keys = opts.get('pubkey_uuids') or []
    if not isinstance(keys, list) or not all(is_uuid(k) for k in keys):
        errors.append('options.pubkey_uuids musí být seznam UUID')
    tiers = opts.get('tier_uuids') or {}
    if not isinstance(tiers, dict) or not all(isinstance(k, str) and is_uuid(v) for k, v in tiers.items()):
        errors.append('options.tier_uuids musí mapovat název tieru na UUID')
    vms = plan.get('vms')
    if not isinstance(vms, list) or not vms:
        return errors + ['Plán neobsahuje žádné VM']
    if len(vms) > MAX_VMS:
        errors.append('Příliš mnoho VM v jednom plánu (%d, maximum %d)' % (len(vms), MAX_VMS))
    seen = set()
    for i, vm in enumerate(vms):
        where = 'vms[%d]' % i
        if not isinstance(vm, dict):
            errors.append(where + ': není objekt')
            continue
        name = vm.get('name')
        if not isinstance(name, str) or not NAME_RE.match(name):
            errors.append('%s: neplatný název %r (písmena, čísla, . _ -, max 64 znaků)' % (where, name))
        elif name in seen:
            errors.append('%s: duplicitní název %s' % (where, name))
        seen.add(name)
        for field, lo, hi in (('smp', 1, 256), ('cpu_mhz', 1, MAX_CPU_MHZ), ('disk_gib', 1, 65536)):
            v = vm.get(field)
            if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
                errors.append('%s.%s musí být celé číslo %d až %d' % (where, field, lo, hi))
        mem = vm.get('mem_bytes')
        if not isinstance(mem, int) or isinstance(mem, bool) or mem <= 0 or mem % MIB:
            errors.append('%s.mem_bytes musí být kladný násobek 1 MiB' % where)
    return errors


# ---------- kroky (pro dry-run i pro provedení) ----------

def spec_of(vm, vnc_password):
    return {'name': vm['name'], 'cpu': vm['cpu_mhz'], 'mem': vm['mem_bytes'], 'smp': vm['smp'], 'vnc_password': vnc_password}


def planned_calls(vm, opts, start):
    """Popis volání API pro jednu VM (pro dry-run). Hodnoty z odpovědí jsou zástupné."""
    calls = [
        ('POST', 'servers/', None, {'objects': [spec_of(vm, '<náhodné heslo VNC>')]}),
        ('POST', 'libdrives/%s/action/' % opts['image_uuid'], {'do': 'clone'}, {'name': vm['name'] + '-root'}),
        ('GET', 'drives/<uuid disku>/', None, 'čekání, až klonování skončí (status unmounted)'),
        ('PUT', 'drives/<uuid disku>/', None, {'size': vm['disk_gib'] * GIB, 'poznámka': 'jen pokud je větší než image'}),
        ('PUT', 'servers/<uuid VM>/', None, {'drives': [{'drive': '<uuid disku>', 'device': 'virtio', 'dev_channel': '0:0', 'boot_order': 1}],
                                              'nics': [{'model': 'virtio', 'vlan': opts.get('vlan_uuid')}] if opts.get('vlan_uuid') else [],
                                              'pubkeys': list(opts.get('pubkey_uuids') or [])}),
        ('GET', 'servers/<uuid VM>/', None, 'ověření připojeného disku'),
    ]
    if start:
        calls.append(('POST', 'servers/<uuid VM>/action/', {'do': 'start'}, {}))
    return calls


def print_plan(plan, vms, start):
    opts = plan['options']
    total_ram = sum(v['mem_bytes'] for v in vms) / GIB
    print('Plán %s | scénář: %s | VM: %d | CPU: %d MHz | RAM: %.1f GiB | disk: %d GiB'
          % (plan.get('checksum') or plan_checksum(plan), (plan.get('scenario') or {}).get('name', '-'), len(vms),
             sum(v['cpu_mhz'] for v in vms), total_ram, sum(v['disk_gib'] for v in vms)))
    print('Image: %s | VLAN: %s | SSH klíčů: %d | start po vytvoření: %s'
          % (opts['image_uuid'], opts.get('vlan_uuid') or 'bez NIC', len(opts.get('pubkey_uuids') or []), 'ano' if start else 'ne'))
    if opts.get('tier_uuids'):
        print('Tier disku: bude nastaven podle options.tier_uuids (formát zápisu v aplikaci není ověřen).')
    else:
        print('Tier disku: API se nenastavuje (disk dostane výchozí tier image); požadovaný tier je jen informativní.')
    print()
    print('%-34s %5s %9s %9s %9s  %s' % ('VM', 'vCPU', 'MHz', 'RAM MiB', 'Disk GiB', 'tier'))
    for v in vms:
        print('%-34s %5d %9d %9d %9d  %s' % (v['name'], v['smp'], v['cpu_mhz'], v['mem_bytes'] // MIB, v['disk_gib'], v.get('disk_tier', '-')))


def dry_run(plan, vms, start):
    print_plan(plan, vms, start)
    print()
    print('DRY-RUN: nic se nezapisuje a nevolá se síť. Volání API pro každou VM:')
    opts = plan['options']
    for n, vm in enumerate(vms, 1):
        print('\n[%d/%d] %s' % (n, len(vms), vm['name']))
        for method, path, params, body in planned_calls(vm, opts, start):
            q = ('?do=' + params['do']) if params else ''
            detail = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
            print('  %-4s %s%s  %s' % (method, path, q, detail))
    print('\nPro skutečné vytvoření: CS_PROVISIONING_ENABLED=true python cloudsigma_deploy.py <plán> --execute [--only NÁZEV] [--start]')


# ---------- práce s API (jen při --execute) ----------

class Progress(object):
    """Zápis průběhu nasazení do souboru JSONL, který čte stránka (panel Průběh nasazení).
    Obsahuje jen identifikátory kroků, stavy, krátké diagnostiky a UUID vzniklých zdrojů, nikdy payloady ani hesla."""

    def __init__(self, path, plan_id):
        self.path = Path(path)
        self.plan = plan_id

    def emit(self, ev, **fields):
        record = {'t': datetime.now(timezone.utc).isoformat(), 'ev': ev, 'plan': self.plan}
        record.update({k: v for k, v in fields.items() if v is not None})
        if self.path.is_symlink():
            raise RuntimeError('Cesta souboru s průběhem nesmí být symbolický odkaz')
        fd = os.open(str(self.path), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, 'a', encoding='utf-8') as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + '\n')

    def step(self, vm, step, status, detail=None, uuid=None):
        self.emit('step', vm=vm, step=step, status=status, detail=(str(detail)[:240] if detail else None), uuid=uuid)


class Api(object):
    """Tenký obal nad IaaSClient z aplikace; zápisy se nikdy automaticky neopakují."""
    ALLOWED = ('error_type', 'error_point', 'error_message', 'error', 'message', 'detail', 'code')

    def __init__(self, client, audit_path):
        self.client = client
        self.audit_path = Path(audit_path)

    def audit(self, method, path, params, status, http_status=None):
        parts = path.split('?')[0].strip('/').split('/')
        target = next((x for x in parts if UUID_RE.match(x)), None)
        op = params.get('do') if isinstance(params, dict) and re.fullmatch(r'[a-zA-Z_]{1,40}', str(params.get('do', ''))) else None
        record = {'time_utc': datetime.now(timezone.utc).isoformat(), 'source': 'cloudsigma-deploy-plan', 'method': method,
                  'resource': parts[0] if parts else '-', 'operation': op or method.lower(), 'target_uuid': target,
                  'status': status, 'http_status': http_status}
        if self.audit_path.is_symlink():
            raise RuntimeError('Cesta auditního logu nesmí být symbolický odkaz')
        fd = os.open(str(self.audit_path), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, 'a', encoding='utf-8') as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + '\n')

    def get(self, path, params=None):
        try:
            return self.client.request('GET', path, params=params)
        except Exception as exc:
            raise RuntimeError('GET %s selhal (%s)' % (path.split('/')[0], type(exc).__name__))

    def write(self, method, path, data, params=None):
        status = None
        try:
            self.client.login()
            r = self.client.session.request(method, self.client._url(path), json=data, params=params, timeout=90)
            status = r.status_code
            if not r.ok:
                try:
                    raw = r.json()
                except ValueError:
                    raw = None
                errors = []
                rows = raw[:10] if isinstance(raw, list) else [raw] if isinstance(raw, dict) else []
                for entry in rows:
                    if isinstance(entry, dict):
                        errors.append({k: str(entry[k])[:240] for k in self.ALLOWED if entry.get(k) is not None})
                raise RuntimeError('CloudSigma HTTP %s; diagnostika API: %s' % (r.status_code, json.dumps(errors, ensure_ascii=False)))
            response = r.json() if r.content else {}
        except Exception:
            self.audit(method, path, params, 'failed', status)
            raise
        self.audit(method, path, params, 'success', status)
        return response

    def all_items(self, resource, maximum=1000):
        rows, offset, seen = [], 0, set()
        while len(rows) < maximum:
            batch = self.get(resource + '/', {'limit': min(100, maximum - len(rows)), 'offset': offset}).get('objects') or []
            if not batch:
                break
            signature = tuple((x.get('uuid'), x.get('poll_time')) for x in batch)
            if signature in seen:
                break
            seen.add(signature)
            rows.extend(batch)
            offset += len(batch)
        return rows


def first_uuid(response, what):
    objects = (response or {}).get('objects') or []
    value = objects[0].get('uuid') if objects and isinstance(objects[0], dict) else None
    if not is_uuid(value):
        raise RuntimeError('API nevrátilo UUID pro %s; nic dalšího se neprovádí' % what)
    return value


def drive_ref(entry):
    value = entry.get('drive')
    return value.get('uuid') if isinstance(value, dict) else value


def deploy_vm(api, vm, opts, start, wait_seconds, interval=5, log=print, progress=None):
    """Vytvoří jednu VM. Vrací slovník s UUID vzniklých zdrojů (i při chybě je k dispozici v výjimce).
    progress: funkce (vm, krok, stav, detail, uuid) pro sledování průběhu ve stránce."""
    created = {'name': vm['name']}
    current = ['create']

    def report(step, status, detail=None, uuid=None):
        current[0] = step
        if progress:
            progress(vm['name'], step, status, detail, uuid)

    try:
        report('create', 'running')
        res = api.write('POST', 'servers/', {'objects': [spec_of(vm, secrets.token_urlsafe(24))]})
        created['vm'] = first_uuid(res, 'VM %s' % vm['name'])
        report('create', 'ok', uuid=created['vm'])
        log('  VM vytvořena: %s' % created['vm'])

        report('clone', 'running')
        res = api.write('POST', 'libdrives/%s/action/' % opts['image_uuid'], {'name': vm['name'] + '-root'}, {'do': 'clone'})
        created['disk'] = first_uuid(res, 'naklonovaný disk')
        report('clone', 'ok', uuid=created['disk'])
        log('  klonování image zahájeno: %s' % created['disk'])

        report('wait', 'running')
        started, last_note = time.monotonic(), 0
        deadline = started + wait_seconds
        while True:
            detail = api.get('drives/%s/' % created['disk'] + '')
            if detail.get('status') == 'unmounted' and not detail.get('mounted_on'):
                report('wait', 'ok', 'klonování trvalo %d s' % (time.monotonic() - started))
                break
            if detail.get('status') in ('cloning_dst', 'creating'):
                if progress and time.monotonic() - last_note >= 15:
                    last_note = time.monotonic()
                    report('wait', 'running', 'stav disku: %s, uplynulo %d s' % (detail.get('status'), time.monotonic() - started))
                if time.monotonic() > deadline:
                    raise RuntimeError('Klonování disku neskončilo do %d s; zkontrolujte disk %s' % (wait_seconds, created['disk']))
                time.sleep(interval)
                continue
            raise RuntimeError('Neočekávaný stav disku: %s' % detail.get('status'))

        size, want = int(detail.get('size') or 0), vm['disk_gib'] * GIB
        if want > size:
            report('resize', 'running')
            body = {'name': detail.get('name') or vm['name'] + '-root', 'size': want}
            for field in ('media', 'storage_type'):
                if detail.get(field) is not None:
                    body[field] = detail[field]
            tier = (opts.get('tier_uuids') or {}).get(vm.get('disk_tier'))
            if tier:
                body['tier'] = tier          # UUID-only formát nebyl v aplikaci ověřen živým zápisem
            api.write('PUT', 'drives/%s/' % created['disk'], body)
            for attempt in range(12):
                fresh_disk = api.get('drives/%s/' % created['disk'])
                if int(fresh_disk.get('size') or 0) == want:
                    break
                time.sleep(2)
            else:
                raise RuntimeError('Velikost disku se po zápisu neověřila; zkontrolujte disk %s' % created['disk'])
            log('  disk zvětšen na %d GiB' % vm['disk_gib'])
            report('resize', 'ok', 'na %d GiB' % vm['disk_gib'])
        elif want < size:
            log('  POZOR: image má %.1f GiB, požadováno %d GiB; disk se nezmenšuje' % (size / GIB, vm['disk_gib']))
            report('resize', 'skipped', 'image má %.1f GiB, disk se nezmenšuje' % (size / GIB))
        else:
            report('resize', 'skipped', 'disk má už požadovanou velikost')

        report('attach', 'running')
        fresh = api.get('servers/%s/' % created['vm'])
        if fresh.get('status') != 'stopped':
            raise RuntimeError('VM není zastavená, připojení disku se neprovede')
        for field in ('name', 'cpu', 'mem', 'smp', 'vnc_password'):
            if fresh.get(field) in (None, ''):
                raise RuntimeError('VM postrádá povinné pole %s' % field)
        body = {k: fresh[k] for k in ('name', 'cpu', 'mem', 'smp', 'vnc_password')}
        body['drives'] = [{'drive': created['disk'], 'device': 'virtio', 'dev_channel': '0:0', 'boot_order': 1}]
        body['nics'] = [{'model': 'virtio', 'vlan': opts['vlan_uuid']}] if opts.get('vlan_uuid') else []
        if opts.get('pubkey_uuids'):
            body['pubkeys'] = list(opts['pubkey_uuids'])     # ověřený formát tenantu: seznam holých UUID
        for field in ('context', 'meta'):
            if field in fresh:
                body[field] = fresh[field]
        api.write('PUT', 'servers/%s/' % created['vm'], body)
        report('attach', 'ok', ('síť nastavena' if opts.get('vlan_uuid') else 'bez NIC') + (', SSH klíče přiřazeny' if opts.get('pubkey_uuids') else ''))

        report('verify', 'running')
        verified = api.get('servers/%s/' % created['vm'])
        if created['disk'] not in [drive_ref(d) for d in (verified.get('drives') or [])]:
            raise RuntimeError('API zápis přijalo, ale disk není u VM připojený; zkontrolujte VM %s' % created['vm'])
        log('  disk připojen%s%s' % (', síť nastavena' if opts.get('vlan_uuid') else ', bez NIC',
                                    ', SSH klíče přiřazeny' if opts.get('pubkey_uuids') else ''))
        report('verify', 'ok')

        if start:
            report('start', 'running')
            api.write('POST', 'servers/%s/action/' % created['vm'], {}, {'do': 'start'})
            log('  start požadavek přijat')
            report('start', 'ok', 'požadavek přijat')
        else:
            report('start', 'skipped', 'bez --start')
    except Exception as exc:
        exc.created = created
        if progress:
            progress(vm['name'], current[0], 'failed', str(exc), None)
        raise
    return created


def load_env(mcp_dir):
    """Načte mcp-server/.env stejně jako aplikace; hodnoty se nikde nevypisují."""
    env_file = Path(mcp_dir) / '.env'
    try:
        from dotenv import load_dotenv
        load_dotenv(env_file)
        return
    except ImportError:
        pass
    if env_file.is_file():
        for line in env_file.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def find_mcp_dir(explicit):
    candidates = [explicit] if explicit else [Path.cwd(), Path(__file__).resolve().parent]
    for c in candidates:
        if c and (Path(c) / 'clients' / 'iaas.py').is_file():
            return Path(c).resolve()
    return None


def list_images(args):
    """Jen čtení: uloží seznam předinstalovaných image z knihovny tenantu do souboru, ze kterého je vybírá stránka.
    Filtr stejný jako v aplikaci (clone_image): image_type=preinst, media=disk, ne deprecated."""
    mcp_dir = find_mcp_dir(args.mcp_dir)
    if mcp_dir is None:
        print('Nenalezen adresář mcp-server s clients/iaas.py; použijte --mcp-dir.', file=sys.stderr)
        return 3
    try:
        load_env(mcp_dir)
        sys.path.insert(0, str(mcp_dir))
        from clients.iaas import IaaSClient            # přihlášení heslem a OTP řeší aplikace
        api = Api(IaaSClient(), args.audit_log)
        api.client.login()
        items = api.all_items('libdrives')
    except Exception as exc:
        print('Načtení knihovny image selhalo (%s); nic se nezměnilo.' % type(exc).__name__, file=sys.stderr)
        return 1
    images = []
    for x in items:
        if x.get('image_type') == 'preinst' and x.get('media') == 'disk' and not x.get('deprecated') and is_uuid(x.get('uuid')):
            size = x.get('size')
            images.append({'uuid': x['uuid'], 'name': str(x.get('name') or '-')[:120],
                           'size_gib': round(int(size) / GIB, 1) if isinstance(size, (int, str)) and str(size).isdigit() else None})
    images.sort(key=lambda i: i['name'].lower())
    out = Path(args.output)
    if out.is_symlink():
        print('Výstupní soubor nesmí být symbolický odkaz.', file=sys.stderr)
        return 3
    payload = {'version': 1, 'generated_utc': datetime.now(timezone.utc).isoformat(), 'images': images}
    fd = os.open(str(out), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    print('Uloženo %d image do %s (jen čtení, nic se nezměnilo). Načtěte soubor ve stránce tlačítkem Vybrat image z knihovny.' % (len(images), out))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description='Vytvoření VM v Business Cloud IaaS podle plánu ze stránky Deployment mód (výchozí je dry-run).')
    ap.add_argument('plan', nargs='?', help='soubor plan.json stažený ze stránky')
    ap.add_argument('--list-images', action='store_true', help='jen čtení: uloží seznam image z knihovny tenantu (pro výběr ve stránce)')
    ap.add_argument('--output', default='library_images.json', metavar='SOUBOR', help='cíl pro --list-images (výchozí library_images.json)')
    ap.add_argument('--execute', action='store_true', help='skutečně zapisovat do API (jinak dry-run)')
    ap.add_argument('--start', action='store_true', help='po vytvoření VM spustit (výchozí: nespouštět)')
    ap.add_argument('--only', action='append', default=[], metavar='NÁZEV', help='vytvořit jen vybrané VM (lze opakovat)')
    ap.add_argument('--mcp-dir', help='adresář mcp-server (s clients/iaas.py a .env); výchozí aktuální adresář')
    ap.add_argument('--audit-log', default=str(Path(__file__).resolve().parent / 'deploy_audit.jsonl'))
    ap.add_argument('--wait-clone', type=int, default=900, metavar='SEKUNDY', help='maximální čekání na klonování disku')
    ap.add_argument('--progress-file', metavar='SOUBOR', help='kam zapisovat průběh pro stránku (výchozí: <plán>.progress.jsonl vedle plánu)')
    ap.add_argument('--poll-interval', type=int, default=5, metavar='SEKUNDY', help='jak často kontrolovat stav klonování (jen čtení)')
    args = ap.parse_args(argv)
    if args.list_images:
        return list_images(args)
    if not args.plan:
        ap.error('chybí soubor plánu (nebo použijte --list-images)')

    try:
        plan = json.loads(Path(args.plan).read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        print('Plán nelze načíst: %s' % exc, file=sys.stderr)
        return 2
    errors = validate_plan(plan)
    if errors:
        print('Plán je neplatný:\n  - ' + '\n  - '.join(errors), file=sys.stderr)
        return 2
    vms = plan['vms']
    if args.only:
        unknown = [n for n in args.only if n not in [v['name'] for v in vms]]
        if unknown:
            print('V plánu nejsou VM: ' + ', '.join(unknown), file=sys.stderr)
            return 2
        vms = [v for v in vms if v['name'] in args.only]
    start = bool(args.start or plan['options'].get('start_after_create'))

    if not args.execute:
        dry_run(plan, vms, start)
        return 0

    # ---- skutečné provedení: stejné pojistky jako v aplikaci ----
    if os.environ.get('CS_PROVISIONING_ENABLED', '').lower() != 'true':
        print('Zápisy jsou vypnuté. Spusťte s CS_PROVISIONING_ENABLED=true (nic se nezměnilo).', file=sys.stderr)
        return 3
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        print('Pro zápis je nutný interaktivní terminál (potvrzení se opisuje ručně).', file=sys.stderr)
        return 3
    mcp_dir = find_mcp_dir(args.mcp_dir)
    if mcp_dir is None:
        print('Nenalezen adresář mcp-server s clients/iaas.py; použijte --mcp-dir.', file=sys.stderr)
        return 3

    print_plan(plan, vms, start)
    phrase = 'CREATE %d VM' % len(vms)
    print('\nTÍMTO VZNIKNOU SKUTEČNÉ ZDROJE A NÁKLADY v Business Cloud IaaS. Nic se nemaže ani nevrací zpět.')
    if input('Pro potvrzení opište přesně "%s" (cokoli jiného zruší): ' % phrase).strip() != phrase:
        print('Zrušeno, nic se nezměnilo.')
        return 0

    progress_path = args.progress_file or str(Path(args.plan).with_suffix('')) + '.progress.jsonl'
    prog = Progress(progress_path, plan.get('checksum') or plan_checksum(plan))
    prog.emit('run_start', total=len(vms), steps=STEPS, vms=[v['name'] for v in vms])
    print('Průběh se zapisuje do: %s (připojte ho ve stránce v panelu Průběh nasazení)' % progress_path)

    try:
        load_env(mcp_dir)
        sys.path.insert(0, str(mcp_dir))
        from clients.iaas import IaaSClient            # přihlášení heslem a OTP řeší aplikace
        api = Api(IaaSClient(), args.audit_log)
        api.client.login()
        existing = set(x.get('name') for x in api.all_items('servers'))
    except Exception as exc:
        prog.emit('run_end', status='failed', detail='Přihlášení nebo načtení seznamu VM selhalo (%s)' % type(exc).__name__)
        print('Přihlášení nebo načtení seznamu VM selhalo (%s); nic se nevytvářelo.' % type(exc).__name__, file=sys.stderr)
        return 1
    clash = [v['name'] for v in vms if v['name'] in existing]
    if clash:
        prog.emit('run_end', status='failed', detail='VM se stejným názvem už existují: ' + ', '.join(clash))
        print('VM se stejným názvem už existují, nic se nevytvářelo: ' + ', '.join(clash), file=sys.stderr)
        return 3

    done = []
    try:
        for n, vm in enumerate(vms, 1):
            print('\n[%d/%d] %s' % (n, len(vms), vm['name']))
            try:
                done.append(deploy_vm(api, vm, plan['options'], start, args.wait_clone, args.poll_interval, progress=prog.step))
                prog.emit('vm_end', vm=vm['name'], status='ok')
            except Exception as exc:
                prog.emit('vm_end', vm=vm['name'], status='failed', detail=str(exc)[:240])
                prog.emit('run_end', status='failed', detail='Chyba u %s; zbývající VM se nevytvářely' % vm['name'])
                print('\nCHYBA u %s: %s' % (vm['name'], exc), file=sys.stderr)
                print('Zápisy se neopakují a nic se nemaže. Co už vzniklo:', file=sys.stderr)
                for item in done + [getattr(exc, 'created', {'name': vm['name']})]:
                    print('  %s' % json.dumps(item, ensure_ascii=False), file=sys.stderr)
                return 1
    except KeyboardInterrupt:
        prog.emit('run_end', status='cancelled', detail='Přerušeno uživatelem; co už vzniklo, zůstává')
        print('\nPřerušeno. Co už vzniklo, zůstává (nic se nemaže).', file=sys.stderr)
        return 130
    prog.emit('run_end', status='ok', detail='Vytvořeno VM: %d' % len(done))
    print('\nHotovo. Vytvořeno VM: %d' % len(done))
    for item in done:
        print('  %s | VM %s | disk %s' % (item['name'], item.get('vm'), item.get('disk')))
    if not start:
        print('VM jsou zastavené. Spusťte je odděleně, až ověříte konfiguraci (např. v aplikaci cs/cloudsigma.sh).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
