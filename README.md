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
- **Rychlé akce:** Otevřít web (výchozí prohlížeč), Otevřít složku (Dokumenty),
  Spustit aplikaci (výběr .exe/.lnk), Uložit poznámku.
- **Ukládání:** úkoly, rychlé poznámky a stav přepínačů automatizací zůstávají i po restartu.
- Vyhledávání a odkazy se otevírají ve výchozím prohlížeči; ikony a písmo jsou přibalené, aplikace funguje offline.
- Počasí, novinky, herní přehled a odpovědi AI asistenta jsou zatím ukázková data.

## Vývoj

```bash
npm install
npm start            # spustí aplikaci
npm run dist         # sestaví instalátor, portable .exe a zip do složky dist/ (na Windows)
npm run dist:zip     # jen zip – jde sestavit i na Linuxu/macOS
```

| Soubor | Obsah |
| --- | --- |
| `main.js` | Hlavní proces Electronu: okno bez rámečku, rychlé akce |
| `preload.js` | Bezpečný most mezi stránkou a hlavním procesem (`window.desktop`) |
| `index.html` | Markup dashboardu |
| `styles.css` | Design tokeny (`:root`), layout, komponenty, stavy hover/active/focus |
| `script.js` | Hodiny, úkoly, poznámky, chat, filtr novinek, napojení na desktop API |
| `assets/img/` | Náhradní (placeholder) SVG obrázky |
| `vendor/` | Lokální kopie ikon Lucide a písma Roboto |
| `build/icon.png` | Ikona aplikace |

## Layout

- **Shell:** CSS Grid `sidebar | obsah`, horní lišta je `sticky`.
- **Střed:** mřížka o 4 stopách (`416fr 100fr 32fr 374fr`) s pojmenovanými oblastmi, která věrně
  skládá „posunuté“ řádky z návrhu (Novinky přesahují pod Úkoly, Automatizace začíná nad Herním přehledem).
- **Container queries** přizpůsobují vnitřek karet jejich šířce (předpověď počasí pod teplotu,
  poznámky pod seznam úkolů, herní karty ve vodorovném posuvníku).

| Šířka okna | Chování |
| --- | --- |
| ≥ 1440 px | Rozložení 1 : 1 podle návrhu (výchozí velikost okna) |
| 1280–1439 px | Střed ve 2 sloupcích |
| 1100–1279 px | Sidebar se zúží na lištu s ikonami |
| 1024–1099 px | Pravý panel se přesune pod obsah (minimální šířka okna je 1024 px) |

## Úpravy vzhledu

Barvy, rádiusy, stíny a rozměry jsou v CSS proměnných na začátku `styles.css`
(`--bg`, `--card`, `--accent`, `--green`, `--sidebar-w`, `--rightbar-w` …).

Všechna tlačítka, checkboxy, přepínače, záložky, výběr zdroje novinek a textová pole mají odlišené
stavy `:hover`, `:active` a `:focus-visible`; animace respektují `prefers-reduced-motion`.

## Poznámky

- Obrázky v `assets/img/` jsou jen zástupné ilustrace – nahraďte je skutečnými (stejné poměry stran).
- Hodiny ve widgetu ukazují aktuální čas a datum (česky).
- Dva překlepy z návrhu jsou opravené: „Herni přehled“ → „Herní přehled“,
  „Které hry dneska hrajú?“ → „Které hry dneska hrají?“.
