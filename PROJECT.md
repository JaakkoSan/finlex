# PROJECT.md: finlex-mcp

Oma Claude-liitin Finlexin säädösteksteille ja lakien eduskuntakäsittelylle. Tehty 31.10.2026.

## Miksi oma

Valmis `fi-eli-mcp` (PyPI) haki vain alkuperäisiä säädöksiä (`/statute/`, ELI `/alkup`), vaikka väitti antavansa ajantasaisia, ja haki käynnistyessään tekijän GitHubista asetuksen, joka voi vaihtaa hakuosoitteen. Siksi oma toteutus.

## Päätökset

- Cloudflare Worker, tilaton MCP (Streamable HTTP, JSON-vastaukset). Ainoa ajonaikainen riippuvuus on unpdf PDF-ratkaisujen tekstin purkuun.
- Ei tallennusta. Välimuisti vain Cloudflaren Cache API:ssa.
- Teksti suoraan Finlexin avoimesta datasta, ei välipalvelimia.
- Oletuksena ajantasainen `fin@latest`. Tulevat muutokset merkitään näkyvästi.
- Repo: GitHub. Commitit tehdään paikallisesti ja pushataan GitHubiin.

## Rakenne

- `src/index.js`: MCP-protokolla (initialize, tools/list, tools/call)
- `src/tools.js`: työkalujen määrittelyt ja toteutus
- `src/statute.js`: Akoma Ntoso -dokumentin tulkinta ja tekstiksi muotoilu
- `src/statuteIndex.js`: säädöksen hakemisto välimuistia varten (pykälät, hakuteksti, luvut)
- `src/proposal.js`: hallituksen esitysten jäsennys ja hakemisto (perustelujen lohkot, pykälien perustelut, lakiehdotukset)
- `src/finlex.js`: Finlex-rajapinnan asiakas ja välimuisti
- `src/decisions.js`: viranomaisratkaisut (tietosuojavaltuutettu, oikeusasiamies, oikeuskansleri) ja PDF-tekstin purku
- `src/eduskunta.js`: Eduskunnan avoimen datan rajapinnan asiakas (api.eduskunta.fi), tunnusten normalisointi
- `src/edkDoc.js`: eduskunnan asiakirjan (mietintö, lausunto, eduskunnan vastaus) HTML:n jäsennys lohkoiksi ja pykälähakemistoksi
- `src/xml.js`: pieni XML-jäsennin
- `test/smoke.mjs`: savutesti oikeaa Finlexiä vasten

## Julkaisu

- Worker `finlex-mcp` Cloudflaressa, osoite `https://finlex-mcp.<alitunnus>.workers.dev/mcp`.
- Workers Builds julkaisee automaattisesti pushista main-haaraan.

## Muutokset

- 31.10.2026 v1.0: säädöstyökalut.
- 31.10.2026 v1.1: viranomaisratkaisut (hae_ratkaisuja, hae_ratkaisu).
- 31.10.2026 v1.2: käyttörajoitus (istunto + IP), työkalumerkinnät (readOnlyHint), vastauksen enimmäispituus 50 000 merkkiä. Tavoitteena haku Clauden connector-hakemistoon.
- 31.10.2026: MIT-lisenssi, repo valmisteltu julkiseksi.
- 31.10.2026 v1.3: välimuistiin valmiiksi jäsennetty hakemisto raa'an XML:n sijaan (CPU-aika välimuistista n. 2–10 ms, ennen 20–90 ms). Tulevien muutosten merkinnät lisätään vasta pyynnön hetkellä.
- 31.10.2026 v1.4: hallituksen esitykset (hae_hallituksen_esityksia, hallituksen_esitys, etsi_hallituksen_esityksesta) Finlexin avoimesta datasta. Lähde valittu Finlexistä eduskunnan avoimen datan sijaan, koska Finlexissä esitykset ovat samassa Akoma Ntoso -muodossa kuin säädökset.
- 31.10.2026 v1.5: eduskuntakäsittely (eduskuntakasittely, eduskunnan_asiakirja, hae_eduskunnan_asiakirjoja) Eduskunnan avoimesta datasta (api.eduskunta.fi, CC BY 4.0). Uusi rajapinta valittu, koska vanhasta (avoindata.eduskunta.fi) luovutaan vuoden 2026 lopussa (eduskunta.fi, avoin data, luettu 31.10.2026). Asiakirjat luetaan HTML-muodossa, koska se on saatavilla myös vuosien 1999–2014 asiakirjoista, joista XML:ää ei ole. hallituksen_esitys-yleiskuvassa viittaus eduskuntakäsittelyyn.
