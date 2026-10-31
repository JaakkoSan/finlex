# finlex-mcp

Claude-liitin (MCP-palvelin), joka hakee Suomen säädösten sanatarkan tekstin, hallituksen esitykset ja viranomaisratkaisuja suoraan Finlexin avoimesta datasta sekä lakien eduskuntakäsittelyn (valiokuntien mietinnöt ja lausunnot, eduskunnan vastaukset) Eduskunnan avoimesta datasta. Toimii Cloudflare Workerina, ei tallenna mitään eikä tarvitse API-avaimia.

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
- Eduskunnan asiakirjahaku vertaa sanoja sellaisinaan, joten taivutusmuoto vaikuttaa osumiin. Haku on hidas (useita sekunteja).

## Lisenssi

Koodi: MIT, ks. [LICENSE](LICENSE).

Data: Finlexin avoin data, oikeusministeriö, ja Eduskunnan avoin data, eduskunta, molemmat lisenssillä [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.fi) (lähde on mainittava). Tämä ei ole oikeusministeriön, Finlexin tai eduskunnan palvelu.
