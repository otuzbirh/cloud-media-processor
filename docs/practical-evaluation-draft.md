# 7. Praktična evaluacija politika alokacije resursa

Poglavlje prikazuje lokalni pilot i konačnu Kubernetes evaluaciju provedenu kroz 60 strogo validiranih izvođenja. Rezultati se tumače deskriptivno i isključivo unutar istog profila opterećenja.

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

Konačna matrica izvedena je 10. oktobra 2026. na jednom lokalnom `kind` čvoru u Docker Desktop virtuelnoj mašini. Host je MacBook Pro s Apple M1 Pro procesorom, osam CPU jezgri i 16 GB fizičke memorije. Docker Desktop virtuelnoj mašini bilo je dostupno osam CPU jezgri i približno 8 GB memorije. Generator opterećenja k6 izvršavao se na hostu i pristupao aplikacijskom API-ju preko lokalnog NodePorta `30080`.

Eksperimentalni klaster koristio je `kind` 0.33.0, Kubernetes server 1.37.0 za `linux/arm64`, jedan control-plane čvor, Debian GNU/Linux 13 i `containerd` 2.3.4. Metrics Server je bio verzije 0.9.0, a KEDA 2.21.0. Runner je koristio Node.js 22.18.0 i k6 2.3.0 za `darwin/arm64`. Kubernetes klijent bio je verzije 1.32.2; zabilježena razlika između klijentske i serverske minor verzije nije uticala na završetak mjerenja, ali je navedena među prijetnjama reproduktivnosti.

Radni kontejner imao je CPU request od 500 mCPU i limit od jedne CPU jezgre, te memorijski request od 256 MiB i limit od 512 MiB. API je koristio 100 mCPU/128 MiB request i 500 mCPU/256 MiB limit, MinIO 100 mCPU/192 MiB i 500 mCPU/512 MiB, Redis 50 mCPU/64 MiB i 250 mCPU/192 MiB, a web komponenta 50 mCPU/64 MiB i 250 mCPU/128 MiB. Sve politike koristile su istu aplikacijsku sliku servisa i workera, `sha256:0481b0757ae11471eb3dc8305f00873cb1fd1dc204d8484d2de456ae9d3ce8f0`, i istu web sliku, `sha256:e69da37214c83b4a93ce8783d3e5f61ff06ed9b3626879e8b734ddcc62d4d32c`.

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

Za svaku kombinaciju politike i profila izračunate su srednja vrijednost, medijan, uzoračka standardna devijacija, minimum, maksimum i P95 između pet ponavljanja. Relativna promjena dinamičke politike računa se u odnosu na srednju vrijednost statičke politike samo unutar istog profila. Zbog malog broja ponavljanja i unaprijed definisanog deskriptivnog plana ne izvode se naknadni testovi statističke značajnosti. Zaključci se zasnivaju na veličini, smjeru i ponovljivosti opaženih razlika, bez generalizacije izvan ispitanog sistema.

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

Konačni rezultati potiču iz potpune matrice od tri politike, četiri profila i pet ponavljanja. Srednja vrijednost i uzoračka standardna devijacija u tabelama se zapisuju kao `srednja vrijednost ± SD`.

### 7.7.1. Potpunost skupa podataka

Stroga analiza uključila je svih 60 izvođenja i nije isključila nijedno. Svaka od 12 kombinacija ima tačno pet ponavljanja, bez duplikata i nedostajućih rednih brojeva. U svim izvođenjima poslano je i završeno 67.954 posla, bez neuspješnih i nedovršenih poslova. Generator opterećenja nije zabilježio odbačene iteracije, a svi obavezni artefakti su sačuvani.

Cijela matrica koristi čistu Git reviziju `3a599c6d45cbf0947171150050ebbb00b347f5b6` i iste immutable digest vrijednosti aplikacijskih slika. Time su ispunjeni unaprijed definisani kriteriji uključivanja u konačnu analizu.

### 7.7.2. Aktivirani kapacitet

Tabela 7.4 prikazuje aktivirani worker-kapacitet. Obje dinamičke politike smanjile su worker-minute u sva četiri profila. Najveće smanjenje ostvareno je pri malom opterećenju: CPU HPA za 68,4%, a KEDA za 83,4% u odnosu na statičkih 30,14 worker-minuta. KEDA je zadržala jednu repliku i ostvarila 5,02 worker-minute, dok je CPU HPA u prosjeku koristio 1,89 replika i 9,51 worker-minutu.

