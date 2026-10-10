# 7. Praktična evaluacija politika alokacije resursa

> Status poglavlja: radni nacrt. Sekcije o metodologiji i lokalnom pilot-testu zasnovane su na izvedenim mjerenjima. Konačni rezultati, statističko poređenje i ocjena hipoteza popunjavaju se tek nakon validne Kubernetes matrice od 60 izvođenja.

## 7.1. Cilj evaluacije i istraživačka pitanja

Cilj praktične evaluacije je eksperimentalno uporediti statičku alokaciju workera, reaktivno horizontalno skaliranje prema iskorištenosti procesora i skaliranje prema aplikacijskoj metrici reda poslova. Poređenje se provodi pri istim verzijama aplikacije, ulaznim profilima, parametrima obrade i ograničenjima resursa. Time se ispituje kako politika alokacije utiče na aktivirani kapacitet, iskorištenost resursa, protok i vrijeme obrta.

Evaluacija odgovara na sljedeća pitanja:

1. Da li automatsko skaliranje smanjuje broj aktivnih worker-minuta u odnosu na statičku alokaciju pri istom profilu opterećenja?
2. Kako politika skaliranja utiče na prosječno, medijalno i P95 vrijeme obrta, čekanje u redu i stopu neuspješnih poslova?
3. Koliko vrijeme pokretanja novih replika utiče na reakciju sistema na postepene i nagle promjene opterećenja?
4. Postoji li konfiguracija koja smanjuje aktivirani kapacitet bez neprihvatljivog pogoršanja kvaliteta usluge?

## 7.2. Sistem i eksperimentalno okruženje

Cloud Media Processor je kontejnerizovana aplikacija za asinhronu batch obradu slika. Web i API sloj prihvataju zahtjeve, ulazne datoteke se čuvaju u MinIO objektnoj pohrani, a BullMQ i Redis upravljaju redom poslova. Worker procesi preuzimaju poslove i izvršavaju transformacije slika. Arhitektura omogućava promjenu broja worker replika bez promjene API-ja, podataka ili vrste posla.

Eksperimentalna telemetrija obuhvata dužinu reda, broj aktivnih poslova i workera, završene i neuspješne poslove, trajanje obrade i čekanja, CPU i RSS memoriju worker procesa te alocirane CPU i memorijske requeste. Svaki posao i periodični uzorak vezani su za jedinstvenu eksperimentalnu sesiju, čime se sprečava miješanje podataka između izvođenja.

### 7.2.1. Konačno Kubernetes okruženje

Za konačnu evaluaciju potrebno je evidentirati:

- Kubernetes distribuciju i verziju;
- broj, tip i specifikaciju kontrolnih i radnih čvorova;
- verzije Metrics Servera i KEDA-e;
- operativni sistem i container runtime;
- CPU i memorijske requeste i limite svih komponenti;
- immutable digest vrijednosti korištenih slika kontejnera;
- mrežnu topologiju i lokaciju generatora opterećenja;
- jediničnu cijenu worker-kapaciteta, ako se izvještava procijenjeni trošak.

**[POPUNITI NAKON PRIPREME CILJNOG KLASTERA]**

## 7.3. Eksperimentalne politike i profili opterećenja

Jedina namjerno promijenjena nezavisna varijabla je politika alokacije worker replika:

| Oznaka | Politika | Konfiguracija |
|---|---|---|
| S0 | `STATIC` | šest replika bez automatskog skaliranja |
| S1 | `CPU_HPA` | jedna do šest replika, cilj 65% iskorištenosti CPU requesta |
| S2 | `QUEUE_KEDA` | jedna do šest replika, cilj pet poslova na čekanju po replici |

Svaka politika izvršava četiri profila opterećenja:

| Profil | Osnovni oblik | Namjena |
|---|---|---|
| `low` | 1 zahtjev/s tokom 5 min | provjera prekomjerne alokacije pri malom stabilnom opterećenju |
| `high` | 6 zahtjeva/s tokom 5 min | ponašanje pri trajnom visokom opterećenju |
| `ramp` | 1 → 8 → 2 zahtjeva/s | reakcija na postepeni rast i pad |
| `spike` | 1 → 15 → 1 zahtjeva/s | reakcija i oporavak nakon naglog vrha |

Svaka od 12 kombinacija politike i profila ponavlja se pet puta. Ukupno se izvodi 60 mjerenja. Determinističan uravnotežen raspored rotira početnu politiku i redoslijed profila, čime se smanjuje sistematski uticaj redoslijeda izvođenja.

## 7.4. Metrike i veza sa hipotezama

