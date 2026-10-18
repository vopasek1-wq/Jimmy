# Fotbalové tipy

Desktopová aplikace pro Windows (Python + Tkinter), která po spuštění sama stáhne fotbalové tipy,
vyfiltruje je podle kvality a ukáže je v přehledné tabulce. Zaměřuje se na top evropské ligy
a poháry UEFA a jako cílovou sázkovou kancelář počítá s **Tipsportem**.

| Zdroj | K čemu slouží | Jak se čte |
|---|---|---|
| [Scores24](https://scores24.live/en) | tipy, míra shody (%) a kurzy | HTTP; sbalené ligy se rozbalí v prohlížeči (Selenium) |
| [Forebet](https://www.forebet.com/) | statistické pravděpodobnosti 1 / X / 2 | HTTP, jinak Selenium (je za Cloudflare) |
| [SofaScore](https://www.sofascore.com/cs) | přesný začátek, stav, skóre, výsledky | veřejný JSON endpoint webu |

## Spuštění (Windows)

1. Nainstalujte **Python 3.10 nebo novější** z <https://www.python.org/downloads/>
   (při instalaci zaškrtněte *Add python.exe to PATH*).
2. Dvakrát klikněte na **`run.bat`**. Při prvním spuštění si sám vytvoří složku `.venv`
   a nainstaluje balíčky z `requirements.txt` (potřebuje internet, trvá to chvíli).
3. Okno se otevře hned a tipy se stáhnou automaticky na pozadí (obvykle 10–40 s).

Ruční postup, pokud nechcete `run.bat`:

```bat
py -3 -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python main.py
```

Pro ladění existuje i konzolový režim bez okna: `python main.py --cli` (volitelně `--save` uloží výsledek
do databáze a `-v` zapne podrobný log).

## Vzhled

Okno používá stejný design systém jako **Value Bet Kalkulačka**: stejné barevné tokeny (teal akcent, okrový signál,
zelená / červená / žlutá „soft“ pozadí), nadpisy v písmu Palatino, text v Segoe UI, čísla v Cascadia Mono / Consolas,
hranaté rohy, dvoupixelová linka pod hlavičkou a sekce s akcentní horní linkou a písmenem. Rozvržení kopíruje kalkulačku:
hlavička s kickerem, nadpisem a perexem, pás ukazatelů (počet tipů, nad 75 %, průměrný kurz, nejbližší zápas
a rozložení), vlevo sekce **A** s tabulkou a vpravo karty *Detail tipu* a *Zdroje dat*.

**Světlý i tmavý režim**: tlačítko v pravém horním rohu je přepíná, volba se pamatuje (`data/settings.json`).
Při prvním spuštění se ve Windows použije režim systému. Kdyby některé písmo ve vašem systému chybělo, použije se
náhradní (pořadí je v `tipster/theme.py`). Hodnoty barev jsou tamtéž a odpovídají CSS kalkulačky.

## Co aplikace zobrazí

Tip se objeví, **jen když platí všechno** z následujícího (konstanty jsou v `tipster/config.py`):

* soutěž je mezi sledovanými – Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Liga mistrů,
  Evropská liga, Konferenční liga, Eredivisie, Liga Portugal, belgická Pro League, Süper Lig,
  skotská Premiership a česká 1. liga (seznam upravíte v `LEAGUES`, ligu vypnete `enabled=False`),
* pravděpodobnost je **striktně větší než 60 %**,
* kurz je **alespoň 1,50**.

Řádek je **zelený** při pravděpodobnosti nad 75 %, **žlutý** v pásmu 60–75 %. Živé zápasy jsou modře,
skončené šedě. Horní počítadlo ukazuje počet tipů po filtraci. Tabulku lze řadit kliknutím na záhlaví
(pravděpodobnost, kurz, soutěž, čas, …), přepínat Dnes / Zítra / Vše, skrýt už zahájené zápasy
a ručně obnovit tlačítkem *Obnovit tipy*. Dvojklik otevře zápas na Scores24, pravé tlačítko nabídne
SofaScore a „Zkopírovat zápas a otevřít Tipsport“.

Ke každému tipu: zápas, soutěž, začátek (pražský čas), typ tipu, pravděpodobnost, kurz, pravděpodobnost
z Forebetu (pokud je k dispozici), zdroj a stav zápasu.

### Jak číst pravděpodobnost (důležité)

* **„Pravděp.“** je údaj ze Scores24 – míra shody jejich tipu, **ne kalibrovaná pravděpodobnost** výsledku.
  U tipovaných zápasů bývá velmi vysoká, proto je většina řádků zelená. Scores24 občas ukáže i hodnotu nad 100
  (naměřeno 101) – v aplikaci se omezí na 100 %.
* **Sloupec „Forebet“** je statistický model. Je dostupný jen pro trhy 1 / X / 2 a dvojitou šanci (1X, X2, 12);
  pro Over/Under či oba týmy skórují Forebet hodnotu nedává. Zaškrtnutím *Jen potvrzené Forebetem (> 60 %)*
  necháte jen tipy, které model také hodnotí nad 60 %.
* Když Forebet doporučí výsledek s pravděpodobností nad 60 %, který Scores24 nemá, přidá se jako samostatný
  tip se zdrojem „Forebet“.

### Kurzy a Tipsport

Tipsport nemá veřejné API, a proto aplikace jeho kurzy **nestahuje**. Kurz v tabulce je orientační
(Scores24, resp. Forebet) a **vždy ho ověřte přímo u Tipsportu** – tlačítko *Otevřít Tipsport* a pravé tlačítko
na řádku (zkopíruje název zápasu) vám to usnadní. Když zdroj kurz neuvede, odhadne se z pravděpodobnosti
(férový kurz zmenšený o marži 6 %) a v tabulce je označen vlnovkou, např. `~1.52`.

## Historie a statistiky

Každý nalezený tip se ukládá do SQLite (`data/tipy.sqlite3`). Záložka *Historie a statistiky* ukazuje
všechny uložené tipy včetně pole **Výsledek**: výsledek zadáte ručně (Výhra / Prohra / Vráceno, tlačítko
nebo pravé tlačítko myši), nebo ho podle SofaScore doplní *Vyhodnotit automaticky*. Automaticky se vyhodnocují
běžné trhy (1X2, dvojitá šance, Over/Under, oba týmy skórují, týmové totaly, celočíselné handicapy);
čtvrtinové linie a neznámé trhy zůstávají ručně. Ručně zadaný výsledek se nikdy nepřepíše. Zisk a ROI se
počítají při vkladu 1 na tip, jen z tipů se skutečným (ne odhadnutým) kurzem.

## Bez internetu a při výpadku zdroje

* Po startu se hned ukáže poslední uložená data (v záhlaví s poznámkou „data z mezipaměti“) a až pak běží stahování.
* Bez internetu nebo při selhání Scores24 zůstanou na obrazovce poslední uložená data a nahoře se objeví žlutý
  pruh s důvodem.
* Selhání Forebetu nebo SofaScore nic nerozbije – tip se zobrazí i bez nich. Stav jednotlivých zdrojů je dole
  (✔ v pořádku, ◐ částečně, ✖ selhalo); kliknutím na něj se otevřou podrobnosti.
* Požadavky mají pauzy 0,8–1,6 s mezi dotazy na stejný server, opakování při chybě a rozpoznání ochrany proti robotům.

## Selenium a Forebet (záložní režim)

Selenium se spustí jen tam, kde samotné HTTP nestačí: pro **Forebet** (Cloudflare) a pro rozbalení **sbalených lig**
na Scores24. Potřebuje nainstalovaný **Google Chrome nebo Microsoft Edge**; vhodný ovladač si stáhne Selenium Manager
sám. Pokud prohlížeč chybí, aplikace to napíše do žlutého pruhu a ostatní zdroje dál fungují.

> **Poctivě k Forebetu:** Cloudflare při vývoji nepustil Forebet ani skutečný prohlížeč z datacentrové IP, proto
> parser Forebetu **nebyl ověřen na živých datech** – je napsán podle známé struktury stránky a otestován na
> ukázkovém HTML. Na běžném domácím internetu Cloudflare často projde. Pokud ne, zkuste nastavit proměnnou
> `TIPSTER_VISIBLE_BROWSER=1` (prohlížeč se zobrazí a kontrola obvykle projde, případně ji potvrdíte kliknutím).
> Když Forebet nepůjde ani tak, aplikace funguje dál jen se Scores24 a SofaScore. Pokud Forebet změnil strukturu
> stránky, uvidíte hlášení „změnila se struktura webu“ a oprava je v `tipster/scrapers/forebet.py`.

Pokročilé proměnné prostředí: `TIPSTER_VISIBLE_BROWSER`, `TIPSTER_CHROME_BINARY` (cesta k prohlížeči),
`TIPSTER_CHROME_ARGS` (další argumenty), `TIPSTER_DATA_DIR` (kam ukládat databázi a log).

## Struktura projektu

```
main.py                 vstupní bod (okno / --cli)
run.bat                 spuštění ve Windows (vytvoří .venv, nainstaluje balíčky)
requirements.txt        závislosti aplikace      requirements-dev.txt  + pytest
tipster/
  config.py             prahy filtrů, seznam lig, adresy zdrojů, časování
  models.py             Tip, SourceStatus, ScrapeResult
  filters.py            povinné filtry (60 % / 1,50 / ligy)
  markets.py            typy tipů: překlad ze Scores24, české popisky, vyhodnocení výsledku
  odds.py, names.py     převod kurzů (US/zlomky → desetinné), párování názvů týmů
  http.py, browser.py   HTTP klient (pauzy, opakování, detekce blokace) a Selenium
  scrapers/             scores24.py, forebet.py, sofascore.py
  pipeline.py           sloučení zdrojů → filtry → obohacení; automatické vyhodnocení výsledků
  database.py           SQLite: běhy, tipy, historie, statistiky
  ui.py, theme.py       okno (Tkinter) a vzhled: palety světlý/tmavý, písma, volba motivu
  timeutil.py           práce s časem
tests/                  pytest (parsery, filtry, databáze, pipeline, HTTP, GUI smoke test)
```

## Testy

```bat
.venv\Scripts\pip install -r requirements-dev.txt
.venv\Scripts\python -m pytest
```

Testy parserů běží na ukázkových stránkách ve struktuře živých webů. GUI test se bez displeje sám přeskočí
(na Linuxu `xvfb-run pytest`).

## Řešení potíží

| Příznak | Co zkusit |
|---|---|
| Okno se otevře, ale tabulka je prázdná | Podívejte se na žlutý pruh nahoře a na stav zdrojů dole; log je v `data\tipster.log`. |
| „Forebet: Cloudflare kontrola neprošla“ | Viz výše – `TIPSTER_VISIBLE_BROWSER=1`, nebo Forebet nechte být. |
| „Nepodařilo se spustit Chrome ani Edge“ | Nainstalujte Google Chrome; ostatní zdroje fungují i bez něj. |
| „Chybí databáze časových pásem“ | `pip install tzdata` (je v `requirements.txt`). |
| Zápasy mají posunutý čas | Časy se převádějí z UTC do `Europe/Prague`; zkontrolujte systémové datum a čas. |
| „Struktura webu se změnila“ | Weby se mění; parsery jsou v `tipster/scrapers/`, testy ukazují očekávaný tvar dat. |

## Upozornění

* Aplikace čte veřejně dostupné stránky zdrojů. Dodržujte jejich podmínky použití a nezvyšujte četnost dotazů
  (aplikace úmyslně dělá pauzy). Zdroje změní strukturu stránek bez varování, takže scrapery může být nutné opravit.
* Tipy nejsou záruka výhry. Sázení je určeno osobám starším 18 let a může vést k závislosti – sázejte jen to,
  o co si můžete dovolit přijít.
* Aplikace byla vyvíjena a testována na Linuxu (Xvfb) proti živým webům Scores24 a SofaScore. `run.bat`,
  vzhled písma a chování Selenia přímo ve Windows tu vyzkoušeny nebyly.