| Profil | Politika | Worker-minute, sredina ± SD | Promjena prema S0 | Prosječno workera | Poslova po worker-minuti |
|---|---|---:|---:|---:|---:|
| `low` | S0 statička | 30,14 ± 0,11 | — | 6,00 | 9,97 |
| `low` | S1 CPU HPA | 9,51 ± 0,06 | −68,4% | 1,89 | 31,60 |
| `low` | S2 KEDA red | 5,02 ± 0,02 | −83,4% | 1,00 | 59,89 |
| `high` | S0 statička | 30,22 ± 0,01 | — | 6,00 | 59,60 |
| `high` | S1 CPU HPA | 25,77 ± 0,95 | −14,7% | 5,11 | 69,95 |
| `high` | S2 KEDA red | 20,10 ± 0,39 | −33,5% | 3,99 | 89,61 |
| `ramp` | S0 statička | 30,22 ± 0,01 | — | 6,00 | 38,71 |
| `ramp` | S1 CPU HPA | 21,68 ± 0,35 | −28,3% | 4,32 | 53,95 |
| `ramp` | S2 KEDA red | 13,38 ± 0,82 | −55,7% | 2,59 | 87,62 |
| `spike` | S0 statička | 21,10 ± 0,11 | — | 6,00 | 59,69 |
| `spike` | S1 CPU HPA | 14,03 ± 0,12 | −33,5% | 4,04 | 89,76 |
| `spike` | S2 KEDA red | 13,73 ± 0,32 | −34,9% | 3,94 | 91,74 |

Promjene u CPU-request-minutama jednake su relativnim promjenama worker-minuta jer svaka replika ima isti request od 0,5 CPU jezgre. Jedinična novčana cijena worker-minute nije postavljena. Rezultati zato opisuju smanjenje aktiviranog aplikacijskog kapaciteta, a ne stvarno smanjenje cloud računa.

### 7.7.3. Kvalitet usluge

Sva tri pristupa zadržala su jednak broj završenih poslova i nultu stopu grešaka. Prosječni throughput unutar istog profila bio je gotovo jednak, što pokazuje da dinamičke politike nisu izgubile posao niti smanjile ukupnu količinu rada. Razlike se pojavljuju u čekanju i vremenu obrta.

| Profil | Politika | Prosječni obrt, ms ± SD | P95 obrt, ms | Prosječno čekanje, ms | Throughput, poslova/min |
|---|---|---:|---:|---:|---:|
| `low` | S0 statička | 605,30 ± 10,20 | 628,80 | 1,20 | 59,85 |
| `low` | S1 CPU HPA | 596,52 ± 6,89 | 612,60 | 1,18 | 59,84 |
| `low` | S2 KEDA red | 604,86 ± 3,45 | 617,60 | 1,24 | 59,89 |
| `high` | S0 statička | 588,66 ± 2,77 | 607,20 | 0,54 | 357,60 |
| `high` | S1 CPU HPA | 6.286,10 ± 2.901,20 | 24.039,20 | 5.694,24 | 357,54 |
| `high` | S2 KEDA red | 2.709,85 ± 128,27 | 9.638,60 | 2.118,21 | 357,43 |
| `ramp` | S0 statička | 587,48 ± 3,30 | 614,00 | 0,53 | 232,23 |
| `ramp` | S1 CPU HPA | 718,80 ± 293,40 | 1.409,60 | 110,39 | 232,14 |
| `ramp` | S2 KEDA red | 2.123,31 ± 135,00 | 6.405,60 | 1.533,65 | 231,54 |
| `spike` | S0 statička | 14.090,39 ± 623,65 | 29.436,60 | 13.507,42 | 358,17 |
| `spike` | S1 CPU HPA | 30.586,96 ± 2.211,46 | 48.789,80 | 29.997,47 | 357,46 |
| `spike` | S2 KEDA red | 31.012,22 ± 2.886,35 | 48.733,80 | 30.424,72 | 358,20 |

Pri profilu `low` smanjenje kapaciteta nije pogoršalo vrijeme obrta. Prosječne vrijednosti sve tri politike ostale su između 596,52 i 605,30 ms. Pri trajnom profilu `high`, statičkih šest replika spriječilo je red, dok su dinamičke politike prvo morale povećati kapacitet. CPU HPA povećao je prosječno vrijeme obrta za 967,9%, a KEDA za 360,3% prema S0. KEDA je u ovom profilu ostvarila povoljniji kompromis od CPU HPA: koristila je 33,5% manje worker-minuta od S0, uz prosječni obrt od 2,71 s, dok je CPU HPA uštedio 14,7% uz 6,29 s.