Prva hipoteza (H1) odnosi se na smanjenje troška pružanja usluge. Operacionalizuje se brojem worker-minuta, CPU-request-minutama, udjelom neiskorištenog kapaciteta i, samo uz dokumentovanu jediničnu cijenu, procijenjenim troškom alociranog kapaciteta. Ako se eksperiment izvodi na fiksno naplaćenim serverima, rezultat se ne predstavlja kao stvarno smanjenje cloud računa.

Druga hipoteza (H2) odnosi se na unapređenje efikasnosti upotrebe IT resursa. Operacionalizuje se brojem završenih poslova u minuti, vremenom obrade, čekanja i obrta, CPU i memorijskom iskorištenošću, stopom grešaka te vremenom reakcije skaliranja.

CPU iskorištenost alociranog kapaciteta računa se u odnosu na CPU request, a ne na limit. Zato vrijednost može biti veća od 100% kada proces koristi raspoloživi kapacitet iznad rezervisanog requesta.

## 7.5. Postupak i kontrola valjanosti

Automatizovani runner prije svakog izvođenja provjerava dostupnost aplikacije i potrebnih alata, prazno stanje reda, odsustvo druge aktivne sesije, aktivnu politiku i početni broj replika. Nakon pokretanja jedinstvene sesije, k6 šalje poslove prema zadanom arrival-rate profilu. Završetak se ne prati statusnim anketiranjem svakog posla, jer bi takvi zahtjevi kontaminirali opterećenje API-ja i Redis-a.

Po završetku generisanja opterećenja runner čeka da red, broj aktivnih i broj nedovršenih poslova dostignu nulu. Zatim arhivira JSON i CSV sesije, k6 sažetak, vremensku seriju, stanje skalera i relevantne logove. Izvođenje je nevalidno ako postoji neuspješan ili nedovršen posao, odbačena k6 iteracija, neusklađena politika, pogrešan početni broj workera ili nepotpun artefakt.

Konačna analiza prihvata samo skup sa pet tačno označenih ponavljanja svake kombinacije, bez duplikata i isključenih izvođenja, uz jednu Git reviziju i iste image digest vrijednosti.

## 7.6. Lokalni pilot-test

### 7.6.1. Svrha i ograničenja

Lokalni pilot izveden je 7. oktobra 2026. u Docker Desktop okruženju s politikom `STATIC` i šest worker kontejnera. Njegova svrha bila je provjeriti mjerni lanac i potvrditi da profili `low` i `spike` proizvode dovoljno različita stanja sistema. Radno stablo tokom pilota nije bilo čisto jer su eksperimentalne skripte aktivno provjeravane. Zbog toga pilot nije dio konačnog eksperimentalnog skupa.

### 7.6.2. Rezultati pilota

| Metrika | `low` | `spike` |
|---|---:|---:|
| poslani / završeni poslovi | 301 / 301 | 1260 / 1260 |
| neuspješni / nedovršeni poslovi | 0 / 0 | 0 / 0 |
| maksimalna dužina reda | 0 | 271 |
| prosječna dužina reda | 0 | 64,11 |
| prosječno vrijeme obrade | 496,24 ms | 548,89 ms |
| P95 vrijeme obrade | 511 ms | 618 ms |
| prosječno vrijeme obrta | 498,97 ms | 11.991,22 ms |
| P95 vrijeme obrta | 513 ms | 25.294 ms |
| prosječno čekanje u redu | 1,12 ms | 11.440,58 ms |
| maksimalno čekanje u redu | 6 ms | 25.143 ms |
| prosječan throughput | 60,06 poslova/min | 356,38 poslova/min |
| worker-minute | 30,07 | 21,21 |
| poslovi po worker-minuti | 10,01 | 59,40 |
| prosječna iskorištenost CPU requesta | 20,62% | 113,20% |
| procijenjeni neiskorišteni kapacitet | 79,38% | 0% |

### 7.6.3. Tumačenje pilota

Profil `low` nije formirao red i pokazao je izraženu prekomjernu alokaciju statičkog kapaciteta. Nasuprot tome, `spike` je formirao red od 271 posla, ali je sistem završio svih 1260 poslova bez greške i potpuno ispraznio red.

Prosječno vrijeme obrade poraslo je samo 10,61%, sa 496,24 ms na 548,89 ms. Istovremeno je prosječno vrijeme obrta poraslo 24,03 puta, a P95 vrijeme obrta 49,31 puta. Prosječno čekanje u redu od 11,44 s čini približno 95,4% prosječnog vremena obrta u `spike` profilu. Nalaz pokazuje da glavni uzrok degradacije nije značajno sporija obrada pojedinačnog posla, nego privremeni nedostatak paralelnog kapaciteta.

Veći throughput i broj poslova po worker-minuti u `spike` profilu nisu dokaz bolje politike, jer oba profila koriste istih šest statičkih workera, a ulazno opterećenje i trajanje izvođenja nisu jednaki. Slično tome, niži zbir worker-minuta u `spike` profilu posljedica je kraćeg ukupnog trajanja tog izvođenja i ne smije se tumačiti kao ušteda.

