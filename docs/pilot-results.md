# Rezultati lokalnog pilot-testa

## Opseg

Pilot je izveden 7. oktobra 2026. na lokalnom Docker Desktop okruženju. Korištena je politika `STATIC` sa šest worker kontejnera, k6 2.3.0 i Git revizija `b52974ff40737b7a30ce3609cf220f22a52746be`. Radno stablo je bilo nečisto jer su se provjeravale nove eksperimentalne skripte.

Ovi rezultati validiraju mjerni postupak i oblik opterećenja. Ne predstavljaju rezultate magistarskog eksperimenta jer nisu prikupljeni na ciljnom Kubernetes/cloud okruženju.

## Validna izvođenja

| Metrika | Low | Spike |
|---|---:|---:|
| poslani/završeni poslovi | 301 / 301 | 1260 / 1260 |
| neuspješni poslovi | 0 | 0 |
| odbačene k6 iteracije | 0 | 0 |
| maksimalna dužina reda | 0 | 271 |
| prosječna dužina reda | 0 | 64,11 |
| prosječno vrijeme obrta | 498,97 ms | 11.991,22 ms |
| P95 vrijeme obrta | 513 ms | 25.294 ms |
| prosječno čekanje u redu | 1,12 ms | 11.440,58 ms |
| maksimalno čekanje u redu | 6 ms | 25.143 ms |
| prosječan throughput | 60,06 poslova/min | 356,38 poslova/min |
| worker-minute | 30,07 | 21,21 |
| poslovi po worker-minuti | 10,01 | 59,40 |
| prosječna iskorištenost CPU requesta | 20,62% | 113,20% |
| idle kapacitet | 79,38% | 0% |

`Low` je potvrdio mirno bazno opterećenje: nije formirao red i ostavio je 79,38% alociranog CPU kapaciteta neiskorištenim. `Spike` je formirao red od 271 posla, podigao P95 vrijeme obrta na 25,29 s i zatim potpuno ispraznio red bez grešaka.

## Otkriven i ispravljen problem

Prvo spike izvođenje nije validno. k6 je čekao završetak svakog posla i anketirao batch status svakih 200 ms. Time je proizveo 50.100 HTTP zahtjeva, potrošio 192 VU-a i odbacio 142 od planiranih 1260 iteracija.

Ispravka razdvaja generisanje opterećenja od mjerenja završetka:

- k6 samo šalje posao zadatom arrival-rate stopom;
- eksperimentalna sesija mjeri obradu, čekanje, turnaround i greške;
- runner čeka da red, aktivni i nedovršeni poslovi dostignu nulu;
- `dropped_iterations > 0`, neuspješan posao ili nedovršen posao čine run nevalidnim.

Ponovljeni spike poslao je svih 1260 planiranih poslova sa 1260 HTTP zahtjeva, bez odbačenih iteracija i bez grešaka.

## Odluka nakon pilota

- `low` ostaje bazni profil.
- `spike` ostaje overload/recovery profil.
- Vrijednosti `high` i `ramp` ne treba zaključati prema lokalnom Mac okruženju.
- Sljedeći pilot mora se izvesti na ciljnom Kubernetes okruženju za `STATIC`, `CPU_HPA` i `QUEUE_KEDA`.
- Konačni eksperimenti moraju koristiti čistu i jedinstvenu Git reviziju.