U profilu `ramp` CPU HPA je u četiri od pet izvođenja zadržao prosječni obrt između 584,69 i 591,55 ms, dok je jedno izvođenje dostiglo 1.243,63 ms. Zbog toga srednja vrijednost iznosi 718,80 ms uz veću standardnu devijaciju. KEDA je agresivnije smanjila kapacitet, ali je redovno formirala red i ostvarila prosječni obrt od 2,12 s.

Profil `spike` premašio je kratkoročni kapacitet i statičke konfiguracije. Statička politika imala je prosječni obrt 14,09 s, a dinamičke politike približno 31 s. Obje dinamičke politike započele su sa jednom replikom i dostigle maksimalnih šest tek nakon nastanka reda, pa je ušteda worker-minuta ostvarena uz približno dvostruko duže prosječno vrijeme obrta.

### 7.7.4. Dinamika skaliranja

Vremenski prikaz koristi medijan pet ponavljanja. P95 vrijeme obrta u svakom trenutku ponovo je izračunato samo iz job događaja konkretne eksperimentalne sesije, čime se sprečava prenošenje kumulativnih vrijednosti između uzastopnih izvođenja istog namespacea.

| Profil | Politika | Reakcija scale-upa, s ± SD | Akcije skaliranja | Oscilacije | Maksimalno workera |
|---|---|---:|---:|---:|---:|
| `low` | S1 CPU HPA | 31,89 ± 1,49 | 1,00 | 0,00 | 2,00 |
| `low` | S2 KEDA red | nije aktivirano | 0,00 | 0,00 | 1,00 |
| `high` | S1 CPU HPA | 29,88 ± 13,02 | 3,00 | 0,00 | 6,00 |
| `high` | S2 KEDA red | 14,79 ± 1,85 | 12,80 | 6,20 | 6,00 |
| `ramp` | S1 CPU HPA | 27,86 ± 2,94 | 3,60 | 0,00 | 6,00 |
| `ramp` | S2 KEDA red | 101,73 ± 4,10 | 10,20 | 5,00 | 6,00 |
| `spike` | S1 CPU HPA | 38,59 ± 5,48 | 3,20 | 0,00 | 6,00 |
| `spike` | S2 KEDA red | 75,27 ± 3,86 | 3,00 | 0,00 | 6,00 |

KEDA je u profilu `high` reagovala približno dvostruko brže od CPU HPA, ali je poslije početnog povećanja oscilovala između tri i šest replika. Ta dinamika objašnjava 6,2 prosječne oscilacije i 12,8 akcija. U profilu `ramp` KEDA-in redni okidač nije reagovao dok jedna replika nije prestala pratiti rast ulaza; zbog toga je izmjerena reakcija od 101,73 s. CPU HPA je reagovao na porast procesorske iskorištenosti prije formiranja značajnog reda i u četiri izvođenja zadržao gotovo statičko vrijeme obrta.

U profilu `spike` oba skalera dostigla su šest replika, ali tek nakon što je red već brzo rastao. Vrijeme reakcije zato nije dovoljno samo za ocjenu: CPU HPA je ranije dodao drugu repliku, a KEDA brže povećala broj replika u srednjem dijelu rasta, ali su završni P95 i prosječno vrijeme obrta ostali gotovo jednaki.

### 7.7.5. Odnos kapaciteta i vremena obrta

Rezultati pokazuju Pareto-kompromis. Statička politika daje najnižu latenciju kada je svih šest replika potrebno odmah, ali pri `low` profilu troši šest puta više worker-kapaciteta od KEDA-e. KEDA najviše smanjuje worker-minute u sva četiri profila, ali redni okidač dopušta formiranje reda prije povećanja kapaciteta. CPU HPA je konzervativniji: troši više kapaciteta od KEDA-e, ali je u profilu `ramp` ostvario znatno niže vrijeme obrta.

Bez unaprijed definisanog SLO praga nije metodološki opravdano naknadno označiti određeno pogoršanje kao prihvatljivo. Konačan izbor politike zato zavisi od toga da li sistem prvenstveno optimizira aktivirani kapacitet ili repnu latenciju. Za strogi latency SLO potrebna je veća minimalna replika ili proaktivno skaliranje prije predvidivog vrha.

## 7.8. Ocjena hipoteza

H1 je eksperimentalno podržana u dijelu koji se odnosi na smanjenje aktiviranog aplikacijskog kapaciteta. Obje dinamičke politike smanjile su worker-minute u svakom profilu, a relativno smanjenje kretalo se od 14,7% do 83,4%. KEDA je u sva četiri profila ostvarila najniži prosječni aktivirani kapacitet. Hipoteza nije potvrđena kao smanjenje stvarnog novčanog računa jer je eksperiment izveden na fiksno alociranom lokalnom hostu i nije korištena dokumentovana jedinična cijena. Nalaz zato podržava mehanizam potencijalnog smanjenja troška, ne stvarno ostvarenu finansijsku uštedu.