Prvo `spike` izvođenje otkrilo je metodološku grešku: k6 je anketirao status svakog batcha svakih 200 ms, proizveo 50.100 dodatnih HTTP zahtjeva i odbacio 142 planirane iteracije. To izvođenje je isključeno. Nakon razdvajanja generisanja opterećenja od mjerenja završetka, ponovljeni `spike` poslao je svih 1260 planiranih poslova bez odbačenih iteracija. Pilot je time ispunio svoju glavnu svrhu — otkrio je i uklonio izvor sistematske mjerne pristrasnosti prije konačnog eksperimenta.

### 7.6.4. Status hipoteza nakon pilota

Pilot ne omogućava prihvatanje ni odbacivanje H1 ili H2. Izvedena je samo statička politika, jedinična cijena worker-kapaciteta nije definisana, a svaki profil ima samo jedno validno ponavljanje. Pilot potvrđuje osjetljivost mjernog sistema na prekomjernu i nedovoljnu alokaciju, ali ne utvrđuje učinak automatskog skaliranja.

## 7.7. Konačni rezultati

Ova sekcija popunjava se nakon završetka i stroge validacije matrice.

### 7.7.1. Potpunost skupa podataka

**[POPUNITI: broj validnih i isključenih izvođenja, pokrivenost 12 kombinacija × 5 ponavljanja, Git revizija i image digest vrijednosti.]**

### 7.7.2. Zbirni rezultati po politici i profilu

**[POPUNITI: srednja vrijednost, medijan, uzoračka standardna devijacija i relevantni percentili. Dinamičke politike porediti sa S0 samo unutar istog profila.]**

### 7.7.3. Dinamika skaliranja

**[POPUNITI: vremenski grafikoni ulaznog opterećenja, dužine reda, broja replika i P95 vremena obrta; vrijeme scale-up reakcije i broj oscilacija.]**

### 7.7.4. Kapacitet, kvalitet usluge i procijenjeni trošak

**[POPUNITI: worker-minute, CPU-request-minute, idle kapacitet i, ako postoji provjerljiva stopa, procijenjeni trošak alociranog kapaciteta zajedno s latencijom i greškama.]**

## 7.8. Ocjena hipoteza

H1 se može podržati samo ako S1 ili S2 pri istom profilu opterećenja dosljedno smanji aktivirani kapacitet ili procijenjeni trošak u odnosu na S0, bez prikrivanja fiksnih troškova infrastrukture. H2 se može podržati samo ako dinamička politika poboljša iskorištenost i/ili obradi opterećenje uz prihvatljivo vrijeme obrta i stopu grešaka. Rezultat se mora formulirati uslovno i vezati za ispitanu aplikaciju, konfiguraciju i profile.

**[POPUNITI NAKON STATISTIČKE ANALIZE; NE PRENOSITI USLOVNO PRIHVATANJE IZ TEORETSKOG DIJELA KAO EKSPERIMENTALNI NALAZ.]**

## 7.9. Prijetnje valjanosti

Internu valjanost mogu ugroziti razlike u zagrijavanju kontejnera, keširanju imagea, dijeljenom fizičkom hardveru, stanju MinIO i Redis servisa te redoslijedu izvođenja. Rizik se smanjuje jednakim konfiguracijama, uravnoteženim rasporedom, periodom hlađenja, provjerom praznog reda i ponavljanjem mjerenja.

Konstruktna valjanost ograničena je činjenicom da CPU i RSS worker procesa ne obuhvataju kompletnu potrošnju Kubernetes noda. Worker-minute predstavljaju aktivirani aplikacijski kapacitet, a ne automatski stvarni račun javnog oblaka.

Eksterna valjanost ograničena je jednom aplikacijom, sintetičkim slikama i kontrolisanim profilima. Nalazi se zato ne generalizuju na sve cloud aplikacije, nego pokazuju ponašanje posmatrane arhitekture u dokumentovanim uslovima.

## 7.10. Reproduktivnost

Plan matrice generiše se komandom `EXPECTED_REPETITIONS=5 pnpm run:matrix`, pri čemu se finalni runovi podrazumijevano čuvaju u `results/final`, odvojeno od pilot-podataka. Konačna agregacija pokreće se sa `RESULTS_DIR=results/final ANALYSIS_DIR=analysis/final STRICT_ANALYSIS=1 EXPECTED_REPETITIONS=5 pnpm analyze:experiments`. Uz rad treba arhivirati plan redoslijeda, manifest svakog izvođenja, izvoz sesije, k6 sažetak, Kubernetes stanje, logove, Git reviziju i image digest vrijednosti.
