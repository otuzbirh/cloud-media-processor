# Cloud Media Processor

Cloud Media Processor je eksperimentalna web aplikacija za batch optimizaciju fotografija. Korisnik učitava JPEG, PNG ili WebP datoteke, bira format, kvalitet i maksimalnu širinu, a obrada se izvršava asinhrono preko reda poslova i skalabilnih worker procesa.

Projekat je namjerno podijeljen na nezavisne komponente kako bi se u magistarskom radu moglo kontrolisano uporediti statičko i dinamičko upravljanje resursima.

## Funkcionalnosti

- batch upload do 30 fotografija;
- profili Web shop, Blog, Društvene mreže i Prilagođene postavke;
- resize, kompresija i konverzija u WebP, JPEG ili PNG;
- opcionalni thumbnail, uklanjanje EXIF/metapodataka i tekstualni watermark;
- asinhrona obrada pomoću BullMQ/Redis reda;
- status svakog posla: čekanje, obrada, završeno ili neuspješno;
- Redis historija batch obrada sa zbirnom statistikom i ponovnim otvaranjem;
- pojedinačno i ZIP preuzimanje obrađenih datoteka;
- eksperimentalni dashboard sa stvarnim queue, worker, throughput i latency podacima;
- Redis heartbeat aktivnih worker instanci;
- eksperimentalne sesije sa JSON i CSV izvozom;
- Prometheus metrike za API i workere;
- poseban benchmark endpoint i k6 profili opterećenja;
- Kubernetes konfiguracije za statički i dinamički scenarij.

## Arhitektura

```mermaid
flowchart LR
    U["Korisnik ili k6"] --> W["Next.js web"]
    W --> A["Express API"]
    A --> R["Redis / BullMQ"]
    A --> S["MinIO"]
    R --> P["Image worker"]
    P --> S
    K["KEDA"] -->|"broj poslova"| P
```

API brzo prihvata zahtjev i stavlja posao u red. CPU-intenzivnu obradu obavlja worker, pa se njegov broj može mijenjati bez skaliranja ostatka sistema. KEDA prati pomoćnu Redis listu `media-processing:pending`, koja sadrži po jedan token za svaki posao koji čeka.

Worker svakih pet sekundi upisuje heartbeat sa svojim instance/pod ID-em. API uklanja istekle zapise i broji samo heartbeat zapise mlađe od `WORKER_HEARTBEAT_TTL_MS`. Završeni poslovi upisuju vremenske i volumenske metrike u Redis, pa dashboard i sesije ne koriste generisane ili hardkodirane rezultate.

## Lokalno pokretanje

Najjednostavnije je koristiti Docker Compose:

```bash
docker compose up --build
```

Aplikacija je dostupna na `http://localhost:3000`, API na `http://localhost:4000`, a MinIO konzola na `http://localhost:9001`.

Razvoj bez kontejnera:

```bash
cp .env.example .env.local
pnpm install
pnpm dev
pnpm dev:api
pnpm dev:worker
```

Redis i MinIO i dalje moraju biti dostupni na adresama iz `.env.local`.

## Korisnički prikazi

- **Obrada**: upload, izbor profila, pojedinačne izmjene pipelinea, praćenje batcha i preuzimanje rezultata.
- **Historija**: naziv, datum, status, broj datoteka, ulazna/izlazna veličina, ušteda, trajanje, greške i ZIP.
- **Eksperiment**: aktivna politika, stanje reda i workera, latencije, throughput, obrađeni podaci i eksperimentalne sesije.

Batch i eksperimentalni podaci se podrazumijevano čuvaju sedam dana. Retencija se podešava kroz `BATCH_RETENTION_SECONDS` i `METRIC_RETENTION_MS`.

## Eksperimentalne sesije

Sesija se pokreće iz prikaza Eksperiment uz naziv i profil opterećenja. API periodično čuva queue length, aktivne workere, throughput i latencije. Nakon zaustavljanja dostupni su završni sažetak te JSON i CSV export.

