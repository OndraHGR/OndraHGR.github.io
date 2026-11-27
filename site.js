/*
  Renders the whole site from one content object (content.json).
  The admin editor reuses this renderer: when state.edit is set, every text,
  photo and list item is handed to the editor's hooks so it can be changed in place.
*/
window.Site = (function () {
  "use strict";

  var IS_ADMIN = document.documentElement.hasAttribute("data-admin");
  var BASE = IS_ADMIN ? "../" : "";
  var PHOTO_PATH = /^photos\/[a-z0-9-]+\.(jpg|png|webp)$/;

  // preview: path -> blob URL of photos uploaded in the editor but not published yet
  var state = { content: null, filters: {}, edit: null, preview: {} };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  // Only web links, mail links and in-page anchors are ever put into an href.
  function safeUrl(u) {
    u = String(u || "").trim();
    return /^(https?:\/\/|mailto:|#)/i.test(u) ? u : "";
  }
  function photoUrl(path) {
    if (!PHOTO_PATH.test(path || "")) return "";
    return state.preview[path] || BASE + path;
  }
  function hasPhoto(p) { return !!(p && photoUrl(p.src)); }

  // One text of the page. In edit mode it becomes editable in place.
  function text(tag, cls, holder, key, opts) {
    opts = opts || {};
    var n = el(tag, cls), v = holder[key] || "";
    if (state.edit) {
      n.textContent = v;
      state.edit.text(n, holder, key, { multiline: !!opts.multiline, ph: opts.ph || "…" });
    } else {
      n.textContent = opts.map ? opts.map(v) : v;
    }
    return n;
  }

  // A photo in its frame, or an empty frame when there is no photo yet.
  function frame(photo, o) {
    o = o || {};
    var box = el(o.tag || "div", "frame" + (o.cls ? " " + o.cls : ""));
    var url = photo ? photoUrl(o.full ? photo.src : photo.thumb || photo.src) : "";
    if (url) {
      var img = el("img");
      img.alt = o.alt || "";
      img.decoding = "async";
      if (!o.eager) img.loading = "lazy";
      if (photo.w && photo.h) { img.width = photo.w; img.height = photo.h; }
      img.src = url;
      box.appendChild(img);
    } else {
      box.classList.add("is-empty");
      box.appendChild(el("span", "frame-ph", o.ph || "Bez fotky"));
    }
    return box;
  }

  function visibleSections() {
    return state.content.sections.filter(function (s) { return s.visible !== false; });
  }
  function counts() {
    var photos = 0, projects = 0;
    visibleSections().forEach(function (s) {
      (s.items || []).forEach(function (it) {
        if (s.type === "gallery" && hasPhoto(it)) photos++;
        if (s.type === "projects") {
          projects++;
          (it.photos || []).forEach(function (p) { if (hasPhoto(p)) photos++; });
        }
      });
    });
    return { photos: photos, projects: projects };
  }

  /* ---------- lightbox ---------- */

  var lb = null;
  function openLightbox(list, start) {
    if (!list.length) return;
    if (!lb) {
      lb = { dlg: el("dialog", "lb"), img: el("img"), title: el("span", "lb-title"), count: el("span", "lb-count") };
      var close = el("button", "lb-btn lb-close", "✕");
      close.type = "button";
      close.setAttribute("aria-label", "Zavřít");
      close.addEventListener("click", function () { lb.dlg.close(); });
      lb.prev = el("button", "lb-btn lb-prev", "←");
      lb.next = el("button", "lb-btn lb-next", "→");
      lb.prev.type = lb.next.type = "button";
      lb.prev.setAttribute("aria-label", "Předchozí fotka");
      lb.next.setAttribute("aria-label", "Další fotka");
      lb.prev.addEventListener("click", function () { lb.show(lb.i - 1); });
      lb.next.addEventListener("click", function () { lb.show(lb.i + 1); });
      var fig = el("figure"), cap = el("figcaption");
      cap.appendChild(lb.title);
      cap.appendChild(lb.count);
      fig.appendChild(lb.img);
      fig.appendChild(cap);
      [close, lb.prev, fig, lb.next].forEach(function (n) { lb.dlg.appendChild(n); });
      lb.dlg.addEventListener("click", function (e) { if (e.target === lb.dlg || e.target === fig) lb.dlg.close(); });
      lb.dlg.addEventListener("keydown", function (e) {
        if (e.key === "ArrowLeft") lb.show(lb.i - 1);
        if (e.key === "ArrowRight") lb.show(lb.i + 1);
      });
      lb.show = function (i) {
        var n = lb.list.length;
        lb.i = (i + n) % n;
        var it = lb.list[lb.i];
        lb.img.src = photoUrl(it.photo.src);
        lb.img.alt = it.title || "";
        lb.title.textContent = [it.title, it.sub].filter(Boolean).join("  /  ");
        lb.count.textContent = pad(lb.i + 1) + " / " + pad(n);
        lb.prev.hidden = lb.next.hidden = n < 2;
      };
      document.body.appendChild(lb.dlg);
    }
    lb.list = list;
    lb.show(start);
    lb.dlg.showModal();
  }

  // Makes a frame open the lightbox (public site only).
  function zoomable(fr, list, entry) {
    if (state.edit || !hasPhoto(entry.photo)) return;
    var i = list.push(entry) - 1;
    fr.type = "button";
    fr.setAttribute("aria-label", "Zvětšit: " + (entry.title || "fotka " + (i + 1)));
    fr.addEventListener("click", function () { openLightbox(list, i); });
  }

  /* ---------- header and footer ---------- */

  function instagramUrl(v) {
    v = String(v || "").trim();
    if (/^https?:\/\//i.test(v)) return v;
    v = v.replace(/^@/, "");
    return /^[a-z0-9._]{1,30}$/i.test(v) ? "https://www.instagram.com/" + v + "/" : "";
  }
  function mailUrl() {
    var mail = String(state.content.settings.email || "").trim();
    return /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i.test(mail) ? "mailto:" + mail : "";
  }

  function renderChrome() {
    var set = state.content.settings;
    if (!state.edit) {
      document.title = set.title || set.brand || "";
      var meta = document.querySelector('meta[name="description"]');
      if (meta) meta.content = set.description || "";
    }
    $("brand").textContent = set.brand || "";

    var nav = $("nav");
    nav.textContent = "";
    var contact = null;
    visibleSections().forEach(function (s) {
      if (s.type === "contact") { contact = contact || s; return; }
      if (!s.label) return;
      var a = el("a", null, s.label);
      a.href = "#" + s.id;
      nav.appendChild(a);
    });
    var cta = $("nav-cta");
    cta.hidden = !contact;
    if (contact) {
      cta.textContent = (contact.label || "Kontakt") + "  →";
      cta.href = "#" + contact.id;
    }

    var foot = $("foot");
    foot.textContent = "";
    foot.appendChild(text("span", null, set, "copyright", {
      ph: "© {year} …",
      map: function (s) { return s.replace("{year}", new Date().getFullYear()); },
    }));
    var up = el("a", null, "Nahoru  ↑");
    up.href = "#top";
    foot.appendChild(up);
  }

  /* ---------- hero ---------- */

  function renderHero() {
    var h = state.content.hero, box = $("hero");
    box.textContent = "";

    var photo = frame(h.photo, { cls: "hero-photo", full: true, eager: true, ph: "Hlavní fotka" });
    if (state.edit) state.edit.photo(photo, h, "photo");
    box.appendChild(photo);

    var body = el("div", "hero-body");
    var tag = el("p", "tag");
    tag.appendChild(el("span", "num", "01 /"));
    tag.appendChild(text("span", null, h, "tag", { ph: "Podtitul" }));
    body.appendChild(tag);
    var h1 = el("h1");
    h1.appendChild(text("span", null, h, "title1", { ph: "Titulek" }));
    h1.appendChild(text("span", "dim", h, "title2", { ph: "Druhý řádek" }));
    body.appendChild(h1);
    body.appendChild(text("p", "lead", h, "lead", { multiline: true, ph: "Úvodní text" }));

    var first = visibleSections()[0];
    if (first) {
      var actions = el("div", "actions");
      // In edit mode the button is a plain box, so clicking into its text never navigates away.
      var b = el(state.edit ? "span" : "a", "pill pill-solid");
      if (!state.edit) b.href = "#" + first.id;
      b.appendChild(text("span", null, h, "button", { ph: "Tlačítko" }));
      b.appendChild(el("span", "arrow", "↓"));
      actions.appendChild(b);
      body.appendChild(actions);
    }
    box.appendChild(body);

    var n = counts(), hud = el("div", "hud");
    [["Snímky", n.photos], ["Projekty", n.projects]].forEach(function (d) {
      var cell = el("div", "hud-box");
      cell.appendChild(el("span", "hud-label", d[0]));
      cell.appendChild(el("span", "hud-value", pad(d[1])));
      hud.appendChild(cell);
    });
    box.appendChild(hud);
  }

  /* ---------- sections ---------- */

  var TYPES = {
    gallery: function (sec, node) {
      var items = sec.items || (sec.items = []);
      var cats = [];
      items.forEach(function (it) {
        var c = (it.cat || "").trim();
        if (c && cats.indexOf(c) === -1) cats.push(c);
      });
      var f = state.filters[sec.id] || "all";
      if (cats.indexOf(f) === -1) f = "all";

      if (!state.edit && cats.length > 1) {
        var filters = el("div", "filters");
        filters.setAttribute("role", "group");
        filters.setAttribute("aria-label", "Filtr podle kategorie");
        ["all"].concat(cats).forEach(function (c) {
          var b = el("button", "pill", c === "all" ? "Vše" : c);
          b.type = "button";
          b.setAttribute("aria-pressed", String(f === c));
          b.addEventListener("click", function () { state.filters[sec.id] = c; render(); });
          filters.appendChild(b);
        });
        node.appendChild(filters);
      }

      var grid = el("div", "grid"), shown = [];
      items.forEach(function (it, i) {
        if (!state.edit && f !== "all" && (it.cat || "").trim() !== f) return;
        var fig = el("figure", "shot");
        var clickable = !state.edit && hasPhoto(it);
        var fr = frame(it, { tag: clickable ? "button" : "div", alt: it.title || "" });
        zoomable(fr, shown, { photo: it, title: it.title, sub: it.cat });
        fig.appendChild(fr);
        var cap = el("figcaption");
        cap.appendChild(el("span", "num", pad(i + 1)));
        cap.appendChild(text("span", "shot-title", it, "title", { ph: "Název fotky" }));
        if (state.edit || it.cat) cap.appendChild(text("span", "shot-cat", it, "cat", { ph: "Kategorie" }));
        fig.appendChild(cap);
        if (state.edit) state.edit.item(fig, items, i, "photo");
        grid.appendChild(fig);
      });
      if (state.edit) {
        state.edit.photoAdder(grid, "+ Přidat fotky", function (photo) {
          items.push(Object.assign({ title: "", cat: "" }, photo));
        });
      } else if (!grid.children.length) {
        grid.appendChild(el("p", "empty", "Zatím tu nic není."));
      }
      node.appendChild(grid);
    },

    projects: function (sec, node) {
      var items = sec.items || (sec.items = []);
      var list = el("div", "projects");
      items.forEach(function (p, i) {
        var photos = p.photos || (p.photos = []);
        var art = el("article", "project");
        var side = el("div", "project-side");
        side.appendChild(el("span", "project-num", pad(i + 1)));
        if (state.edit || p.date) side.appendChild(text("span", "project-date", p, "date", { ph: "Datum" }));
        art.appendChild(side);

        var body = el("div", "project-body");
        body.appendChild(text("h3", null, p, "title", { ph: "Název projektu" }));
        if (state.edit || p.note) body.appendChild(text("p", "project-note", p, "note", { ph: "Poznámka, např. Model: @jmeno" }));
        body.appendChild(text("p", "project-text", p, "text", { multiline: true, ph: "O čem projekt je, jak vznikal…" }));
        if (state.edit) {
          body.appendChild(text("p", "tags tags-edit", p, "tags", { ph: "Štítky oddělené čárkou: technika, objektiv, žánr" }));
        } else if (p.tags) {
          var tags = el("p", "tags");
          String(p.tags).split(",").forEach(function (t) {
            if (t.trim()) tags.appendChild(el("span", "chip", t.trim()));
          });
          body.appendChild(tags);
        }
        art.appendChild(body);

        var strip = el("div", "strip"), shown = [];
        photos.forEach(function (ph, j) {
          var clickable = !state.edit && hasPhoto(ph);
          var fr = frame(ph, { tag: clickable ? "button" : "div", alt: p.title || "" });
          zoomable(fr, shown, { photo: ph, title: p.title, sub: p.date });
          if (state.edit) state.edit.item(fr, photos, j, "photo");
          strip.appendChild(fr);
        });
        if (state.edit) {
          state.edit.photoAdder(strip, "+ Fotky", function (photo) { photos.push(photo); });
        }
        if (strip.children.length) art.appendChild(strip);

        if (state.edit) state.edit.item(art, items, i, "project");
        list.appendChild(art);
      });
      if (state.edit) {
        state.edit.adder(list, "+ Přidat projekt", function () {
          items.push({ title: "", date: "", note: "", text: "", tags: "", photos: [] });
        });
      }
      node.appendChild(list);
    },

    text: function (sec, node) {
      var cols = el("div", "about");
      cols.appendChild(text("p", "prose", sec, "body", { multiline: true, ph: "Napiš něco o sobě…" }));
      if (state.edit || hasPhoto(sec.photo)) {
        var fr = frame(sec.photo, { cls: "about-photo", full: true, ph: "Fotka (nepovinná)" });
        if (state.edit) state.edit.photo(fr, sec, "photo");
        cols.appendChild(fr);
      } else {
        cols.classList.add("about-single");
      }
      node.appendChild(cols);
    },

    contact: function (sec, node) {
      var set = state.content.settings;
      if (state.edit || sec.text) node.appendChild(text("p", "lead", sec, "text", { multiline: true, ph: "Krátká výzva ke kontaktu" }));
      var row = el("div", "actions");
      var mail = mailUrl(), ig = instagramUrl(set.instagram);
      if (mail) {
        var a = el(state.edit ? "span" : "a", "pill pill-solid", set.email.trim() + "  ↗");
        if (!state.edit) a.href = mail;
        row.appendChild(a);
      }
      if (ig) {
        var b = el(state.edit ? "span" : "a", "pill", "Instagram  ↗");
        if (!state.edit) { b.href = ig; b.target = "_blank"; b.rel = "noopener"; }
        row.appendChild(b);
      }
      node.appendChild(row);
      if (state.edit) node.appendChild(el("p", "note", "E-mail a Instagram se mění v Nastavení na spodní liště."));
    },
  };

  function renderSections() {
    var box = $("sections");
    box.textContent = "";
    var count = 1; // the hero is 01
    var list = state.content.sections;
    list.forEach(function (sec, i) {
      var hidden = sec.visible === false;
      if (hidden && !state.edit) return;

      var node = el("section", "sec sec-" + sec.type + (hidden ? " is-hidden" : ""));
      node.id = sec.id;
      var head = el("div", "sec-head");
      var tag = el("p", "tag");
      tag.appendChild(el("span", "num", (hidden ? "--" : pad(++count)) + " /"));
      tag.appendChild(text("span", null, sec, "label", { ph: "Název v menu" }));
      head.appendChild(tag);
      head.appendChild(text("h2", null, sec, "title", { ph: "Nadpis sekce" }));
      if (state.edit || sec.note) head.appendChild(text("p", "sec-note", sec, "note", { multiline: true, ph: "Krátká poznámka k sekci (nepovinná)" }));
      node.appendChild(head);

      if (TYPES[sec.type]) TYPES[sec.type](sec, node);
      if (state.edit) state.edit.section(node, head, list, i);
      box.appendChild(node);
    });
  }

  function render() {
    if (!state.content) return;
    renderChrome();
    renderHero();
    renderSections();
  }

  function load() {
    return fetch(BASE + "content.json", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("content " + r.status);
        return r.json();
      })
      .then(function (c) {
        state.content = c;
        return c;
      });
  }

  if (!IS_ADMIN) {
    load().then(function () {
      render();
      var target = location.hash.length > 1 ? document.getElementById(location.hash.slice(1)) : null;
      if (target) target.scrollIntoView();
    }).catch(function () {
      $("hero").appendChild(el("p", "empty", "Obsah se nepodařilo načíst. Zkus stránku obnovit."));
    });
  }

  return { state: state, render: render, load: load };
})();
