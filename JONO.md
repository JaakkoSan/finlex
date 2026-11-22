# Jono: finlex-mcp

Liittimen jono (työtapa keskusrepossa). Valmis kohta poistetaan ja kirjataan MUUTOSLOKI.md:hen samassa commitissa.

## Työn alla

1. **Savutesti ei pysähdy lähteen virheeseen (PR #3, haara testi-syote-virhe).**
   Vain testi muuttui, versiota ei nosteta.
   Valmis, kun: PR #3 on yhdistetty ennen PR #2:ta ja `node test/smoke.mjs` kulkee loppuun lähteen 503-virheestä huolimatta.

2. **reklamaation_lainkohdat, v1.17.0 (PR #2, haara reklamaation-lainkohdat).**
   Uusi vain lukeva työkalu (33.), ensimmäinen finlexin työkalu, jolla on structuredContent ja outputSchema. Perustelut keskusrepon JONO.md:ssä.
   Valmis, kun: PR #2 on yhdistetty ja julkaistu (push mainiin, Workers Builds; tämä julkaisee samalla mainissa olevan 1.16.5:n, jos sitä ei ole vielä julkaistu) ja `node savutesti.mjs finlex` keskusreposta antaa 0 virhettä.

3. **Säädösten liitteet (PR #4, haara saadoksen-liitteet).**
   `hae_pykala` sai parametrin `liite` ja `etsi_saadoksesta` hakee liitteiden riveistä. Versiota ei nostettu: yhdistetään #2:n jälkeen versiona 1.17.1 tai mukaan 1.17.0:aan, jos julkaistaan samalla kertaa. Perustelut keskusrepon JONO.md:ssä.
   Valmis, kun: PR #4 on yhdistetty ja julkaistu ja savutesti antaa 0 virhettä. Versionumero kirjataan yhdistämisjärjestyksen mukaan.

Rinnakkaiset PR:t: #2, #3 ja #4 ovat eri haaroissa samasta pohjasta. Koeyhdistys kaikissa järjestyksissä on kirjattu PR:iin (#2 ja #3: 146 OK, #2 ja #3 ja #4: 156 OK; FAIL-rivit johtuvat lähteistä, ei yhdistelmästä). PROJECT.md:n muutokset on sijoitettu eri kohtiin (#3 Rakenne-lukuun, #2 ja #4 Muutokset-luvun loppuun eri riveille).

## Seuraavaksi

4. **Koodiajo-valmius: finlex yhteiseen runkoon, hakulistat rakenteisiksi.**
   Finlex on suuri (32 työkalua), joten työ jaetaan useaan julkaisuun; sanatarkka teksti pysyy tekstinä. Perustelut ja aloitusehto keskusrepon JONO.md:ssä.
   Valmis, kun: aloitus on sallittu ja finlexin ensimmäinen vaihe (siirto yhteiseen runkoon) on yhdistetty ja julkaistu ja savutesti antaa 0 virhettä.

## Myöhemmin

- **Finlexin sivutuksen tuotantotarkistus.** Sivutus korjattiin 1.16.5:ssä (PROJECT.md 22.11.2026); varmistetaan tuotannossa, että `lastSeen` ilman `page`-parametria palauttaa oikean sivun, kun 1.16.5 on julkaistu.
- **Lakimuutosvahti.** Finlexiin ei tehdä muutosta sitä varten ennen kuin vahti aloitetaan. Perustelut keskusrepon JONO.md:ssä.
- **Viranomaistiedotteen hakusanan kaksoisosuma.** Hakusanassa kaksi lähekkäistä osumaa näyttää saman otteen kahdesti.
- **Anthropicin liitinhakemiston hakemus (finlex, eurlex, Aluetieto).** Perustelut keskusrepon JONO.md:ssä.

## Hylätty

(tyhjä)