`workerMinutes` se računa kao vremenski integral broja aktivnih workera. Polje `estimatedAllocatedCapacityCost` postoji samo ako je konfigurisan `WORKER_CAPACITY_COST_PER_MINUTE`; bez provjerljive jedinične stope interfejs prikazuje da stopa nije postavljena. Ova vrijednost se naziva **procijenjeni trošak alociranog kapaciteta**, ne stvarno smanjenje cloud računa.

Ključne varijable okruženja:

| Varijabla | Namjena | Zadana vrijednost |
|---|---|---|
| `DEPLOYMENT_POLICY` | Oznaka aktivne politike | `STATIC` |
| `WORKER_HEARTBEAT_INTERVAL_MS` | Period upisa heartbeat zapisa | `5000` |
| `WORKER_HEARTBEAT_TTL_MS` | Maksimalna starost aktivnog workera | `15000` |
| `EXPERIMENT_SAMPLE_INTERVAL_MS` | Period uzorkovanja aktivne sesije | `5000` |
| `BATCH_RETENTION_SECONDS` | Retencija batch historije | `604800` |
| `METRIC_RETENTION_MS` | Retencija job metrika | `604800000` |
| `WORKER_CAPACITY_COST_PER_MINUTE` | Provjerljiva cijena worker-minute | nije postavljena |

## Eksperimentalni endpoint

`POST /benchmark/jobs` kreira sintetičke slike dimenzija 4000 × 3000 piksela u workeru. Time se uklanja mrežni upload kao nekontrolisana varijabla, a oba okruženja dobijaju identičan CPU-intenzivan posao.

```bash
curl -X POST http://localhost:4000/benchmark/jobs \
  -H 'Authorization: Bearer local-benchmark-token' \
  -H 'Content-Type: application/json' \
  -d '{"count":10,"format":"webp","quality":78,"width":1600}'
```

## Kubernetes scenariji

Izgradite dvije slike i učitajte ih u registry ili lokalni K3s/kind:

```bash
docker build -f Dockerfile.web -t cloud-media-web:latest .
docker build -f Dockerfile.service -t cloud-media-service:latest .
```

Statički scenarij koristi šest worker replika:

```bash
kubectl apply -k infra/k8s/static
```

Dinamički scenarij koristi KEDA-u i mijenja broj replika od jedne do šest:

```bash
kubectl apply -k infra/k8s/dynamic
```

KEDA mora biti instalirana prije dinamičkog scenarija. Oba overlayja su predviđena za dva odvojena klastera/servera; koriste isti NodePort `30080` kako bi pristup aplikaciji bio jednak u oba okruženja.

Prije javnog deploymenta promijenite vrijednosti u `infra/k8s/base/kustomization.yaml` i nemojte objavljivati benchmark endpoint bez sigurnog tokena.

Zajednička Kubernetes baza sadrži identične image verzije, requeste, limite i runtime postavke. Statički overlay postavlja šest replika. Dinamički overlay koristi isti worker Deployment i mijenja samo politiku na `DYNAMIC` te dodaje KEDA `ScaledObject` od jedne do šest replika.

## Test opterećenja

Podržani profili su `low`, `high`, `ramp` i `spike`:

```bash
SCENARIO=ramp \
BASE_URL=http://SERVER_IP:4000 \
BENCHMARK_TOKEN=replace-before-public-deployment \
k6 run --summary-export=results/ramp-run-01.json tests/load/experiment.js
```

Svaki profil treba ponoviti najmanje pet puta za oba scenarija. Redoslijed statičkih i dinamičkih izvođenja treba mijenjati između ponavljanja.

Detaljan postupak nalazi se u [eksperimentalnom protokolu](docs/experiment-protocol.md).

## Struktura projekta

```text
app/                    Next.js korisnički interfejs
services/api/           HTTP API, upload, statusi i metrike
services/worker/        Sharp obrada i worker metrike
services/shared/        Redis, BullMQ i MinIO konfiguracija
infra/k8s/base/         zajednički Kubernetes resursi
infra/k8s/static/       fiksnih šest worker replika
infra/k8s/dynamic/      KEDA skaliranje od jedne do šest replika
tests/load/             k6 profili opterećenja
tests/unit/             image, polling, validacija i metrički testovi
docs/                   eksperimentalna dokumentacija
```
