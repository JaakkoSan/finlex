# finlex-mcp

Claude-liitin (MCP-palvelin), joka hakee Suomen säädösten sanatarkan tekstin, hallituksen esitykset, yleissitovat työehtosopimukset, viranomaisten määräykset ja viranomaisratkaisuja suoraan Finlexin avoimesta datasta, lakien valmistelun ministeriöissä (hankkeet, lausuntokierrokset, lausunnot) valtioneuvoston Hankeikkunasta sekä lakien eduskuntakäsittelyn (valiokuntien mietinnöt ja lausunnot, eduskunnan vastaukset) Eduskunnan avoimesta datasta. Toimii Cloudflare Workerina, ei tallenna mitään eikä tarvitse API-avaimia.

## Työkalut

| Työkalu | Mitä tekee |
|---|---|
| `hae_saadoksia` | Haku säädöksen nimen osalla tai asiasanalla, palauttaa numerot ja nimet |
| `saados_tiedot` | Perustiedot, voimassaolo, muutossäädökset voimaantulopäivineen, esityöt, sisällysluettelo |
| `hae_pykala` | Pykälän tai koko luvun teksti momentteineen ja Finlexin huomautuksineen |
| `etsi_saadoksesta` | Sanahaku yhden säädöksen tekstistä, palauttaa pykälät ja otteet |
| `hae_hallituksen_esityksia` | Hallituksen esitysten haku otsikon osalla ja vuosilla |
| `hallituksen_esitys` | Esityksen pääasiallinen sisältö ja perustelujen sisällysluettelo; lisäksi yksi perustelujen lohko, pykälän säännöskohtaiset perustelut, lakiehdotuksen tai liitteen teksti |
| `etsi_hallituksen_esityksesta` | Sanahaku yhden esityksen tekstistä, palauttaa lohkot ja otteet |
| `hae_tyoehtosopimuksia` | Yleissitovat työehtosopimukset nimellä tai sopijaliitolla: sopijaosapuolet ja voimassa oleva sopimuskausi |
| `tyoehtosopimus` | Yleissitovuuspäätös ja soveltamisala, sopimusversiot ja sisällysluettelo; lisäksi pykälä, sanahaku tai sivualue sopimuksen PDF:stä |
| `hae_viranomaismaarayksia` | Viranomaisten määräykset otsikon sanalla, asiasanalla ja vuosilla |
| `viranomaismaarays` | Määräyksen tiedot (viranomainen, tunnus, voimaantulo) ja teksti PDF:stä sivuittain tai sanahaulla |
| `hae_lainvalmisteluhankkeita` | Ministeriöiden lainvalmistelu- ja muiden hankkeiden haku hakusanalla, ministeriöllä, tilalla, vaiheella ja asettamispäivällä; käynnissä olevat lausuntokierrokset määräajan mukaan |
| `lainvalmisteluhanke` | Hankkeen tila ja valmisteluvaihe, tiivistelmä, HE-tiedot (HE-luettelo, vastuuministeri, säädösnumerot), vaiheet ja lausuntokierrokset, linkit lausuntopalveluun ja numeroitu asiakirjaluettelo (lausunnot laatijoittain); myös HE-numerolla |
| `lainvalmistelun_asiakirja` | Hankkeen asiakirjan teksti (PDF tai Word) osina tai hakusanan osumat |
| `eduskuntakasittely` | Asian (esim. HE) käsittely eduskunnassa: tila ja lopputulos, mietintö, lausunnot, eduskunnan vastaus, lakiehdotusten päätökset ja säädösnumerot |
| `eduskunnan_asiakirja` | Mietinnön, lausunnon tai eduskunnan vastauksen sisällys ja päätösosa; lisäksi pykälän perustelut ja ehdotettu tai hyväksytty sanamuoto, yksi lohko tai sanahaku |
| `hae_eduskunnan_asiakirjoja` | Mietintöjen, lausuntojen ja eduskunnan vastausten haku tekstin sanalla, valiokunnalla ja vuosilla |
| `hae_ratkaisuja` | Tietosuojavaltuutetun, eduskunnan oikeusasiamiehen tai oikeuskanslerin ratkaisut otsikolla, asiasanalla tai vuosilla |
| `hae_ratkaisu` | Yhden ratkaisun tiedot ja koko teksti (PDF-ratkaisuista teksti puretaan) |