H2 je podržana uslovno i parcijalno. Dinamičke politike povećale su broj poslova po worker-minuti između 17,4% i 500,4%, zadržale gotovo isti throughput i završile sve poslove bez greške. Time je poboljšana efikasnost korištenja aktiviranih worker resursa. Ipak, pri profilima `high`, `ramp` i `spike` manji početni kapacitet povećao je čekanje i vrijeme obrta. KEDA je najefikasnija prema worker-minutama, CPU HPA pruža bolji kompromis pri postepenom rastu, a statička politika štiti latenciju kada se vršni kapacitet mora obezbijediti odmah. Rezultati zato ne podržavaju tvrdnju da autoscaling bezuslovno poboljšava ukupan kvalitet usluge.

| Hipoteza | Eksperimentalna ocjena | Obrazloženje |
|---|---|---|
| H1 | parcijalno podržana | Dinamičke politike smanjile su worker-minute u svim profilima, ali nije mjerena stvarna novčana ušteda. |
| H2 | uslovno i parcijalno podržana | Efikasnost aktiviranih workera je povećana bez gubitka poslova, ali su zahtjevniji profili imali veće čekanje i vrijeme obrta. |

## 7.9. Prijetnje valjanosti

Internu valjanost mogu ugroziti razlike u zagrijavanju kontejnera, keširanju imagea, dijeljenom fizičkom hardveru, stanju MinIO i Redis servisa te redoslijedu izvođenja. Rizik se smanjuje jednakim konfiguracijama, uravnoteženim rasporedom, periodom hlađenja, provjerom praznog reda i ponavljanjem mjerenja.

Konstruktna valjanost ograničena je činjenicom da CPU i RSS worker procesa ne obuhvataju kompletnu potrošnju Kubernetes noda. Worker-minute predstavljaju aktivirani aplikacijski kapacitet, a ne automatski stvarni račun javnog oblaka.

Eksterna valjanost ograničena je jednom aplikacijom, sintetičkim slikama, jednim lokalnim Kubernetes čvorom i kontrolisanim profilima. Klaster nema mrežnu latenciju ni scheduling karakteristike višestrukih fizičkih čvorova. Nalazi se zato ne generalizuju na sve cloud aplikacije, nego pokazuju ponašanje posmatrane arhitekture u dokumentovanim uslovima.

Pet ponavljanja po kombinaciji omogućava procjenu sredine i varijabilnosti, ali je uzorak mali za pouzdanu inferencijalnu generalizaciju. Analiza je zbog toga deskriptivna. Dodatno, nije unaprijed zadan SLO za vrijeme obrta, pa se kvalitet usluge prikazuje kao izmjereni kompromis bez naknadno postavljene granice prihvatljivosti.

Kubernetes klijent 1.32.2 bio je stariji od serverske verzije 1.37.0 izvan preporučenog minor version skew raspona. Eksperimentalne aplikacije, skaleri i telemetrija izvršavali su se na serveru, a sva mjerenja i kontrole završile su uspješno. Ipak, ponavljanje treba provesti s usklađenom klijentskom verzijom kako bi se uklonio ovaj reproduktivni rizik.

## 7.10. Reproduktivnost

Plan matrice generiše se komandom `EXPECTED_REPETITIONS=5 pnpm run:matrix`, pri čemu se finalni runovi čuvaju u `results/final`, odvojeno od pilot-podataka. Konačna agregacija pokreće se sa `RESULTS_DIR=results/final ANALYSIS_DIR=analysis/final STRICT_ANALYSIS=1 EXPECTED_REPETITIONS=5 pnpm analyze:experiments`. Strogi režim prekida analizu ako nedostaje ponavljanje, postoji duplikat, isključeno izvođenje, nedostajući artefakt ili više Git revizija.

Za svako izvođenje arhivirani su manifest, potpuni izvoz eksperimentalne sesije, CSV vremenska serija, k6 sažetak i log, Kubernetes stanje prije i poslije mjerenja, autoscaler stanje i relevantni logovi. Manifesti povezuju sirove podatke sa Git revizijom runnera, dok su skripte završne agregacije i grafikona sačuvane uz projekat. Time je moguće ponoviti agregaciju iz sirovih artefakata bez oslanjanja na vrijednosti prepisane u dokument.
