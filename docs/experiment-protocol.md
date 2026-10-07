# Eksperimentalni protokol

## 1. Cilj

Cilj eksperimenta je uporediti statičku alokaciju, reaktivno CPU skaliranje i skaliranje prema aplikacijskoj metrici tokom obrade istog skupa poslova te utvrditi njihov uticaj na aktivirani kapacitet, iskorištenost resursa, protok i vrijeme obrta.

## 2. Hipoteze i operacionalizacija

### H1

Kvalitetnim upravljanjem resursima i njihovom alokacijom mogu se minimizirati troškovi pružanja usluge u oblaku.

H1 se provjerava pomoću:

- ukupnog broja worker-replika kroz vrijeme;
- worker-minuta i CPU-request-minuta;
- procijenjenog troška aktiviranog kapaciteta;
- udjela vremena u kojem su rezervisani resursi bili neiskorišteni.

Ako oba servera imaju fiksnu cijenu, rezultat se mora nazvati procijenjenim troškom alociranog kapaciteta, a ne stvarno ostvarenim smanjenjem računa.

U aplikaciji se worker-minute računaju integracijom broja svježih worker heartbeat zapisa kroz vrijeme. Procijenjeni trošak alociranog kapaciteta računa se kao:

```text
procijenjeni trošak alociranog kapaciteta = worker-minute × cijena jednog worker-minuta
```

Jedinična cijena se postavlja kroz `WORKER_CAPACITY_COST_PER_MINUTE` i mora biti izvedena iz dokumentovane cijene odabranog cloud resursa. Ako stopa nije postavljena, izvještava se samo broj worker-minuta.

### H2

Kvalitetnim upravljanjem resursima i njihovom alokacijom u oblaku može doći do unapređenja efikasnosti upotrebe IT resursa.

H2 se provjerava pomoću:

- broja završenih poslova u minuti;
- prosječnog, medijalnog i P95 vremena obrta;
- vremena čekanja u redu;
- CPU i memorijske iskorištenosti workera;
- stope neuspješnih poslova;
- vremena od pojave opterećenja do spremnosti novih replika.

Izvori aplikacijskih metrika su:

| Metrika | Izvor |
|---|---|
| dužina reda | Redis lista `media-processing:pending` |
| aktivni poslovi | BullMQ aktivni poslovi |
| aktivni workeri | svježi Redis heartbeat zapisi |
| CPU i memorija workera | CPU vrijeme i RSS memorija worker procesa u heartbeat zapisu |
| alocirani CPU i memorija | broj svježih workera × Kubernetes resource request jednog workera |
| završeni/neuspješni poslovi | Redis događaji završetka workera |
| throughput 60 s | broj uspješnih događaja u posljednjih 60 sekundi |
| obrada i P95 | trajanje uspješnih worker poslova |
| čekanje | `processedOn - timestamp` BullMQ posla |
| obrađeni podaci | zbir glavnih izlaza i thumbnaila |

CPU iskorištenost alociranog kapaciteta računa se kao stvarna prosječna CPU potrošnja worker procesa podijeljena CPU requestom workera. Vrijednost može biti veća od 100% jer je CPU limit namjerno veći od requesta.

## 3. Nezavisna i zavisne varijable

Jedina namjerno promijenjena nezavisna varijabla je politika alokacije workera:

- S0 `STATIC`: šest replika tokom cijelog testa;
- S1 `CPU_HPA`: od jedne do šest replika, cilj 65% iskorištenosti CPU requesta;
- S2 `QUEUE_KEDA`: od jedne do šest replika, cilj pet poslova na čekanju po replici.

Zavisne varijable su metrike navedene uz H1 i H2. Verzija aplikacije, slike kontejnera, CPU/memorijski requesti i limiti, profil opterećenja, parametri obrade i trajanje testa moraju biti isti.

## 4. Profili opterećenja

| Profil | Namjena | Osnovna konfiguracija |
|---|---|---|
| Low | ponašanje pri malom stabilnom opterećenju | 1 zahtjev/s tokom 5 min |
| High | ponašanje blizu trajnog vrha | 6 zahtjeva/s tokom 5 min |
| Ramp | postepeni rast i pad | 1 → 8 → 2 zahtjeva/s |
| Spike | nagli i kratki vrh | 1 → 15 → 1 zahtjeva/s |

Vrijednosti su početne i konačno se zaključavaju nakon pilot-testa. Ako oba sistema bez poteškoća obrađuju najveći profil, opterećenje treba povećati. Ako oba konstantno otkazuju, treba ga smanjiti.

## 5. Postupak jednog izvođenja

Jedno izvođenje pokreće automatizovani runner:

```bash
SCENARIO=ramp \
EXPECTED_POLICY=QUEUE_KEDA \
EXPECTED_INITIAL_WORKERS=1 \
REPETITION=1 \
BASE_URL=http://SERVER_IP:4000 \
BENCHMARK_TOKEN=replace-before-public-deployment \
KUBECTL_NAMESPACE=media-dynamic \
pnpm run:experiment
```

Runner izvršava sljedeći postupak:

