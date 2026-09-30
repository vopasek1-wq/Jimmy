# Jimmy – AI Dashboard pro Windows

Desktopová aplikace pro Windows (Electron) s dashboardem v tmavém tématu podle návrhu 1536 × 1024 px.
Okno je bez systémového rámečku – titulní lišta z návrhu funguje jako skutečná: tažení okna,
dvojklik pro maximalizaci, tlačítka minimalizovat / maximalizovat / zavřít.

<img src="docs/preview-desktop.png" alt="Náhled aplikace" width="100%">

## Stažení a instalace

**Stažení:** [github.com/vopasek1-wq/Jimmy/releases/latest](https://github.com/vopasek1-wq/Jimmy/releases/latest)
(soubory jsou také v GitHub Actions → workflow **Windows build** → artefakt `AI-Dashboard-Windows`):

| Soubor | Použití |
| --- | --- |
| `AI-Dashboard-Setup-1.0.0.exe` | Instalátor (zástupce na ploše a v nabídce Start) |
| `AI-Dashboard-1.0.0-portable.exe` | Přenosná verze – jeden soubor, bez instalace |
| `AI-Dashboard-1.0.0-win-x64.zip` | Rozbalit a spustit `AI Dashboard.exe` |

Aplikace není digitálně podepsaná, takže Windows SmartScreen může při prvním spuštění zobrazit
varování → **Další informace** → **Přesto spustit**.

## Co funguje „naostro“

- **Ovládání okna** z vlastní titulní lišty (minimalizace, maximalizace/obnovení, zavření).
- **Novinky** se načítají živě z RSS webů Seznam Zprávy, Novinky.cz a iDNES.cz (každých 15 minut
  nebo tlačítkem obnovit). Zdroje se střídají a stejná událost z více webů se zobrazí jen jednou
  (porovnání klíčových slov titulku a perexu). Kliknutí otevře článek v prohlížeči.
- **Úkoly – týdenní kalendář:** vpravo dny v týdnu (šipkami se přepíná týden, klik na datum vrátí
  na dnešek), vlevo úkoly vybraného dne s možností přidat (i s časem), odškrtnout a smazat.
  Dnešní nesplněné úkoly se ukazují v kartě s hodinami.
- **Ukládání:** úkoly zůstávají i po restartu aplikace.
- Vyhledávání a odkazy se otevírají ve výchozím prohlížeči; ikony a písmo jsou přibalené.
- Počasí, herní přehled a odpovědi AI asistenta jsou zatím ukázková data.

## Vývoj

```bash
npm install
npm start            # spustí aplikaci
npm run dist         # sestaví instalátor, portable .exe a zip do složky dist/ (na Windows)
npm run dist:zip     # jen zip – jde sestavit i na Linuxu/macOS
```

| Soubor | Obsah |
| --- | --- |
| `main.js` | Hlavní proces Electronu: okno bez rámečku, načítání zpráv |
| `news.js` | Stažení a zpracování RSS, odstranění duplicitních témat |
| `preload.js` | Bezpečný most mezi stránkou a hlavním procesem (`window.desktop`) |
| `index.html` | Markup dashboardu |
| `styles.css` | Design tokeny (`:root`), layout, komponenty, stavy hover/active/focus |
| `script.js` | Hodiny, novinky, týdenní kalendář úkolů, chat, ovládání okna |
| `assets/img/` | Náhradní (placeholder) SVG obrázky |
| `vendor/` | Lokální kopie ikon Lucide a písma Roboto |
| `build/icon.png` | Ikona aplikace |

## Layout

- **Shell:** CSS Grid `sidebar | obsah`, horní lišta je `sticky`.
- **Střed:** Počasí | Hodiny, Novinky | Úkoly (týdenní kalendář), Herní přehled přes celou šířku.
- **Vpravo:** AI asistent na celou výšku okna.
- **Container queries** přizpůsobují vnitřek karet jejich šířce (předpověď počasí pod teplotu,
  herní karty ve vodorovném posuvníku).

| Šířka okna | Chování |
| --- | --- |
| ≥ 1440 px | Rozložení 1 : 1 podle návrhu (výchozí velikost okna) |
| 1280–1439 px | Střed ve 2 sloupcích |
| 1100–1279 px | Sidebar se zúží na lištu s ikonami |
| 1024–1099 px | Pravý panel se přesune pod obsah (minimální šířka okna je 1024 px) |

## Úpravy vzhledu

Barvy, rádiusy, stíny a rozměry jsou v CSS proměnných na začátku `styles.css`
(`--bg`, `--card`, `--accent`, `--green`, `--sidebar-w`, `--rightbar-w` …).

Všechna tlačítka, checkboxy, dny kalendáře a textová pole mají odlišené
stavy `:hover`, `:active` a `:focus-visible`; animace respektují `prefers-reduced-motion`.

## Poznámky

- Obrázky v `assets/img/` (hory, hry) jsou jen zástupné ilustrace – nahraďte je skutečnými.
- Hodiny ve widgetu ukazují aktuální čas a datum (česky).
- Dva překlepy z návrhu jsou opravené: „Herni přehled“ → „Herní přehled“,
  „Které hry dneska hrajú?“ → „Které hry dneska hrají?“.
