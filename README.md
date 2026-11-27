# Fotografické portfolio s editorem

Statický web pro GitHub Pages. Žádné knihovny, žádný build. Editor běží na `/admin/` a je to tatáž stránka, kterou vidí návštěvník, jen v režimu úprav.

## Soubory

```
index.html, style.css, site.js   veřejný web; site.js kreslí stránku z content.json
content.json                     veškerý obsah (texty, pořadí, odkazy na fotky)
photos/                          fotky nahrané editorem (vzniká samo)
admin/index.html, admin.js, admin.css   editor
admin/access.json                token zašifrovaný heslem (vzniká při prvním spuštění)
dev-server.js                    místní náhled včetně editoru
.nojekyll                        říká GitHubu, ať soubory nijak nezpracovává
```

## Místní náhled

```powershell
node dev-server.js
```

Web je na `http://localhost:8080`, editor na `http://localhost:8080/admin/`. Místně se nic neposílá na GitHub: Publikovat zapisuje přímo do této složky a jako token stačí libovolný text.

## Nasazení na GitHub Pages

1. Nahraj obsah této složky do repozitáře (do kořene výchozí větve).
2. V repozitáři: Settings → Pages → Deploy from a branch → výchozí větev, složka `/ (root)`.
3. Vytvoř token: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens. Repository access: jen tento repozitář. Permissions: **Contents: Read and write**. Nic dalšího.
4. Otevři `https://<uzivatel>.github.io/<repozitar>/admin/`, vlož token a zvol heslo (aspoň 12 znaků). Editor token zašifruje heslem a uloží do `admin/access.json`.

Od té chvíle se do editoru přihlašuje jen heslem, z jakéhokoli zařízení.

## Jak editor funguje

- Klikni do textu a piš. Fotky: tlačítka „+ Přidat fotky", „Vyměnit", šipky pro pořadí, křížek pro smazání.
- Fotky se v prohlížeči zmenší (max. 2200 px + náhled 900 px, JPEG), takže lze nahrávat rovnou z foťáku.
- Změny jsou jen v prohlížeči, dokud nestiskneš **Publikovat**. To udělá jeden commit: `content.json`, nové fotky a smazání fotek, které už na stránce nejsou.
- Web se po publikování aktualizuje zhruba do minuty (GitHub Pages).
- Kategorie v galerii vznikají samy z toho, co napíšeš k fotkám; filtr se objeví, jakmile jsou aspoň dvě.

## Bezpečnost: co je dobré vědět

- GitHub Pages nemá server, takže heslo neověřuje server. Heslo odemyká zašifrovaný token (AES-GCM, klíč PBKDF2 s 600 000 koly).
- `admin/access.json` je veřejně čitelný. Kdo ho stáhne, může heslo zkoušet hádat u sebe bez omezení počtu pokusů. Proto **dlouhé heslo** (ideálně věta nebo správce hesel).
- Token má právo zapisovat jen do tohoto jednoho repozitáře. Při podezření ho na GitHubu zruš, vytvoř nový a na přihlašovací stránce zvol „nastavit znovu".
- Token má platnost, kterou mu nastavíš. Po vypršení stačí stejný postup.
- Smazané fotky zůstávají v historii repozitáře.

## Úpravy kódu

Nový typ sekce: funkce v objektu `TYPES` v `site.js`, volba v `addSection()` v `admin.js`, styly ve `style.css`. Vše, co má jít upravovat, musí být v `content.json` a vykreslené přes `text()` nebo `frame()`.
