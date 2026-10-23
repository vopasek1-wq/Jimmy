# Fotbalové tipy

Desktopová aplikace pro Windows (**Electron, `.exe` bez instalace**), která po spuštění sama stáhne fotbalové tipy,
vyfiltruje je podle kvality a ukáže je v přehledné tabulce. Zaměřuje se na top evropské ligy a poháry UEFA
a jako cílovou sázkovou kancelář počítá s **Tipsportem**. Vzhled a ovládání jsou ve stejném systému jako
**J.I.M.M.Y.** (tmavé téma, okno bez rámečku, levé menu, karty).

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
   uložená data mladší než 15 minut, znovu se nestahuje. Okno se vždy otevře maximalizované.
4. **Nová verze:** aplikace při startu (a pak každých 6 hodin) zjistí na GitHubu, jestli je ve vydání `tipy-latest` novější
   sestavení. Pokud ano, v horní liště se objeví štítek **Nová verze** – klik otevře stažení v prohlížeči (po stažení zavřete
   aplikaci a spusťte nový `FotbalTipy.exe`). Novou verzi lze vyhledat i hned tlačítkem **Aktualizace** vlevo dole: když je novější
   sestavení, tlačítko se změní na „Stáhnout verzi N“ a další klik otevře stažení; když ne, ukáže se, že máte nejnovější verzi
   (pod tlačítkem je číslo vašeho sestavení). Verze aplikace je `1.0.<číslo sestavení>` (workflow ho dosadí z čísla běhu).
   Zjišťuje se přes GitHub API a když to nejde (limit dotazů, blokace), přes Atom kanál vydání na github.com; při selhání obou cest
   aplikace ukáže skutečný důvod (stav HTTP, chyba spojení). U soukromého repozitáře (vydání bez přihlášení nejde přečíst, obě cesty vrátí 404) tlačítko **Aktualizace** jen otevře stránku vydání v prohlížeči, kde číslo sestavení porovnáte ručně. Automatická kontrola běží jen v zabalené aplikaci a funguje až od sestavení,
   které ji obsahuje.

Data (databáze `tipy.sqlite3`, nastavení okna) jsou ve `%APPDATA%\FotbalTipy`; vydání se nijak neváže na složku
s `.exe`. Pro zkoušení lze složku přesměrovat proměnnou prostředí `TIPSTER_DATA_DIR`.

> Vydání `tipy-latest` není označené jako „Latest“, takže nepřebije odkaz `/releases/latest/download/JIMMY.exe`.
> Workflow aplikace J.I.M.M.Y. ale uchovává jen 5 nejnovějších vydání **všech** druhů – po pěti jejích dalších
> sestaveních může vydání `tipy-latest` zmizet. Stačí pak spustit *Actions → Fotbalové tipy – Windows build →
> Run workflow*.

## Vzhled

Aplikace má „skleněný“ vzhled (verze 3): tmavé pozadí, průhledné rozmazané panely se zářivými rohy
a tlumeně modrá tlačítka bez záře. Styly jsou v `desktop/renderer/styles.css` (poslední sekce „Skleněný vzhled“, barvy v tokenech na začátku souboru).

## Ovládání

Záložky pod vyhledáváním: **Přehled** (tabulka tipů, detail a úspěšnost), **Živé zápasy** (právě hrané zápasy z Přehledu (podle SofaScore); po kliknutí momentum zápasu, branky a karty a statistiky; obnovuje se každých 30 s) a **Historie**. V levém sloupci jsou **soutěže** s počty zápasů – klik na soutěž filtruje tabulku tipů, živé zápasy i historii (hvězdička = všechny). Stav zdrojů se ukazuje jen v pruhu nahoře, když nějaký selže.

* **Dnes / Zítra** – přepínač dne hned za nadpisem „Tipy po filtraci“ (volba se pamatuje).
* Kliknutí na záhlaví sloupce řadí (pravděpodobnost, kurz, čas, …); hledání v horní liště (**Ctrl + K**) filtruje
  podle týmu, soutěže nebo tipu.
* Řádek vybereš kliknutím nebo šipkami ↑ ↓; **dvojklik / Enter** otevře zápas na Scores24.
* Karta **Detail tipu**: pravděpodobnost, kurz, Forebet, zdroje a odkazy na zápas na Scores24 a SofaScore.
* Aplikace se po spuštění vždy otevře **maximalizovaná** (přes celou pracovní plochu, hlavní panel Windows zůstává vidět).
* **Obnovit tipy** stáhne data znovu.

## Co aplikace zobrazí

