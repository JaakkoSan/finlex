# Jono: finlex-mcp

Liittimen jono (työtapa: keskusrepon docs/liittimien-tyotapa-2026-11-22.md). Valmis kohta poistetaan ja kirjataan MUUTOSLOKI.md:hen samassa commitissa.

## Työn alla

1. **Savutesti ei pysähdy lähteen virheeseen (PR #3, haara testi-syote-virhe).**
   Lähde: https://github.com/JaakkoSan/finlex/pull/3 (Tony 22.11.2026: "Kyllä, tee se"). Vain testi muuttui, versiota ei nosteta.
   Valmis, kun: pääsessio on tarkastanut ja yhdistänyt PR:n ennen #2:ta (docs/siirto-tony-2026-11-22-3.md, taulukko: "yhdistä #3 ensin") ja `node test/smoke.mjs` kulkee loppuun lähteen 503-virheestä huolimatta.

2. **reklamaation_lainkohdat, v1.17.0 (PR #2, haara reklamaation-lainkohdat, issue JaakkoSan/liittimet#14).**
   Lähde: Jaakko 22.11.2026 (issue liittimet#14, pääsessio): "Yrittäjäversio ensin (Suositus)". Aloitus: Tony 22.11.2026 (issue liittimet#14): "kyllä, aloita reklamaatioavustajan valmistelu". Uusi vain lukeva työkalu (33.), ensimmäinen finlexin työkalu, jolla on structuredContent ja outputSchema.
   Valmis, kun: pääsessio on yhdistänyt ja julkaissut (push mainiin, Workers Builds; tämä julkaisee samalla mainissa olevan 1.16.5:n, jos sitä ei ole vielä julkaistu) ja `node savutesti.mjs finlex` keskusreposta antaa 0 virhettä. Sen jälkeen ajetaan reklamaatiotaidon testikysymykset (liittimet#17, ei finlexin työ).

3. **Säädösten liitteet (PR #4, haara saadoksen-liitteet).**
   Lähde: https://github.com/JaakkoSan/finlex/pull/4 ja liittimet#24 (perustamisagentti tarvitsee terveydensuojelulain 763/1994 liitteen taulukon). `hae_pykala` sai parametrin `liite` ja `etsi_saadoksesta` hakee liitteiden riveistä. Versiota ei nostettu: yhdistetään #2:n jälkeen versiona 1.17.1 tai mukaan 1.17.0:aan, jos julkaistaan samalla kertaa.
   Valmis, kun: pääsessio on yhdistänyt ja julkaissut ja savutesti antaa 0 virhettä. Versionumero kirjataan yhdistämisjärjestyksen mukaan.

Rinnakkaiset PR:t: #2, #3 ja #4 ovat eri haaroissa samasta pohjasta. Koeyhdistys kaikissa järjestyksissä on kirjattu PR:iin (#2 ja #3: 146 OK, #2 ja #3 ja #4: 156 OK; FAIL-rivit johtuvat lähteistä, ei yhdistelmästä). PROJECT.md:n muutokset on sijoitettu eri kohtiin (#3 Rakenne-lukuun, #2 ja #4 Muutokset-luvun loppuun eri riveille).

## Seuraavaksi

4. **Koodiajo-valmius: finlex yhteiseen runkoon, hakulistat rakenteisiksi.**
   Lähde: keskusrepon TILANNE.md, Jono, kohta 15 ("Aloitetaan, kun ajanvaraus, allekirjoitus ja soklo.online ovat myyntikunnossa."); keskusrepon CLAUDE.md, Koodiajo-valmius (Jaakko 21.11.2026: "jos on jotain mikä kannattaa myöhemmin niin onko hyödyllistä rakentaa alusta asti siihen suuntaan? Tässä on tarkoitus kuitenkin kasvaa ja laajentaa toimintaa"); kysymys issue JaakkoSan/liittimet#22 on avoin. Suunnitelma: suunnitelmat/2026-11-22-koodiajo-tila-liittimittain.md (finlex on suuri, 32 työkalua, joten jaetaan useaan julkaisuun; sanatarkka teksti pysyy tekstinä).
   Valmis, kun: pääsessio on vastannut issueen #22 ja sallinut aloituksen; sen jälkeen finlexin ensimmäinen vaihe (YT8-siirto runkoon) on yhdistetty ja julkaistu ja savutesti antaa 0 virhettä.

## Myöhemmin

- **Finlexin sivutuksen tuotantotarkistus.** Lähde: keskusrepon TILANNE.md, Ajastetut (viikko 47: "Tarkista uudelleen pe 20.11. (lastSeen ilman page-parametria palauttaa sivun 2)"). Sivutus korjattiin 1.16.5:ssä (PROJECT.md 22.11.2026); varmistetaan tuotannossa, kun 1.16.5 on julkaistu.
- **Lakimuutosvahti.** Lähde: keskusrepon TILANNE.md, Ajastetut ("Lakimuutosvahdin koodaus tämän jälkeen (suunnitelma suunnitelmat/lakimuutosvahti.md)"). Vahti on oma liitin (lakivahti-mcp), joka käyttää finlexin walkList-funktiota tagiin lukittuna; finlexiin ei tehdä sitä varten muutosta ennen kuin vahti aloitetaan.
- **Viranomaistiedotteen hakusanan kaksoisosuma.** Lähde: keskusrepon TILANNE.md, Jono, kohta 8 (Pienet): hakusanassa kaksi lähekkäistä osumaa näyttää saman otteen kahdesti ("tarjottu, ei tilattu").
- **Anthropicin liitinhakemiston hakemus (finlex, eurlex, Aluetieto).** Lähde: keskusrepon TILANNE.md, Jono, kohta 9, ja CLAUDE.md, Liitinten tuotteistus ("Hakemistot (finlex, eurlex, Aluetieto) ovat Jaakon päätös, avoin."). Suunnitelma suunnitelmat/liitinhakemisto.md. Jaakon päätös.
- **TEM:n vastaus KILA-aineiston kaupallisesta käytöstä.** Lähde: keskusrepon vanha TILANNE.md, Odottaa muita (git-historia); suunnitelma suunnitelmat/kila.md keskusrepossa. Odottaa ulkopuolista vastausta; ei toimenpidettä ennen sitä.

## Hylätty

(tyhjä)
