# Mobilo – web o pojízdném lešení

Informační web v češtině o systému pojízdného lešení **Mobilo** od výrobce Scafom-Rux.
Je určený kutilům a domácím uživatelům: vysvětluje jednoduše, bez zbytečného žargonu.

Čistý HTML, CSS a JavaScript. Žádný build ani server – stačí otevřít `index.html` v prohlížeči.

```
index.html              verze 1 – vlastní ilustrace (bez cizích obrázků)
index-foto.html         verze 2 – fotografie a vizualizace ze zdrojů (hero, karty dílů, galerie)
assets/css/style.css    veškeré styly obou verzí (barvy a rozměry jsou v proměnných na začátku souboru)
assets/js/main.js       navigace, filtr komponent, galerie, konfigurátor, ilustrace lešení
assets/img/             fotografie a vizualizace pro verzi 2 (WebP, celkem asi 0,5 MB)
```

Obě verze mají stejný obsah, liší se jen obrázky. Verze 2 (`index-foto.html`) je odvozená z verze 1:
změny textu dělejte v obou souborech.

## Sekce webu

1. **Hero** – nadpis, podnadpis, dvě výzvy k akci
2. **Výhody** – bezpečnost, snadná montáž, univerzálnost + srovnání šířek 800 a 1400
3. **Přehled komponentů** – 23 karet v 6 kategoriích s filtrem
4. **Montáž** – pět kroků, barevné značení dílů, pravidla bezpečné práce
5. **Technické specifikace** – dlaždice s hodnotami, srovnávací tabulka, konfigurátor sestavy
6. **Galerie** – 9 ilustrací s lightboxem (klávesnice: ← → Esc)
7. **Ke stažení** – odkaz na oficiální PDF katalog
8. **Časté dotazy** a **patička** se zdroji

## Jak web upravit

- **Barvy, písmo, rozměry:** proměnné v `:root` na začátku `style.css`.
- **Nová komponenta:** zkopírujte libovolný `<article class="part">` v `index.html` a upravte text. Atribut `data-cat` určuje kategorii (`frames`, `decks`, `base`, `guards`, `links`, `extras`). Počty u filtrů se dopočítají samy.
- **Fotografie místo ilustrace:** v kartě galerie nahraďte `<svg>` uvnitř `.shot__media` za `<img src="assets/img/…" alt="…" loading="lazy">`. Lightbox i vzhled karty fungují pro obojí.
- **Kontakty:** zástupné údaje (`+420 000 000 000`, `kontakt@example.com`, adresa) jsou v horní liště a v patičce.
- **Data konfigurátoru:** objekty `SERIES`, `COUNTS` a `WEIGHT` na začátku `main.js` (kusovníky a hmotnosti z katalogu).

## Použité zdroje

Veškerý věcný obsah pochází z těchto zdrojů:

1. Technický katalog výrobce (PDF, 56 stran, německy, stav 07/2018):
   <https://www.scafom-rux.ch/files/default/public/companies/de/downloads/details/SMART_DETAILS_MOBILO_v16_2_scr.pdf>
2. Přehled produktů výrobce: <https://www.scafom-rux.ch/de/rollgerueste> (a podstránky Mobilo 800 / 1400)
3. Přehled jednotlivých dílů: <https://geruest-welt.de/Produkte-Geruest-Welt/Rollgeruest/Einzelteile-Zubehoer/Einzelteile-Rux-Mobilo/?pgNr=1>

Design (tmavá břidlicová paleta s azurovým akcentem, písmo Open Sans, rozložení sekcí, karty s jemným zvednutím při najetí) se inspiruje webem <https://www.movitech.cz/>. Texty ani obrázky odtud nejsou převzaty.

## Verze 2: fotografie ze zdrojů

`index-foto.html` používá obrázky z původních zdrojů. Nic jsem nevytvářel ani neupravoval kromě ořezu, změny velikosti
a převodu do WebP.

| Soubory v `assets/img/` | Původ |
|---|---|
| `dily/` (23 fotografií dílů) | Technický katalog výrobce, strany 18–25 (fotografie dílů v ceníku). U kolečka 5 kN a 10 kN jsem z obrázku odstranil německé popisky. Rozšiřující sada je z přehledu dílů (geruest-welt.de) |
| `sestavy/mobilo-800.webp`, `mobilo-1400.webp` | Vizualizace sestav z webu výrobce (scafom-rux.ch/de/mobilo-800 a mobilo-1400) |
| `sestavy/podvozek-detail.webp`, `plosina-detail.webp` | Vizualizace z katalogu výrobce, strana 8 |
| `foto/zebrikove-ramy.webp`, `plosiny.webp` | Fotografie z katalogu výrobce, strana 5 |

Zdroje **neobsahují fotografie lešení při domácím použití** (jen záběry velkých stavebních lešení). Scény v části „Kde se Mobilo hodí“
proto zůstaly jako vlastní ilustrace a jsou označené štítkem „Ilustrace“. Fotografie a vizualizace jsou označené „Fotografie“ a „Vizualizace“
a na webu je uveden zdroj.

**Práva k obrázkům:** obrázky patří výrobci Scafom-Rux, případně provozovateli shopu geruest-welt.de. Před veřejným spuštěním
si ověřte, že je smíte použít (například písemným souhlasem výrobce). Do webu jsem nepřevzal žádné logo. Z obrázku kolečka na webu shopu,
na kterém je logo výrobce, jsem proto kolečko vzal z katalogu.

## Co je zástupné a je potřeba nahradit (verze 1)

- **Všech 9 obrázků v galerii** a ilustrace v hero jsou vlastní vektorové kresby. Nahraďte je fotografiemi, jakmile budou k dispozici (včetně práv k jejich použití).
- **Kontaktní údaje** v horní liště a v patičce.
- Karta **Rozšiřující sada** má obecný popis. Zdroje neuvádějí obsah jednotlivých sad.
- Logo Mobilo v hlavičce je jen textová značka vytvořená pro web, ne logo výrobce. Logo ani fotografie Scafom-Rux se na webu nepoužívají.

## Nesrovnalosti ve zdrojích (stojí za ověření u výrobce)

- Katalog je z **července 2018**. Rozměry a hmotnosti dílů berte jako orientační.
- **Délka Mobilo 1400:** přehled na str. 3 uvádí 1,8 / 2,1 / 2,6 m, technická data, kusovník a web výrobce jen 2,6 m. Web uvádí 2,6 m.
- **Kolečka:** kusovník uvádí lehčí kolo 3,0 kN, ceník 5,0 kN. Karta uvádí 5 kN.
- **Přitěžovací závaží:** kusovník uvádí 15 kg, ceník 10 kg. Web hmotnost závaží neuvádí.
- **Hmotnosti sestav:** orientační hmotnosti v katalogu se u vyšších sestav neshodují se součtem hmotností dílů. Konfigurátor proto hmotnost počítá jako součet hmotností dílů z katalogu (u nejnižší sestavy Mobilo 800 vychází 74 kg, přesně jako v katalogu). Závaží se nepočítají.
- Tabulky přitížení se v konfigurátoru **záměrně nepřebírají**. Web na ně odkazuje (katalog, str. 40–53), protože chyba v nich by mohla ohrozit bezpečnost.

## Bezpečnostní upozornění

Web je informační a nenahrazuje návod k montáži. Výrobce uvádí mimo jiné, že montáž a demontáž provádějí nejméně dvě osoby a že před použitím lešení kontroluje způsobilá osoba. Web na to upozorňuje v sekci Montáž a v časté otázce o samostatné montáži.