Tip se objeví, **jen když platí všechno** z následujícího (konstanty jsou v `desktop/src/config.js`):

* soutěž je mezi sledovanými – Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Liga mistrů,
  Evropská liga, Konferenční liga, Eredivisie, Liga Portugal, belgická Pro League, Süper Lig,
  skotská Premiership a česká 1. liga (seznam upravíte v `LEAGUES`),
* pravděpodobnost je **striktně větší než 60 %**,
* kurz je **alespoň 1,50**.
* nejde o **ženský zápas** (týmy typu „… W“, „… Women“, „Femenina“, „Frauen“ se vyřazují; dříve uložené se při spuštění z historie smažou).

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

Každý nalezený tip se ukládá do SQLite. Stránka **Historie** ukazuje uložené tipy za **dnes**, **včera**, vybraný **den** (kalendář) nebo **tento měsíc**,
včetně sloupce **Výsledek**, který doplňuje aplikace sama podle SofaScore při každém stahování (nebo tlačítkem **Vyhodnotit automaticky**).
Vyhodnocují se běžné trhy (1X2, dvojitá šance, Over/Under, oba týmy skórují, týmové totaly, celočíselné handicapy);
čtvrtinové linie a neznámé trhy zůstávají bez výsledku. Zisk a ROI se počítají při vkladu 1 na tip, jen z tipů se skutečným
(ne odhadnutým) kurzem.

## Tikety (Gemini)

Záložka **Tikety** nechá Gemini poskládat kombinace (tikety) z tipů v Přehledu, které pak ručně zadáš do Tipsportu (ten nemá API).
Zvolíš den (Dnes / Zítra) a klikneš na **Vytvořit tikety (AI)** – počet tipů ani tiketů se nezadává, určí je Gemini. Postup:

1. **Statistiky ze SofaScore.** Z tipů v Přehledu se vezmou ty, které ještě nezačaly a mají **skutečný** kurz (ne odhadnutý; nejvýš 20 nejlepších
   podle pravděpodobnosti a Value). Ke každému zápasu aplikace sama stáhne ze SofaScore formu obou týmů (posledních 5 zápasů), vzájemné zápasy
   (H2H), střeleckou produktivitu (góly na zápas), domácí výkonnost domácího a venkovní výkonnost hostujícího týmu a zranění/absence hráčů.
   Zápas, ke kterému statistiky nejdou stáhnout (např. nemá SofaScore ID), se do tiketů nedostane. Průběh a uplynulý čas jsou vidět v okně
   (celé to trvá obvykle do dvou minut). Podrobnosti o tom, co se stáhlo, jsou v souboru `ladeni\tikety-statistiky.txt` ve složce dat aplikace.
2. **Gemini vybírá.** Jediný dotaz do Gemini dostane tipy se statistikami. U každého zápasu posoudí, jak statistiky podporují právě daný tip
   (silná / střední / slabá / nedostatečná data). Do tiketů zařadí zápasy se silnou a střední oporou, slabé a bez dat vynechá a zařazené
   rozdělí tak, že nejjistější tipy jsou pohromadě (první tiket je nejjistější). Tipy samotné **neupravuje** (nemění typ sázky ani kurz),
   jen je hodnotí. Pod tikety je rozbalovací seznam **Nezařazeno do tiketů – proč?**: u každého zápasu, který v tiketu není, je důvod
   (od Gemini, nebo že se k němu statistiky nepodařilo stáhnout / tiket byl zahozen pro porušení pravidel). Poslední zadání a odpověď
   Gemini jsou v souboru `ladeni\tikety-odpoved.txt`.

Pravidla, která aplikace u odpovědi **kontroluje** (tiket, který je porušuje, zahodí): 2–5 zápasů na tiket, kombinovaný kurz alespoň 2,00,
každý zápas nejvýš v jednom tiketu a žádné neznámé tipy. **Pod každým tipem v tiketu** je jeho vlastní krátké zdůvodnění (1–2 věty, forma týmů, H2H, góly, zranění), u tiketu jednověté shrnutí
a úroveň jistoty; **celkový kurz, pravděpodobnost (součin) a odhad výnosu počítá aplikace sama**. Používá se stejný Gemini klíč
jako v Analýze; poslední tikety zůstanou po restartu.

