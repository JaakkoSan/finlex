# PROJECT.md: finlex-mcp

Oma Claude-liitin Finlexin säädösteksteille. Tehty 31.10.2026.

## Miksi oma

Valmis `fi-eli-mcp` (PyPI) haki vain alkuperäisiä säädöksiä (`/statute/`, ELI `/alkup`), vaikka väitti antavansa ajantasaisia, ja haki käynnistyessään tekijän GitHubista asetuksen, joka voi vaihtaa hakuosoitteen. Siksi oma toteutus.

## Päätökset

- Cloudflare Worker, tilaton MCP (Streamable HTTP, JSON-vastaukset). Ainoa ajonaikainen riippuvuus on unpdf PDF-ratkaisujen tekstin purkuun.
- Ei tallennusta. Välimuisti vain Cloudflaren Cache API:ssa.
- Teksti suoraan Finlexin avoimesta datasta, ei välipalvelimia.
- Oletuksena ajantasainen `fin@latest`. Tulevat muutokset merkitään näkyvästi.
- Repo: GitHub, Claude tekee commitit ja Jaakko pushaa.

## Rakenne

- `src/index.js`: MCP-protokolla (initialize, tools/list, tools/call)
- `src/tools.js`: työkalujen määrittelyt ja toteutus
- `src/statute.js`: Akoma Ntoso -dokumentin tulkinta ja tekstiksi muotoilu
- `src/finlex.js`: Finlex-rajapinnan asiakas ja välimuisti
- `src/decisions.js`: viranomaisratkaisut (tietosuojavaltuutettu, oikeusasiamies, oikeuskansleri) ja PDF-tekstin purku
- `src/xml.js`: pieni XML-jäsennin
- `test/smoke.mjs`: savutesti oikeaa Finlexiä vasten

## Julkaisu

- Worker `finlex-mcp` Jaakon omalla Cloudflare-tilillä, osoite https://finlex-mcp.jaakko-sandstrom.workers.dev/mcp
- GitHub-repo JaakkoSan/finlex, Workers Builds julkaisee automaattisesti pushista main-haaraan.

## Muutokset

- 31.10.2026 v1.0: säädöstyökalut.
- 31.10.2026 v1.1: viranomaisratkaisut (hae_ratkaisuja, hae_ratkaisu).
- 31.10.2026 v1.2: käyttörajoitus (istunto + IP), työkalumerkinnät (readOnlyHint), vastauksen enimmäispituus 50 000 merkkiä. Tavoitteena haku Clauden connector-hakemistoon.
