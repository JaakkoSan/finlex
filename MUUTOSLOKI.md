# Muutosloki: finlex-mcp

Aiempi historia: PROJECT.md, luku Muutokset.

- 22.11.2026: PR #1 (v1.16.4, odottamattoman virheen teksti piiloon) yhdistetty mainiin (21b9125); v1.16.5 (sivutuskorjaus) mainissa (845ca4d). PROJECT.md:n mukaan kumpaakaan ei ole merkitty julkaistuksi. Lähde: repon git log.
- 22.11.2026: Sivutuksen tuotantotarkistus (v1.16.5) tehty: lastSeen ilman page-parametria palauttaa oikean sivun 2, ja hae_saadoksia-haun sivut 1-3 vastaavat suoraa lastSeen-kävelyä (ei toistoa, ei puuttuvia rivejä). Testattu vain hae_saadoksia; hallituksen esitykset, ratkaisut ja sopimusluettelo käyttävät samaa walkList-koodia.