**Uložené tikety a jejich výsledky.** Každý vytvořený tiket se uloží (stejná sada tipů ve stejný den jen jednou). Pod aktuálními tikety je
seznam **Dřívější tikety** s výsledkem: tiket je *vyhraný*, když vyjdou všechny jeho tipy, *prohraný* hned po první prohře, vrácený tip se
z kurzu vyjme. Výsledky tipů se berou z automatického vyhodnocení. V **Analýze** je srovnání „tikety od Gemini × všechny tipy jednotlivě“
(odhad = součin pravděpodobností, úspěšnost, rozdíl, ROI při vkladu 1). Patnáct minut před začátkem zápasu z čekajícího tiketu přijde
systémové oznámení (jednou na zápas). V **Historii** exportuje tlačítko *Exportovat (CSV)* celou historii tipů do souboru pro Excel.

Statistiky se záměrně nehledají přes „vyhledávání na webu“ v Gemini API (Grounding with Google Search) – to u **bezplatného klíče** u novějších
modelů není k dispozici. Gemini proto dostane jen běžný textový dotaz, který zdarma funguje. Když Google dotaz odmítne, aplikace ukáže skutečný
důvod (vyčerpaný denní/minutový limit, model bez limitu na bezplatném klíči, přetížení) včetně původní hlášky Googlu.

> Pravděpodobnost tiketu je součin odhadů zdroje, které nejsou kalibrované, takže bývá optimistická; kurzy u Tipsportu se mohou lišit
> a výnos není zaručen. Sázení je jen pro osoby starší 18 let.

## Analýza úspěšnosti

Záložka **Analýza** porovnává odhadnutou pravděpodobnost tipů se skutečnými výsledky (počítají se jen výhry a prohry, ne vrácené
sázky): úspěšnost po pásmech 60–70 / 70–80 / 80–90 / 90–100 %, podle typu tipu a podle soutěže, včetně rozdílu v procentních bodech
a ROI. Pod tabulkami jsou textová **zjištění** (např. „tipy s pravděpodobností 80–90 % vycházejí jen v 50 % případů“); u malého
počtu tipů (pod 30) aplikace upozorní, že závěry jsou orientační.

Panel **Bankroll** ukazuje, kolik bys měl, kdybys od zadané počáteční částky sázel **stálý vklad** na každý vyhodnocený tip
(nebo tiket od Gemini): bankroll nyní, zisk, ROI z vsazeného, největší propad, nejdelší série proher a graf vývoje v čase. Počítají se
jen sázky se skutečným kurzem, vrácené se přeskakují. Nastavení (počáteční bankroll, vklad na tip a na tiket) se pamatuje. V detailu
tipu je navíc **Doporučený vklad**: čtvrtinový Kellyho vklad z bankrollu „nyní“, nejvýš 5 % bankrollu; když kurz nemá oproti odhadu
pravděpodobnosti výhodu, napíše „žádný“. Pravděpodobnost je jen odhad zdroje, proto jde o orientační pomůcku, ne o jistotu.

Tlačítko **Analyzovat pomocí AI** pošle souhrnné statistiky a posledních 40 prohraných tipů do **Google Gemini API** **tvým vlastním
klíčem** a zobrazí rozbor kalibrace, opakujících se chyb a doporučení. Klíč si vytvoříš zdarma v Google AI Studio
(aistudio.google.com → *Get API key*), v aplikaci ho zadáš pod tlačítkem „Gemini API klíč“. Ukládá se šifrovaně (Windows DPAPI) a nikam
jinam se neposílá. Zda je volání zpoplatněné, závisí na tarifu tvého Google účtu (Gemini API má bezplatný limit, jeho výši určuje Google);
bez klíče AI část nefunguje, statistiky ano.

## Co se stahuje a co ne

Aplikace stahuje jen to, co potřebuje, aby bylo obnovení rychlé a zdroje nezatěžovala:

* Stránky zápasů na Forebetu (pravděpodobnosti gólů) se otevírají jen u tipů, které by prošly filtry (nad 60 %, kurz od 1,50, sledovaná
  soutěž, mužský zápas, ještě nezačal). Už stažené hodnoty se 4 hodiny berou z mezipaměti (`forebet-goals.json`), takže další obnovení
  je u nich okamžité.
* Z Forebetu se načítají jen stránky lig, které Scores24 právě nabízí. Okno prohlížeče se otevírá jen tehdy, když obyčejné HTTP nestačí.
* Statistiky pro tikety (SofaScore) se po dobu 30 minut pamatují, takže opakované vytvoření tiketů nestahuje nic nového.
* Živé skóre se každou minutu aktualizuje jen tehdy, když nějaký tip právě hraje; výsledky se dotahují jen u tipů, které na ně čekají.
* `ladeni/zdroje-diagnostika.txt` obsahuje řádek **Doba kroků** (Scores24 / Forebet / SofaScore), podle něj je vidět, co obnovení zdržuje.

