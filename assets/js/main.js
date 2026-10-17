/* ==========================================================================
   MOBILO – skripty webu
   --------------------------------------------------------------------------
   Obsah:
     1. Data sestav (kusovníky z katalogu výrobce, stav 07/2018)
     2. Kreslení ilustrace lešení (SVG)
     3. Navigace, hlavička, tlačítko nahoru
     4. Animace při načtení (fade-in)
     5. Filtr komponent
     6. Galerie a lightbox
     7. Konfigurátor sestavy
     8. Spuštění
   Skripty nepotřebují žádnou knihovnu ani server – stačí otevřít index.html.
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /** Číslo pro text s desetinnou čárkou, nejvýše jedno desetinné místo: 5.6 → „5,6“, 14 → „14“ */
  function fmt(n) {
    return String(Math.round(n * 10) / 10).replace('.', ',');
  }
  /** Číslo pro SVG souřadnice (desetinná TEČKA, jedno desetinné místo) */
  function num(n) { return String(Math.round(n * 10) / 10); }


  /* ------------------------------------------------------------------------
     1. DATA SESTAV
     Každé pole má 12 hodnot – jednu pro každou pracovní výšku z katalogu.
     Kusovník sestavy odpovídá tabulkám „Stücklisten“ v PDF katalogu.
     ------------------------------------------------------------------------ */
  var SERIES = {
    800: {
      work:  [3.5, 4.5, 5.5, 6.6, 7.6, 8.6, 9.6, 10.6, 11.6, 12.6, 13.6, 14.0], // pracovní výška (m)
      floor: [1.5, 2.5, 3.5, 4.6, 5.6, 6.6, 7.6, 8.6, 9.6, 10.6, 11.6, 12.0],   // výška podlahy (m)
      beamsFrom: 3                                                              // od tohoto kroku patří do sestavy jízdní nosníky
    },
    1400: {
      work:  [3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.6, 10.6, 11.6, 12.6, 13.6, 14.0],
      floor: [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.6, 8.6, 9.6, 10.6, 11.6, 12.0],
      beamsFrom: 6
    }
  };

  // Počty dílů – stejné pro obě šířky
  var COUNTS = {
    ladder2: [2, 2, 4, 4, 6, 6, 8, 8, 10, 10, 12, 12],  // žebříkové rámy 2,0 m
    ladder1: [0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2],      // žebříkové rámy 1,0 m
    decks:   [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3],      // plošiny (u Mobilo 1400 ve dvojicích)
    rails:   [4, 6, 8, 8, 12, 12, 14, 14, 18, 18, 20, 20],
    vdiag:   [2, 2, 4, 4, 6, 6, 8, 8, 10, 10, 12, 12]
  };

  // Hmotnosti dílů v kg (katalog výrobce) – podle délky lešení / šířky
  var WEIGHT = {
    ladder2:   { 800: 9.6, 1400: 14.4 },
    ladder1:   { 800: 5.2, 1400: 7.4 },
    deckHatch: { 1.8: 14.8, 2.1: 17.4, 2.6: 21.0 },
    deckPlain: 20.2,
    rail:      { 1.8: 2.2, 2.1: 2.5, 2.6: 2.7 },
    vdiag:     { 1.8: 2.6, 2.1: 3.0, 2.6: 3.2 },
    hdiag:     { 800: { 1.8: 2.2, 2.1: 2.4, 2.6: 2.8 }, 1400: { 2.6: 3.0 } },
    boardLong: { 1.8: 4.8, 2.1: 5.4, 2.6: 6.4 },
    boardCross: { 800: 1.3, 1400: 2.2 },
    wheel: 6.0,
    beam:  { 800: 20.9, 1400: 27.4 },
    arm: 8.0, spindle: 5.2, pin: 0.22
  };

  /** Složí kompletní popis sestavy (rozměry, kusovník, hmotnost). */
  function buildConfig(model, step, length) {
    var s = SERIES[model];
    var len = model === 1400 ? 2.6 : length;
    var c = {
      model: model, step: step, length: len,
      work: s.work[step], floor: s.floor[step],
      ladder2: COUNTS.ladder2[step], ladder1: COUNTS.ladder1[step],
      decks: COUNTS.decks[step], rails: COUNTS.rails[step], vdiag: COUNTS.vdiag[step],
      boards: step > 0,
      beams: step >= s.beamsFrom,
      lightWheels: model === 800 && step < 3
    };

    var parts = [];
    parts.push(['Žebříkový rám 2,0 m', c.ladder2]);
    if (c.ladder1) { parts.push(['Žebříkový rám 1,0 m', c.ladder1]); }
    parts.push(['Plošina s poklopem ' + fmt(len) + ' m', c.decks]);
    if (model === 1400) { parts.push(['Plošina bez poklopu 2,6 m', c.decks]); }
    parts.push(['Zábradlí ' + fmt(len) + ' m', c.rails]);
    parts.push(['Svislá diagonála', c.vdiag]);
    parts.push(['Vodorovná diagonála', 1]);
    if (c.boards) {
      parts.push(['Patní lišta podélná', 2]);
      parts.push(['Patní lišta příčná', 2]);
    }
    parts.push(['Otočné kolo s brzdou' + (c.lightWheels ? ' (lehčí)' : ' (10 kN)'), 4]);
    if (c.beams) {
      parts.push(['Jízdní nosník', 2]);
      parts.push(['Teleskopické rameno', 4]);
      parts.push(['Stavěcí závitová tyč', 4]);
      parts.push(['Zajišťovací čep', 4]);
    }
    c.parts = parts;

    // Hmotnost = součet hmotností dílů (bez přitěžovacích závaží)
    var kg = c.ladder2 * WEIGHT.ladder2[model] + c.ladder1 * WEIGHT.ladder1[model] +
      c.decks * WEIGHT.deckHatch[len] + (model === 1400 ? c.decks * WEIGHT.deckPlain : 0) +
      c.rails * WEIGHT.rail[len] + c.vdiag * WEIGHT.vdiag[len] +
      WEIGHT.hdiag[model][len] + 4 * WEIGHT.wheel;
    if (c.boards) { kg += 2 * WEIGHT.boardLong[len] + 2 * WEIGHT.boardCross[model]; }
    if (c.beams) { kg += 2 * WEIGHT.beam[model] + 4 * WEIGHT.arm + 4 * WEIGHT.spindle + 4 * WEIGHT.pin; }
    c.weight = Math.round(kg);
    return c;
  }


  /* ------------------------------------------------------------------------
     2. KRESLENÍ ILUSTRACE LEŠENÍ
     Pohled z podélné strany. 1 metr = 40 jednotek, země je na y = 0,
     lešení je vycentrované na x = 0 a roste nahoru (záporné y).
     Barvy odpovídají značení dílů: zelená = zábradlí, červená = svislá diagonála,
     černá = vodorovná diagonála.
     ------------------------------------------------------------------------ */
  var U = 40;
  var COL = { post: '#6f7e89', postHi: '#d3dce2', rung: '#8b9aa5', rail: '#34b27f', vdiag: '#e5484d',
              hdiag: '#1e2226', deck: '#e0a93b', deckEdge: '#8a6417', toe: '#b5523b', wheel: '#1e2226',
              hub: '#9aa7b0', beam: '#56636d', person: '#2b343c', helmet: '#ffb422' };

  /** Úsečka: x v jednotkách, výšky h1/h2 v metrech nad zemí */
  function ln(x1, h1, x2, h2, stroke, w, extra) {
    return '<line x1="' + num(x1) + '" y1="' + num(-h1 * U) + '" x2="' + num(x2) + '" y2="' + num(-h2 * U) +
      '" stroke="' + stroke + '" stroke-width="' + w + '" stroke-linecap="round"' + (extra || '') + '/>';
  }

  /** Vrátí { svg, minX, maxX, minY, maxY } – obsah <g> v souřadnicích lešení. */
  function drawScaffold(c, o) {
    o = o || {};
    var half = c.length * U / 2;
    var base = c.beams ? 0.5 : 0.34;      // výška spodku sloupků nad zemí (m)
    var top = c.floor + 1.1;              // výška vrcholu sloupků (m)
    var out = [];

    // úrovně plošin: horní + každé 4 m dolů, nejníže od 1,0 m
    var levels = [];
    for (var h = c.floor; h >= 1.0 - 1e-6; h -= 4) { levels.push(h); }

    // 2a. kolečka (a jízdní nosníky)
    [-half, half].forEach(function (x) {
      if (c.beams) {
        out.push('<rect x="' + num(x - 0.3 * U) + '" y="' + num(-0.5 * U) + '" width="' + num(0.6 * U) + '" height="' + num(0.16 * U) +
          '" rx="2" fill="' + COL.beam + '"/>');
      }
      out.push(ln(x, c.beams ? 0.34 : 0.3, x, c.beams ? 0.5 : 0.36, COL.wheel, 4));
      out.push('<circle cx="' + num(x) + '" cy="' + num(-0.15 * U) + '" r="' + num(0.15 * U) + '" fill="' + COL.wheel + '"/>');
      out.push('<circle cx="' + num(x) + '" cy="' + num(-0.15 * U) + '" r="' + num(0.06 * U) + '" fill="' + COL.hub + '"/>');
    });

    // 2b. příčky žebříků (z boku jen krátké čárky u sloupků, 4 příčky na metr)
    for (var r = base + 0.25; r < top - 0.1; r += 0.25) {
      out.push(ln(-half - 6, r, -half + 6, r, COL.rung, 1.6));
      out.push(ln(half - 6, r, half + 6, r, COL.rung, 1.6));
    }

    // 2c. svislé diagonály (střídavě nahoru a dolů, každé 2 m)
    var nDiag = c.vdiag / 2;
    for (var k = 0; k < nDiag; k++) {
      var h0 = base + 0.5 + k * 2.0;
      var h1 = Math.min(h0 + 1.75, top - 0.15);
      if (h0 >= h1) { continue; }
      var leftFirst = k % 2 === 0;
      out.push(ln(leftFirst ? -half : half, h0, leftFirst ? half : -half, h1, COL.vdiag, 2.8));
    }

    // 2d. základní zábradlí (zelené) a vodorovná diagonála (černá) u země
    out.push(ln(-half, base + 0.25, half, base + 0.25, COL.rail, 3.4));
    out.push(ln(-half, base + 0.6, half, base + 0.6, COL.hdiag, 2.6, ' stroke-dasharray="7 5"'));

    // 2e. sloupky (dva tahy = efekt hliníkové trubky)
    [-half, half].forEach(function (x) {
      out.push(ln(x, base, x, top, COL.post, 6));
      out.push(ln(x - 1, base + 0.03, x - 1, top - 0.03, COL.postHi, 2));
    });

    // 2f. postava na horní plošině (jen pro měřítko)
    if (o.person) {
      var f = c.floor;
      out.push(ln(-5, f, -2, f + 0.9, COL.person, 5));
      out.push(ln(5, f, 2, f + 0.9, COL.person, 5));
      out.push(ln(0, f + 0.88, 0, f + 1.42, COL.person, 11));
      out.push(ln(-3, f + 1.38, -13, f + 2.0, COL.person, 4));
      out.push(ln(3, f + 1.38, 13, f + 2.0, COL.person, 4));
      out.push('<circle cx="0" cy="' + num(-(f + 1.64) * U) + '" r="' + num(0.13 * U) + '" fill="' + COL.person + '"/>');
      out.push('<path d="M-6.2 ' + num(-(f + 1.67) * U) + 'a6.2 6.2 0 0 1 12.4 0z" fill="' + COL.helmet + '"/>');
    }

    // 2g. plošiny, patní lišty, horní zábradlí
    levels.forEach(function (lv, i) {
      var isTop = i === 0;
      out.push('<rect x="' + num(-half - 12) + '" y="' + num(-lv * U) + '" width="' + num(2 * half + 24) + '" height="6" rx="1.5" fill="' +
        COL.deck + '" stroke="' + COL.deckEdge + '" stroke-width="1"/>');
      out.push(ln(-half, lv + 1.0, half, lv + 1.0, COL.rail, 3.4));
      if (isTop && c.boards) {
        out.push(ln(-half, lv + 0.5, half, lv + 0.5, COL.rail, 3.4));
        out.push('<rect x="' + num(-half) + '" y="' + num(-(lv + 0.15) * U) + '" width="' + num(2 * half) + '" height="' + num(0.15 * U) +
          '" fill="' + COL.toe + '"/>');
      }
    });

    var minX = -half - 18, maxX = half + 18;
    var maxY = Math.max(top, c.floor + 2.0) * U + 8;

    // 2h. kóty: výška podlahy a pracovní výška (jen konfigurátor)
    if (o.dims) {
      var xa = half + 0.9 * U, xb = half + 1.7 * U;
      var work = c.work, fl = c.floor;
      // kóta + popisek; když je úsečka krátká, použije se zkrácený popisek
      var dim = function (x, hh, full, short, color) {
        var label = hh * U >= full.length * 6.4 ? full : short;
        out.push(ln(x, 0, x, hh, color, 1.6, ' stroke-dasharray="4 3"'));
        out.push(ln(x - 5, 0, x + 5, 0, color, 1.6));
        out.push(ln(x - 5, hh, x + 5, hh, color, 1.6));
        out.push('<text transform="translate(' + num(x - 7) + ' ' + num(-hh * U / 2) + ') rotate(-90)" text-anchor="middle" font-size="11" ' +
          'font-weight="700" fill="' + color + '" font-family="Open Sans, system-ui, sans-serif">' + label + '</text>');
      };
      out.push(ln(half + 14, fl, xa, fl, '#7b8c96', 1, ' stroke-dasharray="2 3"'));
      dim(xa, fl, 'výška podlahy ' + fmt(fl) + ' m', fmt(fl) + ' m', '#0b7285');
      dim(xb, work, 'pracovní výška ' + fmt(work) + ' m', fmt(work) + ' m', '#1e2226');
      maxX = xb + 22;
      maxY = Math.max(maxY, work * U + 8);
    }
    if (o.ground) {
      out.push('<line x1="' + num(minX - 20) + '" y1="0" x2="' + num(maxX + 10) + '" y2="0" stroke="#7b8c96" stroke-width="2"/>');
      for (var gx = minX - 20; gx < maxX + 10; gx += 12) {
        out.push('<line x1="' + num(gx) + '" y1="0" x2="' + num(gx - 7) + '" y2="8" stroke="#a9b6bf" stroke-width="1.4"/>');
      }
      minX -= 20; maxX += 10;
    }
    return { svg: out.join(''), minX: minX, maxX: maxX, minY: -maxY, maxY: o.ground ? 10 : 2 };
  }

  /** Vyplní všechny <g data-scaffold> (hero, galerie). */
  function renderStaticScaffolds() {
    $$('g[data-scaffold]').forEach(function (g) {
      var cfg = buildConfig(Number(g.dataset.model || 800), Number(g.dataset.step || 0), Number(g.dataset.length || 2.6));
      g.innerHTML = drawScaffold(cfg, { person: g.hasAttribute('data-person') }).svg;
    });
  }


  /* ------------------------------------------------------------------------
     3. NAVIGACE, HLAVIČKA, TLAČÍTKO NAHORU
     ------------------------------------------------------------------------ */
  function initNav() {
    var toggle = $('.nav-toggle');
    var nav = $('#hlavni-navigace');
    var header = $('.site-header');
    var toTop = $('.to-top');
    if (!toggle || !nav) { return; }

    function setOpen(open) {
      nav.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Zavřít menu' : 'Otevřít menu');
    }
    toggle.addEventListener('click', function () { setOpen(!nav.classList.contains('is-open')); });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) { setOpen(false); } });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('is-open')) { setOpen(false); toggle.focus(); }
    });
    window.addEventListener('resize', function () { if (window.innerWidth >= 960) { setOpen(false); } });

    // stín hlavičky a tlačítko „nahoru“
    var ticking = false;
    function onScroll() {
      header.classList.toggle('is-scrolled', window.scrollY > 8);
      if (toTop) { toTop.classList.toggle('is-visible', window.scrollY > 700); }
      ticking = false;
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { window.requestAnimationFrame(onScroll); ticking = true; }
    }, { passive: true });
    onScroll();
    if (toTop) { toTop.addEventListener('click', function () { window.scrollTo({ top: 0 }); }); }

    // zvýraznění odkazu aktuální sekce
    if ('IntersectionObserver' in window) {
      var links = {};
      $$('.nav__link[href^="#"]').forEach(function (a) { links[a.getAttribute('href').slice(1)] = a; });
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) { return; }
          Object.keys(links).forEach(function (id) { links[id].classList.toggle('is-active', id === en.target.id); });
        });
      }, { rootMargin: '-45% 0px -50% 0px' });
      // sledujeme všechny sekce; u těch bez odkazu v menu se zvýraznění zruší
      $$('main section[id]').forEach(function (s) { io.observe(s); });
    }
  }


  /* ------------------------------------------------------------------------
     4. ANIMACE PŘI NAČTENÍ (fade-in při doscrollování)
     ------------------------------------------------------------------------ */
  function initReveal() {
    var items = $$('[data-reveal]');
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Po dokončení animace atribut odebereme, aby přechody a zpoždění fade-inu
    // nepřebíjely hover efekty karet.
    function release(el) {
      el.removeAttribute('data-reveal');
      el.style.removeProperty('--d');
    }
    function show(el) {
      el.classList.add('is-visible');
      window.setTimeout(function () { release(el); }, 1400);
    }

    if (!('IntersectionObserver' in window) || reduce) {
      items.forEach(function (el) { el.classList.add('is-visible'); release(el); });
      return;
    }
    var io = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { show(en.target); obs.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    items.forEach(function (el) { io.observe(el); });
  }


  /* ------------------------------------------------------------------------
     5. FILTR KOMPONENTŮ
     ------------------------------------------------------------------------ */
  function initFilter() {
    var chips = $$('.chip[data-filter]');
    var cards = $$('.part');
    var status = $('#filter-status');
    if (!chips.length) { return; }

    // počty u tlačítek
    chips.forEach(function (chip) {
      var f = chip.dataset.filter;
      var n = f === 'all' ? cards.length : cards.filter(function (c) { return c.dataset.cat === f; }).length;
      var badge = chip.querySelector('.chip__count');
      if (badge) { badge.textContent = n; }
    });

    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        var f = chip.dataset.filter, shown = 0;
        chips.forEach(function (c) {
          var on = c === chip;
          c.classList.toggle('is-active', on);
          c.setAttribute('aria-pressed', String(on));
        });
        cards.forEach(function (card) {
          var show = f === 'all' || card.dataset.cat === f;
          card.hidden = !show;
          card.classList.remove('is-entering');
          if (show) {
            shown++;
            card.classList.add('is-visible'); // karta už nečeká na fade-in
            void card.offsetWidth;            // restart CSS animace
            card.classList.add('is-entering');
          }
        });
        if (status) { status.textContent = 'Zobrazeno ' + shown + ' z ' + cards.length + ' komponentů.'; }
      });
    });
  }


  /* ------------------------------------------------------------------------
     6. GALERIE A LIGHTBOX (nativní <dialog>)
     ------------------------------------------------------------------------ */
  function initLightbox() {
    var dlg = $('#lightbox');
    var shots = $$('.shot');
    if (!dlg || !shots.length) { return; }
    var media = $('.lightbox__media', dlg);
    var title = $('.lightbox__caption h3', dlg);
    var text = $('.lightbox__caption p', dlg);
    var current = 0, opener = null;

    function show(i) {
      current = (i + shots.length) % shots.length;
      var shot = shots[current];
      var src = $('.shot__media > svg, .shot__media > img', shot);
      media.innerHTML = '';
      if (src) { media.appendChild(src.cloneNode(true)); }
      title.textContent = $('.shot__title', shot).textContent;
      text.textContent = $('.shot__text', shot).textContent;
    }
    function open(i, trigger) {
      opener = trigger;
      show(i);
      if (typeof dlg.showModal === 'function') { dlg.showModal(); } else { dlg.setAttribute('open', ''); }
    }
    function close() {
      if (typeof dlg.close === 'function') { dlg.close(); } else { dlg.removeAttribute('open'); }
    }

    shots.forEach(function (shot, i) { shot.addEventListener('click', function () { open(i, shot); }); });
    $('.lightbox__close', dlg).addEventListener('click', close);
    $('.lightbox__prev', dlg).addEventListener('click', function () { show(current - 1); });
    $('.lightbox__next', dlg).addEventListener('click', function () { show(current + 1); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) { close(); } });   // klik na pozadí
    dlg.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { show(current - 1); }
      if (e.key === 'ArrowRight') { show(current + 1); }
    });
    dlg.addEventListener('close', function () { if (opener) { opener.focus(); } });
  }


  /* ------------------------------------------------------------------------
     7. KONFIGURÁTOR SESTAVY
     ------------------------------------------------------------------------ */
  function initConfigurator() {
    var root = $('#konfigurator');
    if (!root) { return; }
    var range = $('#cfg-height', root);
    var svg = $('#cfg-svg', root);
    var lenInputs = $$('input[name="cfg-length"]', root);
    var modelInputs = $$('input[name="cfg-model"]', root);
    var out = {
      height: $('#cfg-height-out', root), floor: $('#cfg-floor', root), decks: $('#cfg-decks', root),
      weight: $('#cfg-weight', root), base: $('#cfg-base', root), list: $('#cfg-parts', root), note: $('#cfg-note', root)
    };

    function selected(inputs) { return Number(inputs.filter(function (i) { return i.checked; })[0].value); }

    function update() {
      var model = selected(modelInputs);
      var length = selected(lenInputs);
      // Mobilo 1400 se vyrábí jen v délce 2,6 m
      lenInputs.forEach(function (i) {
        var locked = model === 1400 && i.value !== '2.6';
        i.disabled = locked;
        if (model === 1400 && i.value === '2.6') { i.checked = true; }
      });
      if (model === 1400) { length = 2.6; }

      var step = Number(range.value);
      var c = buildConfig(model, step, length);

      out.height.textContent = fmt(c.work);
      range.setAttribute('aria-valuetext', 'pracovní výška ' + fmt(c.work) + ' metru');
      out.floor.textContent = fmt(c.floor) + ' m';
      out.decks.textContent = String(c.decks * (model === 1400 ? 2 : 1)) + ' ks';
      out.weight.textContent = 'ca. ' + c.weight + ' kg';
      out.base.textContent = c.beams ? 'Jízdní nosníky' : 'Jen kolečka';

      out.list.innerHTML = c.parts.map(function (p) {
        return '<li><span>' + p[0] + '</span><b>' + p[1] + '×</b></li>';
      }).join('');

      var note = c.beams
        ? 'Od této výšky patří podle katalogu do sestavy jízdní nosníky s teleskopickými rameny. Při plně vysunutých ramenech se závaží nepoužívají.'
        : 'Bez jízdních nosníků může být potřeba lešení přitížit závažími. Kolik, určíte podle tabulek přitížení v katalogu (str. 40–53).';
      if (c.work > 10) { note += ' <strong>Pozor:</strong> pracovní výška nad 10 m je povolená jen uvnitř budov, venku je maximum 10 m.'; }
      out.note.innerHTML = note;

      var d = drawScaffold(c, { person: true, dims: true, ground: true });
      var pad = 16;
      svg.setAttribute('viewBox', [d.minX - pad, d.minY - pad, (d.maxX - d.minX) + 2 * pad, (d.maxY - d.minY) + 2 * pad].map(num).join(' '));
      svg.innerHTML = d.svg;
      svg.setAttribute('aria-label', 'Ilustrace sestavy Mobilo ' + model + ' s pracovní výškou ' + fmt(c.work) + ' metru');
    }

    range.addEventListener('input', update);
    lenInputs.concat(modelInputs).forEach(function (i) { i.addEventListener('change', update); });
    update();
  }


  /* ------------------------------------------------------------------------
     8. SPUŠTĚNÍ
     ------------------------------------------------------------------------ */
  function init() {
    renderStaticScaffolds();
    initNav();
    initReveal();
    initFilter();
    initLightbox();
    initConfigurator();
    var y = $('#rok');
    if (y) { y.textContent = new Date().getFullYear(); }
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();
