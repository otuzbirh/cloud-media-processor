# Rezultati Kubernetes smoke-testa

## Svrha i status

Smoke-test je izveden 10. oktobra 2026. radi provjere da se sva tri eksperimentalna scenarija mogu podići na Kubernetesu i da Metrics Server, CPU HPA i KEDA primaju odgovarajuće metrike. Rezultati nisu dio konačne matrice: korišteni su lokalni image tagovi, a KEDA runovi nakon konfiguracijske korekcije imaju nečisto Git stanje.

## Okruženje

- lokalni jednočvorni `kind` klaster `cloud-media-exp`;
- Kubernetes 1.37.0 na ARM64 Docker Desktop okruženju;
- kind 0.33.0;
- Metrics Server 0.9.0;
- KEDA 2.21.0;
- Git revizija `9e9d929555cfb27d51b3ca0a38d7ceb3d53d2cc5`;
- aplikacijske slike `cloud-media-service:smoke-9e9d929` i `cloud-media-web:smoke-9e9d929`.

## Validna smoke izvođenja

| Politika | Profil | Poslani/završeni | Greške | Worker raspon | Worker-minute | Prosječan obrt | P95 obrt |
|---|---|---:|---:|---:|---:|---:|---:|
| STATIC | low | 301/301 | 0 | 6–6 | 30,21 | 610,96 ms | 626 ms |
| CPU_HPA | low | 300/300 | 0 | 1–2 | 9,58 | 619,14 ms | 632 ms |
| QUEUE_KEDA | low | 301/301 | 0 | 1–1 | 5,04 | 608,78 ms | 622 ms |
| QUEUE_KEDA | spike | 1260/1260 | 0 | 1–6 | 13,96 | 31.887,33 ms | 52.457 ms |

Ni jedno završeno izvođenje nije imalo odbačene k6 iteracije, neuspješne poslove ili nedovršene poslove.

CPU HPA je pri profilu `low` povećao broj workera sa jedan na dva. Zabilježena scale-up reakcija iznosila je 25,09 s.

KEDA je pri profilu `low` ostala na jednoj replici jer red nije prešao aktivacijski prag. Pri profilu `spike` trigger je postao aktivan, broj workera porastao je sa jedan na šest, a zabilježene su tri scale-up akcije. Reakcija od početka profila do prvog povećanja broja spremnih workera iznosila je 73,97 s. Maksimalna dužina reda bila je 507 poslova.

## Otkrivena konfiguracijska greška

Prvo KEDA izvođenje prekinuto je prije prihvatanja rezultata. `ScaledObject` je koristio adresu `redis:6379`, koju KEDA operator iz svog namespacea nije mogao razriješiti. Adresa je promijenjena u `redis.media-dynamic.svc.cluster.local:6379`, nakon čega su status `Ready`, Redis metrika i automatsko skaliranje potvrđeni.

Za ovu grešku dodat je regresijski test koji provjerava namespace-kvalifikovanu Redis adresu u KEDA manifestu.

## Odluka nakon smoke-testa

- Kubernetes deployment putanja radi za STATIC, CPU HPA i QUEUE KEDA.
- Metrics Server isporučuje CPU metrike, a CPU HPA mijenja broj replika.
- KEDA čita dužinu Redis reda i skalira worker Deployment do zadane granice.
- Smoke artefakti ostaju odvojeni u `results/k8s-smoke` i `analysis/k8s-smoke`.
- Prije konačne matrice potrebno je commitovati konfiguracijsku korekciju, izgraditi i objaviti aplikacijske slike pod immutable digestima te ponovo potvrditi čisto Git stanje.