## Bez internetu a při výpadku zdroje

* Po startu se hned ukážou poslední uložená data (v horní liště je štítek „z mezipaměti“).
* Bez internetu nebo při selhání Scores24 zůstanou na obrazovce poslední uložená data a nahoře se objeví pruh
  s důvodem. Selhání Forebetu nebo SofaScore nic nerozbije – tip se zobrazí i bez nich. Selhání se ukáže v pruhu nahoře.
* Požadavky mají pauzy mezi dotazy na stejný server, opakování při chybě a rozpoznání ochrany proti robotům.

## Forebet a Cloudflare

Forebet je chráněný Cloudflare. Aplikace nejdřív zkusí obyčejný dotaz, pak skryté okno. Přehled „dnes“
(`football-tips-and-predictions-for-today`) obsahuje jen malou část zápasů a žádnou ze sledovaných lig, proto z jeho nabídky
aplikace vezme odkazy na stránky lig (`…-for-england/premier-league` apod.) a načte přímo stránky těch sledovaných lig, které
právě nabízí Scores24 (když odkaz v nabídce není, zkusí odhad adresy). Zbylé stránky lig se při ověření Cloudflare projdou v jednom
skrytém okně. Starý přehled `/football-predictions` (jen první země podle abecedy) je až záloha. Když kontrola nepřejde,
objeví se pruh s tlačítkem **Ověřit Forebet**: otevře se okno, ve kterém kontrolu dokončíte (až 90 s), a aplikace
si ověření pamatuje.

> **Poctivě k Forebetu:** Cloudflare při vývoji nepustil Forebet ani skutečný prohlížeč z datacentrové IP.
> Seznam zápasů (1 / X / 2) se u uživatele na běžném domácím internetu načetl (130 zápasů), ale **čtení
> pravděpodobností gólů ze stránky zápasu nebylo ověřeno na živé stránce** – hledá se podle viditelného textu
> („Over 2.5 … 55 %“, „Both teams to score … Yes … No …“), ne podle tříd. Když na stránce zápasu nic takového
> nenajde, ukáže se nahoře upozornění a první stažená stránka se uloží do `%APPDATA%\FotbalTipy\ladeni\forebet-zapas.html`
> – s ní jde parser opravit (`parseGoals` v `desktop/src/scrapers/forebet.js`).

### Diagnostika pro vývojáře

Když něco nefunguje (Forebet, statistiky pro tikety, …), stiskněte v aplikaci **Ctrl + Shift + D**: do schránky se zkopíruje
textový souhrn (verze, stav zdrojů posledního stahování, kolik tipů se spárovalo s Forebetem a které ne a proč, pokrytí SofaScore,
obsah ladicích souborů) a uloží se i do `%APPDATA%\FotbalTipy\ladeni\diagnostika.txt`. Stačí ho vložit do zprávy. Neobsahuje
API klíč ani nic osobního. Ladicí soubory ve složce `ladeni` se přepisují při každém stahování:

| Soubor | Co v něm je |
|---|---|
| `zdroje-diagnostika.txt` | stav zdrojů, párování tipů s Forebetem (časový rozsah, nespárované tipy s nejbližším zápasem), pokrytí SofaScore |
| `forebet-seznam-diagnostika.txt`, `forebet-seznam.html` | přehled načtených stránek Forebetu (přehled „dnes“ a stránky lig: odkud, kolik zápasů, nabídka lig a ukázka řádku); celé HTML jen když přehled „dnes“ nevrátil žádný zápas |
| `forebet-diagnostika.txt`, `forebet-zapas.html` | jen když se nepodaří přečíst pravděpodobnosti gólů ze stránky zápasu |
| `tikety-statistiky.txt` | co se stáhlo ze SofaScore pro tikety (po zápasech) a ukázky odpovědí |
| `tikety-odpoved.txt` | poslední zadání a odpověď Gemini pro tikety |

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
| „Forebet: … pravděpodobnosti gólů“ nahoře | Struktura stránky zápasu se liší od předpokladu – stiskněte **Ctrl + Shift + D** a pošlete diagnostiku (případně soubor `ladeni\forebet-zapas.html`). |
| Forebet se u většiny tipů nezobrazuje | Stiskněte **Ctrl + Shift + D**: v `zdroje-diagnostika.txt` je vidět, kolik tipů se s Forebetem spárovalo a u nespárovaných nejbližší zápas (rozdílné jméno týmu, čas nebo liga). |
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
