# Eksperimentalni protokol

## 1. Cilj

Cilj eksperimenta je uporediti statičku i dinamičku alokaciju worker resursa tokom obrade istog skupa poslova i utvrditi njihov uticaj na aktivirani kapacitet, iskorištenost resursa, protok i vrijeme obrta.

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
| završeni/neuspješni poslovi | Redis događaji završetka workera |
| throughput 60 s | broj uspješnih događaja u posljednjih 60 sekundi |
| obrada i P95 | trajanje uspješnih worker poslova |
| čekanje | `processedOn - timestamp` BullMQ posla |
| obrađeni podaci | zbir glavnih izlaza i thumbnaila |

## 3. Nezavisna i zavisne varijable

Jedina namjerno promijenjena nezavisna varijabla je politika alokacije workera:

- statička: šest replika tokom cijelog testa;
- dinamička: od jedne do šest replika, cilj pet poslova na čekanju po replici.

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

1. Provjeriti da aplikacija, Redis, MinIO i sistem metrika rade.
2. Očistiti prethodne redove i eksperimentalne rezultate.
3. Sačekati da broj worker replika dostigne početno stanje.
4. Zabilježiti tačnu konfiguraciju, vrijeme početka i identifikator izvođenja.
5. U prikazu Eksperiment pokrenuti sesiju i upisati isti naziv profila koji će koristiti k6.
6. Pokrenuti jedan k6 profil.
7. Nastaviti prikupljanje metrika dok red ne bude prazan i svi poslovi ne završe.
8. Zaustaviti sesiju i sačuvati njen JSON i CSV export.
9. Sačuvati k6 JSON, Prometheus podatke, broj replika i logove grešaka.
10. Ostaviti period hlađenja prije narednog izvođenja.

Svaki profil se izvodi najmanje pet puta po politici. Preporučeni redoslijed je S-D-D-S-S-D-D-S-D-S, gdje S označava statičko, a D dinamičko okruženje, kako redoslijed ne bi bio povezan s jednom politikom.

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

JSON export je primarni zapis sesije jer sadrži metapodatke, sve periodične uzorke i završni sažetak. CSV sadrži vremensku seriju i koristi se za tabelarnu analizu. Export treba arhivirati zajedno s k6 rezultatom i oznakom image verzije.

## 7. Analiza

Za svaku metriku prikazati srednju vrijednost, medijan, standardnu devijaciju i P95 gdje ima smisla. Uz apsolutne vrijednosti prikazati relativnu promjenu dinamičkog u odnosu na statički scenarij.

Grafikoni po vremenu trebaju na istoj osi prikazati ulazno opterećenje, dužinu reda, broj replika i P95 vrijeme obrta. Zbirna tabela treba povezati performanse s worker-minutama i procijenjenim troškom.

Dashboard služi za praćenje izvođenja i koristi samo trenutne Redis/BullMQ podatke. Za konačnu statističku analizu koriste se sačuvani exporti svih ponavljanja, a ne vrijednost vidljiva u jednom trenutku na ekranu.

## 8. Prijetnje valjanosti

- dvije cloud VM instance mogu dijeliti fizički hardver različitih performansi;
- sintetičke slike i opterećenje ne predstavljaju sve produkcijske obrasce;
- MinIO i Redis mogu postati usko grlo nezavisno od workera;
- vrijeme pokretanja kontejnera zavisi od keširanja imagea;
- HPA/KEDA smanjuje alocirane pod-resurse, ali fiksno naplaćena VM ne smanjuje automatski stvarni račun;
- jedan tip aplikacije ne omogućava generalizaciju na sva cloud opterećenja.

Ograničenja se navode otvoreno i koriste pri formulisanju uslovnog zaključka o hipotezama.