1. Provjerava dostupnost k6, aplikacije i opcionalno kubectl-a.
2. Odbija izvođenje ako red nije prazan, posao je aktivan ili postoji aktivna eksperimentalna sesija.
3. Provjerava aktivnu politiku i, ako je zadan, početni broj worker replika.
4. Bilježi Git reviziju, konfiguraciju, vrijeme početka i početne metrike.
5. Pokreće sesiju i k6 profil s eksplicitnim `EXPERIMENT_SESSION_ID`.
6. Prikuplja metrike dok red, aktivni i nedovršeni poslovi ne dostignu nulu.
7. Zaustavlja sesiju i čuva JSON i CSV export.
8. Čuva k6 rezultat, Prometheus podatke te opcionalno Kubernetes stanje i logove.
9. Upisuje završni status i razlog greške u `manifest.json`.
10. Ostavlja period hlađenja prije narednog izvođenja.

Runner podrazumijevano zahtijeva čisto Git stablo. `ALLOW_DIRTY=1` koristi se samo tokom pilot-testa. Artefakti se čuvaju pod `results/<run-id>/`, koji Git ne prati.

k6 samo šalje poslove prema definisanoj arrival-rate krivulji. Ne anketira status svakog posla jer bi dodatni HTTP zahtjevi opteretili API i Redis. Završetak, greške, turnaround i drain mjere eksperimentalna sesija i runner. Svaka odbačena k6 iteracija čini izvođenje nevalidnim.

Svaki profil se izvodi najmanje pet puta po politici. Redoslijed S0, S1 i S2 se randomizira ili koristi uravnotežen raspored kako redoslijed izvođenja ne bi bio povezan s jednom politikom.

## 6. Rezultati za tabelarni prikaz

Za svako izvođenje sačuvati:

| Polje | Jedinica |
|---|---|
| politika i profil | kategorija |
| broj poslanih/završenih/neuspješnih poslova | broj |
| protok | poslova/min |
| prosječno, medijalno i P95 vrijeme obrta | ms |
| prosječno i maksimalno vrijeme čekanja | ms |
| prosječan i maksimalan CPU | % ili jezgre |
| prosječna i maksimalna memorija | MiB |
| minimalan, prosječan i maksimalan broj replika | broj |
| ukupno aktivnih worker-minuta | minuta |
| vrijeme scale-up reakcije | s |
| obrađeni ulazni i izlazni podaci | bajtovi |

JSON export je primarni zapis sesije jer sadrži metapodatke, sve periodične uzorke, sirove job događaje i završni sažetak. CSV sadrži vremensku seriju i koristi se za tabelarnu analizu. Obrt, obrada, čekanje, P95, stopa grešaka i volumeni računaju se samo iz job događaja vezanih za konkretnu sesiju. Export treba arhivirati zajedno s k6 rezultatom i oznakom image verzije.

## 7. Analiza

Za svaku metriku prikazati srednju vrijednost, medijan, standardnu devijaciju i P95 gdje ima smisla. Uz apsolutne vrijednosti prikazati relativnu promjenu dinamičkog u odnosu na statički scenarij.

Skupovi podataka generišu se iz arhiviranih runova:

```bash
EXPECTED_REPETITIONS=5 pnpm analyze:experiments
```

`runs.csv` sadrži jedno izvođenje po redu. `summary.csv` računa statistike između ponavljanja iste politike i profila. Standardna devijacija je uzoračka i zahtijeva najmanje dva runa. `comparisons.csv` poredi srednje vrijednosti S1 i S2 sa S0; relativna promjena nije automatski poboljšanje jer poželjan smjer zavisi od metrike. `timeseries.csv` služi za grafikone kroz normalizovano vrijeme.

Prije interpretacije mora proći kontrola u `coverage.csv` i `report.json`: pet tačno označenih ponavljanja svake kombinacije, bez duplikata, bez isključenih runova, bez nedostajućih artefakata i uz jednu Git reviziju. Za konačni skup koristi se `STRICT_ANALYSIS=1`.

Grafikoni po vremenu trebaju na istoj osi prikazati ulazno opterećenje, dužinu reda, broj replika i P95 vrijeme obrta. Zbirna tabela treba povezati performanse s worker-minutama i procijenjenim troškom.

Dashboard služi za praćenje izvođenja i koristi samo trenutne Redis/BullMQ podatke. Za konačnu statističku analizu koriste se sačuvani exporti svih ponavljanja, a ne vrijednost vidljiva u jednom trenutku na ekranu.

## 8. Prijetnje valjanosti

- dvije cloud VM instance mogu dijeliti fizički hardver različitih performansi;
- sintetičke slike i opterećenje ne predstavljaju sve produkcijske obrasce;
- MinIO i Redis mogu postati usko grlo nezavisno od workera;
- vrijeme pokretanja kontejnera zavisi od keširanja imagea;
- HPA/KEDA smanjuje alocirane pod-resurse, ali fiksno naplaćena VM ne smanjuje automatski stvarni račun;
- RSS i CPU procesa predstavljaju potrošnju aplikacijskog workera, ne kompletnu potrošnju Kubernetes noda;
- jedan tip aplikacije ne omogućava generalizaciju na sva cloud opterećenja.

Ograničenja se navode otvoreno i koriste pri formulisanju uslovnog zaključka o hipotezama.