Kaikissa tekstityökaluissa:

- `teksti`: `ajantasainen` (oletus) tai `alkuperainen` (säädöskokoelman versio)
- `versio`: aiempi ajantasainen versio muutossäädöksen numerolla, esim. `448/2024`
- `kieli`: `fin` (oletus) tai `swe`

## Miten ajantasaisuus kerrotaan

- Jokaisen vastauksen alussa kerrotaan, onko teksti ajantasainen vai alkuperäinen, mihin muutossäädökseen asti se on ajantasaistettu ja Finlex-linkki.
- Jos säädöksellä ei ole ajantasaistettua versiota, palautetaan alkuperäinen ja siitä sanotaan erikseen.
- Finlexin ajantasainen teksti voi sisältää muutoksia, jotka eivät ole vielä voimassa. Ne merkitään otsikkoon (HUOM) ja kohtiin (`EI VIELÄ VOIMASSA, voimaan pp.kk.vvvv`). Aiempi sanamuoto näkyy Finlexin huomautuksen jälkeen.
- Jokaisessa muutetussa kohdassa näkyy, mikä säädös sanamuodon on antanut (`[sanamuoto: 28.6.2024/448]`).

## Rajapinta

- Lähde: `https://opendata.finlex.fi/finlex/avoindata/v1` (oikeusministeriö / Finlex), OpenAPI-kuvaus `https://opendata.finlex.fi/Finlex_avoin_data_v0_4_0.yaml`
- Ajantasainen: `/akn/fi/act/statute-consolidated/{vuosi}/{numero}/fin@latest`
- Alkuperäinen: `/akn/fi/act/statute/{vuosi}/{numero}/fin@`
- Haku: `/akn/fi/act/statute-consolidated/list?titleContains=…&langAndVersion=fin@latest`
- Hallituksen esitykset: `/akn/fi/doc/government-proposal/{vuosi}/{numero}/fin@` (välimuisti 30 vrk)
- Eduskunnan asiakirjat: `https://api.eduskunta.fi/api/v1` (Eduskunnan avoin data, OpenAPI-kuvaus `https://api.eduskunta.fi/openapi.json`). Asia ja asiakirjan tunnistus haulla `POST /search` (`stringValue`-ehto tunnukselle), teksti `GET /asiakirjat/edktunnus/{edktunnus}/html`. Rajapinta sallii 180 GET- ja 90 POST-pyyntöä minuutissa IP-osoitetta kohden; vastaukset välimuistitetaan (asia 6 h, asiakirjan hakemisto 7 vrk).
- Työehtosopimukset: `/akn/fi/doc/collective-agreement-general-applicability-decision/{vuosi}/{numero}/fin@` (yleissitovuuspäätös, metatiedoissa sopimusversiot) ja sopimus PDF:nä `…/fin@/collectiveAgreement/{tiedosto}.pdf`. Kaikkien päätösten luettelo (n. 210) muodostetaan listauksesta ja päätösten metatiedoista ja pidetään välimuistissa vuorokauden; ensimmäinen haku kestää useita sekunteja.
- Viranomaisten määräykset: `/akn/fi/doc/authority-regulation/{viranomainen}/{vuosi}/{numero}/fin@`, teksti `…/main.pdf`. Tunnisteessa on viranomainen, koska vuodesta 2025 numerointi on viranomaiskohtainen.
- PDF-tekstit puretaan sivuittain (unpdf) ja tallennetaan välimuistiin 30 vuorokaudeksi.
- Lainvalmistelu: `https://api.hankeikkuna.fi/api/v2` (valtioneuvoston Hankeikkunan julkinen rajapinta, CC BY 4.0, kuvaus `https://api.hankeikkuna.fi/api/api-docs`). Haku `POST /kohteet/haku`, ministeriöt `GET /asettajat`, asiakirjat `https://api.hankeikkuna.fi/asiakirjat/…`. Hakuvastaukset ovat suuria (hanke asiakirjaluetteloineen 30–400 kt), joten välimuistiin tallennetaan vain tiivistetyt tiedot (1 h) ja asiakirjojen purettu teksti (30 vrk). Hankesivun linkki `https://valtioneuvosto.fi/hanke?tunnus=…`.
- Ratkaisut: `/akn/fi/judgment/{data-protection-ombudsman-decision|parliamentary-ombudsman-decision|chancellor-of-justice-decision}/{vuosi}/{numero}/fin@`
- Välimuisti: uusin versio 6 h, kiinteät versiot 30 vrk (Cloudflaren Cache API). Säädös jäsennetään kerran, ja välimuistiin tallennetaan valmis hakemisto osina (perustiedot, hakuteksti, muotoillut pykälät), jotta kutsu pysyy Workersin ilmaistason CPU-rajan (10 ms) alla.

