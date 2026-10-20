# Fotbalové tipy

Desktopová aplikace pro Windows (**Electron, `.exe` bez instalace**), která po spuštění sama stáhne fotbalové tipy,
vyfiltruje je podle kvality a ukáže je v přehledné tabulce. Zaměřuje se na top evropské ligy a poháry UEFA
a jako cílovou sázkovou kancelář počítá s **Tipsportem**. Vzhled a ovládání jsou ve stejném systému jako
**J.I.M.M.Y.** (tmavé téma, okno bez rámečku, levé menu, karty, „Upravit rozložení“).

| Zdroj | K čemu slouží | Jak se čte |
|---|---|---|
| [Scores24](https://scores24.live/en) | tipy, míra shody (%) a kurzy | HTTP; sbalené ligy se rozbalí ve skrytém okně aplikace |
| [Forebet](https://www.forebet.com/) | statistické pravděpodobnosti 1 / X / 2 a gólů (Over/Under, oba týmy skórují) | HTTP, jinak okno aplikace (je za Cloudflare) |
| [SofaScore](https://www.sofascore.com/cs) | přesný začátek, stav, skóre, výsledky | veřejný JSON endpoint webu |

Aplikace žije ve složce [`desktop/`](desktop). Původní verze v Pythonu (Tkinter) zůstává v kořeni repozitáře
– viz [Starší verze](#starší-verze-python--tkinter).

## Stažení a spuštění (Windows)

`.exe` se sestavuje na GitHubu (Actions → **Fotbalové tipy – Windows build**) a po každém sestavení se nahraje do
vydání **`tipy-latest`**:

> `https://github.com/vopasek1-wq/Jimmy/releases/download/tipy-latest/FotbalTipy.exe`

1. Stáhněte `FotbalTipy.exe` a dvakrát na něj klikněte. Nic se neinstaluje.
2. Pokud Windows SmartScreen zobrazí varování (aplikace není podepsaná): **Další informace → Přesto spustit**.
3. Okno se otevře hned s posledními uloženými daty a tipy se na pozadí stáhnou (obvykle 20–40 s). Když jsou
   uložená data mladší než 15 minut, znovu se nestahuje.

Data (databáze `tipy.sqlite3`, nastavení okna) jsou ve `%APPDATA%\FotbalTipy`; vydání se nijak neváže na složku
s `.exe`. Pro zkoušení lze složku přesměrovat proměnnou prostředí `TIPSTER_DATA_DIR`.

> Vydání `tipy-latest` není označené jako „Latest“, takže nepřebije odkaz `/releases/latest/download/JIMMY.exe`.
> Workflow aplikace J.I.M.M.Y. ale uchovává jen 5 nejnovějších vydání **všech** druhů – po pěti jejích dalších
> sestaveních může vydání `tipy-latest` zmizet. Stačí pak spustit *Actions → Fotbalové tipy – Windows build →
> Run workflow*.

## Ovládání

Záložky pod vyhledáváním: **Přehled** (tabulka tipů, detail a úspěšnost; rozložení lze upravit), **Živé zápasy** (právě hrané zápasy ze SofaScore; po kliknutí momentum zápasu, branky a karty a statistiky; obnovuje se každých 30 s) a **Historie**. V levém sloupci jsou **soutěže** s počty zápasů – klik na soutěž filtruje tabulku tipů, živé zápasy i historii (hvězdička = všechny). Stav zdrojů se ukazuje jen v pruhu nahoře, když nějaký selže.

* **Dnes / Zítra** – přepínač dne hned za nadpisem „Tipy po filtraci“ (volba se pamatuje).
* Kliknutí na záhlaví sloupce řadí (pravděpodobnost, kurz, čas, …); hledání v horní liště (**Ctrl + K**) filtruje
  podle týmu, soutěže nebo tipu.
* Řádek vybereš kliknutím nebo šipkami ↑ ↓; **dvojklik / Enter** otevře zápas na Scores24.
* Karta **Detail tipu**: pravděpodobnost, kurz, Forebet, zdroje a odkazy na zápas na Scores24 a SofaScore.
* **Obnovit tipy** stáhne data znovu. **Upravit rozložení** umožní přetahovat a měnit velikost karet na Přehledu
  i přesouvat záložky (*Hotovo* nebo Esc to ukončí, *Výchozí rozložení* vrátí původní stav).

## Co aplikace zobrazí

Tip se objeví, **jen když platí všechno** z následujícího (konstanty jsou v `desktop/src/config.js`):

* soutěž je mezi sledovanými – Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Liga mistrů,
  Evropská liga, Konferenční liga, Eredivisie, Liga Portugal, belgická Pro League, Süper Lig,
  skotská Premiership a česká 1. liga (seznam upravíte v `LEAGUES`),
* pravděpodobnost je **striktně větší než 60 %**,
* kurz je **alespoň 1,50**.

Řádek je **zelený** při pravděpodobnosti nad 75 %, **žlutý** v pásmu 60–75 %. Živé zápasy mají modrou tečku,
skončené jsou ztlumené.

### Jak číst pravděpodobnost (důležité)

* **„Pravděp.“** je údaj ze Scores24 – míra shody jejich tipu, **ne kalibrovaná pravděpodobnost** výsledku.
  U tipovaných zápasů bývá velmi vysoká, proto je většina řádků zelená. Scores24 občas ukáže i hodnotu nad 100
  (naměřeno 101) – v aplikaci se omezí na 100 %.
* **Sloupec „Forebet“** je statistický model. Pro 1 / X / 2 a dvojitou šanci (1X, X2, 12) se bere z přehledu
  Forebetu; pro **Over/Under a oba týmy skórují** aplikace otevře stránku zápasu na Forebetu (až 25 stránek za běh)
  a přečte z ní pravděpodobnosti gólů. Týmové totaly a handicapy Forebet nehodnotí (v tabulce „n/a“).
  
* Když Forebet doporučí výsledek s pravděpodobností nad 60 %, který Scores24 nemá, přidá se jako samostatný
  tip se zdrojem „Forebet“.

### Sloupec Value

**Value** = odhadovaná pravděpodobnost (Scores24, popř. Forebet) minus pravděpodobnost odvozená z kurzu (1 / kurz),
v procentních bodech; kladné je zeleně, záporné červeně. U odhadnutého kurzu (`~`) se neukazuje (je z pravděpodobnosti
dopočítaný, rozdíl by nic neříkal). Protože „Pravděp.“ ze Scores24 není kalibrovaná pravděpodobnost, jde o orientační
ukazatel, ne záruku výhodné sázky.

### Kurzy a Tipsport

Tipsport nemá veřejné API, a proto aplikace jeho kurzy **nestahuje**. Kurz v tabulce je orientační
(Scores24, resp. Forebet) a **vždy ho ověřte přímo u Tipsportu**. Když zdroj kurz neuvede, odhadne se
z pravděpodobnosti (férový kurz zmenšený o marži 6 %) a v tabulce je označen vlnovkou, např. `~1,52`.

## Historie a statistiky

Každý nalezený tip se ukládá do SQLite. Stránka **Historie** ukazuje uložené tipy za **dnes**, vybraný **den** (kalendář) nebo **tento měsíc**,
včetně sloupce **Výsledek**: ručně ho zadáte (*Výhra / Prohra / Vráceno* u vybraného řádku), nebo ho podle
SofaScore doplní **Vyhodnotit automaticky**. Automaticky se vyhodnocují běžné trhy (1X2, dvojitá šance, Over/Under,
oba týmy skórují, týmové totaly, celočíselné handicapy); čtvrtinové linie a neznámé trhy zůstávají ručně.
Ručně zadaný výsledek se nikdy nepřepíše. Zisk a ROI se počítají při vkladu 1 na tip, jen z tipů se skutečným
(ne odhadnutým) kurzem.

## Bez internetu a při výpadku zdroje

* Po startu se hned ukážou poslední uložená data (v horní liště je štítek „z mezipaměti“).
* Bez internetu nebo při selhání Scores24 zůstanou na obrazovce poslední uložená data a nahoře se objeví pruh
  s důvodem. Selhání Forebetu nebo SofaScore nic nerozbije – tip se zobrazí i bez nich. Selhání se ukáže v pruhu nahoře.
* Požadavky mají pauzy mezi dotazy na stejný server, opakování při chybě a rozpoznání ochrany proti robotům.

## Forebet a Cloudflare

Forebet je chráněný Cloudflare. Aplikace nejdřív zkusí obyčejný dotaz, pak skryté okno. Když kontrola nepřejde,
objeví se pruh s tlačítkem **Ověřit Forebet**: otevře se okno, ve kterém kontrolu dokončíte (až 90 s), a aplikace
si ověření pamatuje.

> **Poctivě k Forebetu:** Cloudflare při vývoji nepustil Forebet ani skutečný prohlížeč z datacentrové IP.
> Seznam zápasů (1 / X / 2) se u uživatele na běžném domácím internetu načetl (130 zápasů), ale **čtení
> pravděpodobností gólů ze stránky zápasu nebylo ověřeno na živé stránce** – hledá se podle viditelného textu
> („Over 2.5 … 55 %“, „Both teams to score … Yes … No …“), ne podle tříd. Když na stránce zápasu nic takového
> nenajde, ukáže se nahoře upozornění a první stažená stránka se uloží do `%APPDATA%\FotbalTipy\ladeni\forebet-zapas.html`
> – s ní jde parser opravit (`parseGoals` v `desktop/src/scrapers/forebet.js`).

## Vývoj

Potřebujete Node.js 22+ (aplikace používá vestavěné `node:sqlite` z Electronu).

```bat
cd desktop
npm install
npm start          :: spustí aplikaci
npm test           :: 82 testů (parsery, filtry, databáze, pipeline, HTTP)
npm run dist       :: portable .exe do desktop\dist (na Windows)
```

`npm run dist` sestaví Windows `.exe`; na jiném systému to nejde bez Wine, proto ho sestavuje GitHub Actions
(`.github/workflows/tipy-windows.yml`: testy → sestavení → zkušební spuštění → vydání `tipy-latest`).

```
desktop/
  main.js, preload.js     hlavní proces Electronu (okno bez rámečku, IPC) a bezpečný most do okna
  src/
    config.js             prahy filtrů, seznam lig, adresy zdrojů
    markets.js, odds.js,  typy tipů a vyhodnocení výsledku, převod kurzů, párování názvů týmů
    names.js, filters.js, models.js, timeutil.js
    http.js, browser.js   HTTP klient (pauzy, opakování, detekce blokace) a skryté okno místo Selenia
    scrapers/             scores24.js, forebet.js, sofascore.js
    pipeline.js           sloučení zdrojů → filtry → obohacení; automatické vyhodnocení výsledků
    database.js           SQLite: běhy, tipy, historie, statistiky
    service.js            propojení všeho pro okno
  renderer/               rozhraní (index.html, styles.css, script.js, vendor/ = GridStack, Lucide, Roboto)
  test/                   node:test + ukázkové stránky ve struktuře živých webů
```

## Starší verze (Python + Tkinter)

Původní verze (stejné zdroje a pravidla, vlastní okno v Tkinteru) zůstává v kořeni: `main.py`, složka `tipster/`,
`run.bat`, testy v `tests/` (pytest). Potřebuje Python 3.10+ a pro Forebet / rozbalení lig Chrome nebo Edge
(Selenium). Spouští se `run.bat`, nebo ručně:

```bat
py -3 -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python main.py
```

Konzolový režim: `python main.py --cli` (volitelně `--save`, `-v`). Data jsou v `data\tipy.sqlite3` (jiná databáze
než u Electron verze).

## Řešení potíží

| Příznak | Co zkusit |
|---|---|
| Okno se otevře, ale tabulka je prázdná | Podívejte se na pruh nahoře a na stav zdrojů; filtr *Dnes* ukazuje jen dnešní zápasy – zkuste *Dnes a zítra* nebo *Vše*. |
| „Forebet: Cloudflare kontrola neprošla“ | Klikněte na **Ověřit Forebet**, nebo Forebet nechte být. |
| „Forebet: … pravděpodobnosti gólů“ nahoře | Struktura stránky zápasu se liší od předpokladu – pošlete soubor `ladeni\forebet-zapas.html` (viz výše). |
| Windows SmartScreen aplikaci blokuje | *Další informace → Přesto spustit* (aplikace není podepsaná). |
| Zápasy mají posunutý čas | Časy se převádějí z UTC do `Europe/Prague`; zkontrolujte systémové datum a čas. |
| „Struktura webu se změnila“ | Weby se mění; parsery jsou v `desktop/src/scrapers/`, testy ukazují očekávaný tvar dat. |

## Upozornění

* Aplikace čte veřejně dostupné stránky zdrojů. Dodržujte jejich podmínky použití a nezvyšujte četnost dotazů
  (aplikace úmyslně dělá pauzy). Zdroje změní strukturu stránek bez varování, takže scrapery může být nutné opravit.
* Tipy nejsou záruka výhry. Sázení je určeno osobám starším 18 let a může vést k závislosti – sázejte jen to,
  o co si můžete dovolit přijít. Pomoc: Národní linka pro odvykání 800 350 000 (všední dny 10–18).
* Electron verze byla vyvíjena a testována na Linuxu (Xvfb) proti živým webům Scores24 a SofaScore; `.exe` se
  sestavuje až v GitHub Actions a přímo ve Windows tu vyzkoušeno nebylo.
