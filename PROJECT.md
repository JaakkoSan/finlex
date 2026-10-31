# PROJECT.md: finlex-mcp

Oma Claude-liitin Finlexin säädösteksteille. Tehty 31.10.2026.

## Miksi oma

Valmis `fi-eli-mcp` (PyPI) haki vain alkuperäisiä säädöksiä (`/statute/`, ELI `/alkup`), vaikka väitti antavansa ajantasaisia, ja haki käynnistyessään tekijän GitHubista asetuksen, joka voi vaihtaa hakuosoitteen. Siksi oma toteutus.

## Päätökset

- Cloudflare Worker, tilaton MCP (Streamable HTTP, JSON-vastaukset), ei riippuvuuksia ajonaikana.
- Ei tallennusta. Välimuisti vain Cloudflaren Cache API:ssa.
- Teksti suoraan Finlexin avoimesta datasta, ei välipalvelimia.
- Oletuksena ajantasainen `fin@latest`. Tulevat muutokset merkitään näkyvästi.
- Repo: GitHub, Claude tekee commitit ja Jaakko pushaa.

## Rakenne

- `src/index.js`: MCP-protokolla (initialize, tools/list, tools/call)
- `src/tools.js`: työkalujen määrittelyt ja toteutus
- `src/statute.js`: Akoma Ntoso -dokumentin tulkinta ja tekstiksi muotoilu
- `src/finlex.js`: Finlex-rajapinnan asiakas ja välimuisti
- `src/xml.js`: pieni XML-jäsennin
- `test/smoke.mjs`: savutesti oikeaa Finlexiä vasten

## Avoimet

- Julkaisu Cloudflareen ja liittimen lisäys Claudeen.
- Mahdollinen jatko: tietosuojavaltuutetun ja oikeuskanslerin ratkaisut (`/akn/fi/judgment/...`).