## Käyttörajoitus ja merkinnät

- Työkalukutsuja rajoitetaan Cloudflaren Rate Limiting -sidonnoilla: 30 kutsua minuutissa per MCP-istunto ja 300 per IP-osoite (Clauden pyynnöt tulevat Anthropicin palvelimilta, joten IP-raja on väljä). Rajan ylittyessä työkalu palauttaa virheilmoituksen eikä hae Finlexistä.
- Istuntotunnus annetaan `initialize`-vastauksen `Mcp-Session-Id`-otsakkeessa. Sitä ei tallenneta mihinkään, se toimii vain rajoittimen avaimena.
- Kaikilla työkaluilla on MCP-merkinnät `readOnlyHint: true` ja `destructiveHint: false`.
- Yhden vastauksen enimmäispituus on 50 000 merkkiä (Claude rajaa työkalun vastauksen 25 000 tokeniin).

## Kehitys

```
npm install
npm test          # savutesti oikeaa Finlexiä vasten (Node 20+)
npm run dev       # paikallinen Worker osoitteessa http://localhost:8787/mcp
```

## Julkaisu

Cloudflaressa: Workers & Pages → Create → Import a repository → tämä repo. Build-komentoa ei tarvita, deploy-komento `npx wrangler deploy`.

Liittimen osoite Claudeen: `https://finlex-mcp.<oma-alitunnus>.workers.dev/mcp`

Valinnainen salainen polku: aseta Workerille salaisuus `MCP_PATH_SECRET`, jolloin osoite on `/mcp/<salaisuus>`. Data on julkista, joten tämä vain estää muita käyttämästä Workeria.

## Rajoitukset

- Finlexin rajapinnassa ei ole koko tekstin hakua kaikista säädöksistä. Haku toimii nimen osalla ja asiasanoilla, ja yhden säädöksen sisällä sanahaulla.
- Tuomioistuinten ratkaisut (KKO, KHO) eivät ole Finlexin avoimessa rajapinnassa.
- Hallituksen esitykset ovat avoimessa datassa vuodesta 1992. Ruotsinkielisistä esityksistä datassa on vain otsikko, joten esitystyökalut ovat suomenkielisiä.
- Pykälän säännöskohtaiset perustelut tunnistetaan kappaleesta, joka alkaa pykälänumerolla ("3 §.") tai artiklalla ("3 artikla."), ja ne päättyvät seuraavan pykälän tai luvun alkuun. Kaikissa esityksissä ei ole erillisiä säännöskohtaisia perusteluja.
- Oikeusasiamiehen ratkaisut ja oikeuskanslerin päätökset ovat Finlexissä pääosin PDF:nä. Teksti puretaan PDF:stä automaattisesti (unpdf), joten rivitys ja taulukot voivat poiketa alkuperäisestä.
- Ratkaisuhaku palauttaa tulokset vanhimmasta uusimpaan; uusimpiin pääsee vuosirajauksella.
- Ratkaisujen asiasana annetaan Finlexin muodossa, esim. `kameravalvonta`, `terveystiedot` (välilyönnit muutetaan alaviivoiksi).
- Ajantasainen teksti on Finlexin toimituksellinen kooste, ei virallinen säädösteksti.
- Eduskunnan asiakirjoista on tekstiä vuodesta 1999 alkaen; vanhemmista on rajapinnassa vain PDF. Vuodesta 2015 asiakirjat ovat Vaski-muodossa, jossa valiokunnan muutokset hallituksen esityksen tekstiin merkitään (`«…»`). Vanhemmista asiakirjoista rakenne tunnistetaan otsikoista.
- Pykälän perustelut tunnistetaan valiokunnan yksityiskohtaisten perustelujen pykäläotsikoista ("51 a §. Otsikko."). Valiokunta käsittelee osaa pykälistä vain yleisperusteluissa.
- Asian käsittelyn vaiheista näytetään oletuksena päävaiheet (vireilletulo, lähetekeskustelu, valiokuntien ratkaisut ja vastalauseet, mietintö ja lausunnot, täysistuntokäsittelyt, eduskunnan vastaus). Valiokuntien kokouskohtaiset vaiheet saa parametrilla `kaikki_vaiheet`; suurimmissa asioissa niitä on satoja.
- Työehtosopimusten teksti puretaan PDF:stä, joten palkkataulukot ja rivitys voivat poiketa alkuperäisestä. Pykälät tunnistetaan otsikkoriveistä (`5 § Palkat` tai `§ 5`); sama numero esiintyy usein sopimuksen eri osissa (työehtosopimus, palkkasopimus, liitteet), ja kaikki esiintymät palautetaan.
- Finlexissä on vain yleissitoviksi vahvistetut työehtosopimukset. Uusi sopimuskausi tulee Finlexiin vasta yleissitovuuspäätöksen jälkeen, joten voimassa olevaa sopimusta ei aina vielä ole; työkalu kertoo, jos viimeisin Finlexissä oleva sopimus on päättynyt.
- Viranomaisten määräysten haku palauttaa tulokset vanhimmasta uusimpaan, ja Finlexin metatiedoissa ei aina ole kumoamistietoa. Viranomaisrajausta ei ole, koska rajapinnan authority-ehto ei palauttanut tuloksia; viranomaisen nimi on yleensä otsikossa tai asiasanoissa.
- Finlex on ilmoittanut vaihtavansa listausten sivutuksen page-parametrista lastSeen-parametriin (finlex.fi/fi/avoin-data, "viikolla 47"). Hakujen sivu N haetaan siksi kulkemalla sivut 1..N järjestyksessä, ja jokaisessa pyynnössä annetaan sekä page että edellisen sivun viimeisen tietueen lastSeen (muodossa `/akn/fi/act/statute-consolidated/1992/912`). Näin sivutus toimii sekä vanhassa että uudessa mallissa. Sivut ovat välimuistissa, ja selaussyvyys on enintään 30 sivua. lastSeen-arvon muoto on Finlexin esimerkin mukainen, eikä sitä voinut testata ennen muutosta.
- Hankeikkunan asiakirjat numeroidaan luontiajan mukaan. Numero voi muuttua, jos hankkeeseen lisätään vanhempia asiakirjoja jälkikäteen, joten numero haetaan aina samasta luettelosta.
- Hankeikkunan valmisteluvaihe ja vaiheiden tila ovat ministeriön kirjaamia, eivätkä ne ole aina ajan tasalla. Lausuntokierroksen tila (käynnissä, päättynyt, tulossa) lasketaan päivämääristä.
- Asiakirjoista puretaan PDF ja Word (.docx). Vanhat Word- (.doc) ja RTF-tiedostot sekä skannatut PDF:t ilman tekstikerrosta näytetään vain linkkinä. Osasta asiakirjoja on julkaistu vain viitetiedot.
- Käynnissä olevat lausuntokierrokset haetaan viimeisten 180 päivän aikana alkaneista kierroksista.
- Eduskunnan asiakirjahaku vertaa sanoja sellaisinaan, joten taivutusmuoto vaikuttaa osumiin. Haku on hidas (useita sekunteja).

## Lisenssi

Koodi: MIT, ks. [LICENSE](LICENSE).

Data: Finlexin avoin data, oikeusministeriö; valtioneuvoston Hankeikkuna; ja Eduskunnan avoin data, eduskunta; kaikki lisenssillä [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.fi) (lähde on mainittava). Tämä ei ole oikeusministeriön, Finlexin, valtioneuvoston tai eduskunnan palvelu.
