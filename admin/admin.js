/*
  The editor. It turns the real page into an editable one: click any text to change it,
  use the small toolbars to move, replace or delete things, and press Publikovat.

  There is no server. Publishing is one commit to the site's GitHub repository, made from
  the browser with an access token. The token is stored in the repository encrypted with
  the editor password (admin/access.json), so logging in only takes the password.
*/
(function () {
  "use strict";

  var S = window.Site;
  var st = S.state;
  var root = document.getElementById("admin-root");

  // On this computer (node dev-server.js) the GitHub API is replaced by a local stand-in.
  var LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var API = LOCAL ? "/__gh" : "https://api.github.com";
  var ACCESS_FILE = LOCAL ? "access.local.json" : "access.json";
  var SESSION_KEY = "editor.session";
  var PBKDF2_ROUNDS = 600000;
  var MIN_PASSWORD = 12;

  var sess = null;      // { token, owner, repo, branch }
  var pending = {};     // path -> base64 of photos uploaded here and not published yet
  var dirty = false;
  var busy = false;
  var statusEl = null;

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function button(label, cls, run) {
    var b = el("button", cls, label);
    b.type = "button";
    if (run) b.addEventListener("click", run);
    return b;
  }
  function setDirty(v, msg) {
    dirty = v;
    document.body.classList.toggle("is-dirty", v);
    if (statusEl) statusEl.textContent = msg || (v ? "Nepublikované změny" : "Vše je publikováno");
  }
  function rerender() {
    setDirty(true);
    S.render();
  }

  /* ---------- password and token ---------- */

  function toB64(buf) {
    var s = "", a = new Uint8Array(buf);
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s);
  }
  function fromB64(s) {
    var bin = atob(s), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function deriveKey(password, salt, rounds) {
    return crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: salt, iterations: rounds, hash: "SHA-256" },
          base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      });
  }
  function encryptToken(password, token) {
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(password, salt, PBKDF2_ROUNDS)
      .then(function (key) { return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(token)); })
      .then(function (data) { return { rounds: PBKDF2_ROUNDS, salt: toB64(salt), iv: toB64(iv), data: toB64(data) }; });
  }
  // Rejects when the password is wrong.
  function decryptToken(password, a) {
    return deriveKey(password, fromB64(a.salt), a.rounds)
      .then(function (key) { return crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(a.iv) }, key, fromB64(a.data)); })
      .then(function (buf) { return new TextDecoder().decode(buf); });
  }

  function saveSession() {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess)); } catch (e) { /* stays in memory only */ }
  }
  function readSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (e) { return null; }
  }

  /* ---------- GitHub ---------- */

  function gh(method, path, body, raw) {
    var headers = {
      Authorization: "Bearer " + sess.token,
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (body) headers["Content-Type"] = "application/json";
    return fetch(API + "/repos/" + encodeURIComponent(sess.owner) + "/" + encodeURIComponent(sess.repo) + path, {
      method: method, cache: "no-store", headers: headers, body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (!r.ok) {
        var e = new Error("GitHub " + r.status);
        e.status = r.status;
        throw e;
      }
      return raw ? r.text() : r.json();
    });
  }

  // One commit. files: [{ path, text }] to write text, [{ path, base64 }] for a binary file, [{ path, remove: true }].
  function commit(message, files, onStep) {
    var entries = [], uploads = files.filter(function (f) { return !f.remove; });
    var chain = Promise.resolve();
    uploads.forEach(function (f, i) {
      chain = chain.then(function () {
        if (onStep) onStep(i + 1, uploads.length);
        return gh("POST", "/git/blobs", f.base64 != null ? { content: f.base64, encoding: "base64" } : { content: f.text, encoding: "utf-8" });
      }).then(function (blob) {
        entries.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
      });
    });
    files.forEach(function (f) {
      if (f.remove) entries.push({ path: f.path, mode: "100644", type: "blob", sha: null });
    });
    var parent;
    return chain
      .then(function () { return gh("GET", "/git/ref/heads/" + sess.branch); })
      .then(function (ref) { parent = ref.object.sha; return gh("GET", "/git/commits/" + parent); })
      .then(function (c) { return gh("POST", "/git/trees", { base_tree: c.tree.sha, tree: entries }); })
      .then(function (tree) { return gh("POST", "/git/commits", { message: message, tree: tree.sha, parents: [parent] }); })
      .then(function (c) { return gh("PATCH", "/git/refs/heads/" + sess.branch, { sha: c.sha }); });
  }

  function ghMessage(e) {
    if (e && e.status === 401) return "Token už neplatí. Odhlas se a na přihlašovací stránce zvol „Nastavit znovu“.";
    if (e && (e.status === 403 || e.status === 404)) return "Token nemá k repozitáři právo zápisu (Contents: Read and write).";
    if (e && e.status === 409 || e && e.status === 422) return "GitHub změnu odmítl (" + e.status + "). Zkus to znovu.";
    if (e && e.status) return "GitHub vrátil chybu " + e.status + ".";
    return "Nepodařilo se spojit s GitHubem.";
  }

  /* ---------- login and first-time setup ---------- */

  function panel(tag, title) {
    document.body.classList.add("locked");
    document.body.classList.remove("editing");
    root.textContent = "";
    var form = el("form", "login");
    var t = el("p", "tag");
    t.appendChild(el("span", "num", "/"));
    t.appendChild(el("span", null, tag));
    form.appendChild(t);
    form.appendChild(el("h1", null, title));
    root.appendChild(form);
    return form;
  }
  function field(form, label, type, value, auto) {
    var l = el("label", null, label);
    var input = el("input");
    input.type = type;
    input.value = value || "";
    input.required = true;
    input.autocomplete = auto || "off";
    input.spellcheck = false;
    l.appendChild(input);
    form.appendChild(l);
    return input;
  }
  function submitRow(form, label) {
    var b = el("button", "pill pill-solid", label);
    b.type = "submit";
    form.appendChild(b);
    var msg = el("p", "login-msg");
    msg.setAttribute("role", "alert");
    form.appendChild(msg);
    return { button: b, msg: msg };
  }

  function showLogin(access) {
    var form = panel("admin", "Přístup");
    var pass = field(form, "Heslo", "password", "", "current-password");
    var row = submitRow(form, "Vstoupit  →");
    form.appendChild(button("Zapomenuté heslo nebo nový token: nastavit znovu", "login-link", function () { showSetup(access); }));

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      row.button.disabled = true;
      row.msg.textContent = "Ověřuji…";
      decryptToken(pass.value, access).then(function (token) {
        sess = { token: token, owner: access.owner, repo: access.repo, branch: access.branch };
        return gh("GET", "").then(function () {
          saveSession();
          startEditor();
        }, function (err) {
          sess = null;
          row.button.disabled = false;
          row.msg.textContent = ghMessage(err);
        });
      }, function () {
        row.button.disabled = false;
        pass.value = "";
        pass.focus();
        row.msg.textContent = "Špatné heslo.";
      });
    });
    pass.focus();
  }

  function showSetup(prev) {
    var guess = prev || {};
    var host = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
    if (!prev && host) {
      var seg = location.pathname.split("/")[1];
      guess = { owner: host[1], repo: seg && seg !== "admin" ? seg : host[1] + ".github.io" };
    }
    if (LOCAL && !prev) guess = { owner: "local", repo: "local" };

    var form = panel("admin / nastavení", "První spuštění");
    form.classList.add("login-wide");
    form.appendChild(el("p", "login-help", LOCAL
      ? "Místní náhled: změny se ukládají přímo do této složky. Token může být libovolný text."
      : "Editor ukládá změny přímo do repozitáře na GitHubu. Potřebuje k tomu přístupový token (GitHub → Settings → Developer settings → Fine-grained tokens): přístup jen k tomuto repozitáři, oprávnění Contents: Read and write. Token se uloží zašifrovaný tvým heslem, příště stačí heslo."));
    var owner = field(form, "Uživatel na GitHubu", "text", guess.owner);
    var repo = field(form, "Repozitář", "text", guess.repo);
    var token = field(form, "Přístupový token", "password", "", "off");
    var pass = field(form, "Nové heslo do editoru (aspoň " + MIN_PASSWORD + " znaků)", "password", "", "new-password");
    var pass2 = field(form, "Heslo znovu", "password", "", "new-password");
    pass.minLength = MIN_PASSWORD;
    var row = submitRow(form, "Uložit a vstoupit  →");
    if (prev) form.appendChild(button("Zpět na přihlášení", "login-link", function () { showLogin(prev); }));

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (pass.value !== pass2.value) { row.msg.textContent = "Hesla se neshodují."; return; }
      row.button.disabled = true;
      row.msg.textContent = "Ověřuji token…";
      sess = { token: token.value.trim(), owner: owner.value.trim(), repo: repo.value.trim(), branch: "" };
      gh("GET", "").then(function (info) {
        sess.branch = info.default_branch;
        return encryptToken(pass.value, sess.token);
      }).then(function (enc) {
        enc.owner = sess.owner;
        enc.repo = sess.repo;
        enc.branch = sess.branch;
        row.msg.textContent = "Ukládám…";
        return commit("Editor: nastavení přístupu", [{ path: "admin/" + ACCESS_FILE, text: JSON.stringify(enc, null, 2) + "\n" }]);
      }).then(function () {
        saveSession();
        startEditor();
      }).catch(function (err) {
        sess = null;
        row.button.disabled = false;
        row.msg.textContent = err && err.status === 404 ? "Repozitář nenalezen, nebo k němu token nemá přístup." : ghMessage(err);
      });
    });
    (guess.owner ? token : owner).focus();
  }

  /* ---------- dialogs ---------- */

  // fields: { key, label, type: "text" | "select", options: [[value, label]], ph }
  function openForm(title, fields, holder, onSave, saveLabel) {
    var dlg = el("dialog", "ed-dialog");
    var form = el("form");
    form.appendChild(el("h2", null, title));
    var readers = [];
    fields.forEach(function (f) {
      var l = el("label", null, f.label), input;
      if (f.type === "select") {
        input = el("select");
        f.options.forEach(function (o) {
          var opt = el("option", null, o[1]);
          opt.value = o[0];
          input.appendChild(opt);
        });
        input.value = holder[f.key] || f.options[0][0];
      } else {
        input = el("input");
        input.type = "text";
        input.value = holder[f.key] || "";
        if (f.ph) input.placeholder = f.ph;
      }
      l.appendChild(input);
      form.appendChild(l);
      readers.push(function () { holder[f.key] = input.value.trim(); });
    });
    var row = el("div", "ed-dialog-row");
    row.appendChild(button("Zrušit", "ed-btn", function () { dlg.close(); }));
    var save = el("button", "pill pill-solid", saveLabel || "Uložit");
    save.type = "submit";
    row.appendChild(save);
    form.appendChild(row);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      readers.forEach(function (r) { r(); });
      dlg.close();
      if (onSave) onSave();
      rerender();
    });
    dlg.addEventListener("close", function () { dlg.remove(); });
    dlg.appendChild(form);
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  function editSettings() {
    openForm("Nastavení webu", [
      { key: "brand", label: "Logo (text vlevo nahoře)" },
      { key: "title", label: "Titulek v záložce prohlížeče" },
      { key: "description", label: "Popis pro vyhledávače" },
      { key: "email", label: "Kontaktní e-mail", ph: "jmeno@example.com" },
      { key: "instagram", label: "Instagram (jméno nebo odkaz)", ph: "@jmeno" },
    ], st.content.settings);
  }

  function addSection() {
    var choice = { type: "gallery" };
    openForm("Přidat sekci", [
      { key: "type", label: "Jaká sekce?", type: "select", options: [
        ["gallery", "Galerie: mřížka fotek s kategoriemi"],
        ["projects", "Projekty: popis a fotky ke každému"],
        ["text", "Text: odstavec a fotka (třeba O mně)"],
        ["contact", "Kontakt: e-mail a Instagram"],
      ] },
    ], choice, function () {
      var ids = st.content.sections.map(function (s) { return s.id; }), id;
      do { id = "s-" + Math.random().toString(36).slice(2, 8); } while (ids.indexOf(id) !== -1);
      var sec = { id: id, type: choice.type, visible: true, label: "Nová sekce", title: "", note: "" };
      if (choice.type === "text") { sec.body = ""; sec.photo = null; }
      else if (choice.type === "contact") sec.text = "";
      else sec.items = [];
      st.content.sections.push(sec);
      setTimeout(function () {
        var node = document.getElementById(id);
        if (node) node.scrollIntoView({ block: "center" });
      }, 0);
    }, "Přidat");
  }

  /* ---------- photos ---------- */

  var FULL = { max: 2200, quality: 0.86 };
  var THUMB = { max: 900, quality: 0.8 };

  function decode(file) {
    function viaImg() {
      return new Promise(function (resolve, reject) {
        var img = new Image(), url = URL.createObjectURL(file);
        img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("not an image")); };
        img.src = url;
      });
    }
    if (!window.createImageBitmap) return viaImg();
    return createImageBitmap(file, { imageOrientation: "from-image" }).catch(viaImg);
  }
  function shrink(img, o) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    var k = Math.min(1, o.max / Math.max(w, h));
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return new Promise(function (resolve, reject) {
      c.toBlob(function (blob) {
        if (blob) resolve({ blob: blob, w: c.width, h: c.height });
        else reject(new Error("encode failed"));
      }, "image/jpeg", o.quality);
    });
  }
  function blobB64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(",")[1]); };
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  // Shrinks one picked file to a full-size JPEG and a thumbnail and keeps both in memory until Publish.
  function processFile(file) {
    var id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    var photo = { src: "photos/" + id + ".jpg", thumb: "photos/" + id + "-s.jpg" };
    return decode(file).then(function (img) {
      return Promise.all([shrink(img, FULL), shrink(img, THUMB)]);
    }).then(function (out) {
      photo.w = out[0].w;
      photo.h = out[0].h;
      st.preview[photo.src] = URL.createObjectURL(out[0].blob);
      st.preview[photo.thumb] = URL.createObjectURL(out[1].blob);
      return Promise.all([blobB64(out[0].blob), blobB64(out[1].blob)]);
    }).then(function (b) {
      pending[photo.src] = b[0];
      pending[photo.thumb] = b[1];
      return photo;
    });
  }

  function pickPhotos(multiple, onPhoto) {
    root.querySelectorAll("input.ed-file").forEach(function (n) { n.remove(); });
    var inp = el("input", "ed-file");
    inp.type = "file";
    inp.accept = "image/jpeg,image/png,image/webp";
    inp.multiple = multiple;
    inp.hidden = true;
    root.appendChild(inp);
    inp.addEventListener("change", function () {
      var files = [].slice.call(inp.files), i = 0, failed = 0;
      inp.remove();
      (function next() {
        if (i >= files.length) {
          rerender();
          if (failed) alert(failed === 1 ? "Jeden soubor se nepodařilo načíst jako obrázek." : failed + " souborů se nepodařilo načíst jako obrázek.");
          return;
        }
        setDirty(true, "Zpracovávám fotky " + (i + 1) + "/" + files.length + "…");
        processFile(files[i++]).then(onPhoto, function () { failed++; }).then(next);
      })();
    });
    inp.click();
  }
  function replacePhoto(target) {
    pickPhotos(false, function (photo) { Object.assign(target, photo); });
  }

  // Every photo path the content refers to.
  function usedPaths(node, out) {
    out = out || {};
    if (Array.isArray(node)) node.forEach(function (n) { usedPaths(n, out); });
    else if (node && typeof node === "object") {
      Object.keys(node).forEach(function (k) {
        var v = node[k];
        if ((k === "src" || k === "thumb") && typeof v === "string") out[v] = true;
        else usedPaths(v, out);
      });
    }
    return out;
  }

  /* ---------- hooks the page renderer calls in edit mode ---------- */

  function swap(arr, a, b) {
    var t = arr[a];
    arr[a] = arr[b];
    arr[b] = t;
  }
  function toolbar(defs, cls) {
    var t = el("div", "ed-tools" + (cls ? " " + cls : ""));
    t.contentEditable = "false";
    defs.forEach(function (d) {
      if (!d) return;
      var b = button(d.label, d.danger ? "danger" : null, function (e) {
        e.preventDefault();
        e.stopPropagation();
        d.run();
      });
      b.title = d.title;
      b.setAttribute("aria-label", d.title);
      t.appendChild(b);
    });
    return t;
  }
  function moveDefs(arr, i) {
    return [
      i > 0 && { label: "↑", title: "Posunout dřív", run: function () { swap(arr, i, i - 1); rerender(); } },
      i < arr.length - 1 && { label: "↓", title: "Posunout později", run: function () { swap(arr, i, i + 1); rerender(); } },
    ];
  }
  var WHAT = { photo: "tuto fotku", project: "tento projekt", section: "tuto sekci" };
  function removeDef(arr, i, kind) {
    return {
      label: "✕", title: "Smazat " + WHAT[kind], danger: true,
      run: function () {
        if (confirm("Smazat " + WHAT[kind] + "? Dokud nepublikuješ, vrátíš to obnovením stránky.")) {
          arr.splice(i, 1);
          rerender();
        }
      },
    };
  }

  var hooks = {
    text: function (n, holder, key, opts) {
      n.classList.add("ed");
      n.dataset.ph = opts.ph;
      n.spellcheck = false;
      n.contentEditable = "plaintext-only";
      var plainOnly = n.contentEditable === "plaintext-only";
      if (!plainOnly) n.contentEditable = "true";

      n.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !opts.multiline) {
          e.preventDefault();
          n.blur();
        }
      });
      if (!plainOnly) {
        // Older browsers: keep pasted formatting out by inserting the text only.
        n.addEventListener("paste", function (e) {
          e.preventDefault();
          var t = (e.clipboardData || window.clipboardData).getData("text");
          document.execCommand("insertText", false, opts.multiline ? t : t.replace(/\s*\n\s*/g, " "));
        });
      }
      n.addEventListener("input", function () {
        var v = (opts.multiline ? n.innerText : n.textContent).replace(/\r/g, "").replace(/ /g, " ");
        if (!opts.multiline) v = v.replace(/\n/g, " ");
        if (!v.trim()) {
          v = "";
          if (n.firstChild) n.textContent = ""; // drop the stray <br> so the placeholder shows again
        }
        holder[key] = v;
        setDirty(true);
      });
      n.addEventListener("blur", function () {
        var cur = holder[key];
        if (typeof cur === "string" && cur !== cur.trim()) {
          holder[key] = cur.trim();
          n.textContent = cur.trim();
        }
      });
    },

    item: function (node, arr, i, kind) {
      var extra = [];
      if (kind === "photo") {
        extra.push({ label: "Vyměnit", title: "Nahrát jinou fotku na toto místo", run: function () { replacePhoto(arr[i]); } });
      }
      node.classList.add("ed-item", "ed-item-" + kind);
      node.appendChild(toolbar(moveDefs(arr, i).concat(extra, [removeDef(arr, i, kind)])));
    },

    // A single photo slot (hero, the photo of a text section).
    photo: function (node, holder, key) {
      var has = !!(holder[key] && holder[key].src);
      node.classList.add("ed-item", "ed-item-slot");
      node.appendChild(toolbar([
        { label: has ? "Vyměnit fotku" : "Nahrát fotku", title: "Vybrat fotku z počítače", run: function () {
          pickPhotos(false, function (photo) { holder[key] = photo; });
        } },
        has && { label: "✕", title: "Odebrat fotku", danger: true, run: function () { holder[key] = null; rerender(); } },
      ]));
    },

    adder: function (container, label, add) {
      container.appendChild(button(label, "ed-add", function () {
        add();
        rerender();
      }));
    },

    photoAdder: function (container, label, onPhoto) {
      container.appendChild(button(label, "ed-add", function () { pickPhotos(true, onPhoto); }));
    },

    section: function (node, head, arr, i) {
      var sec = arr[i];
      var hidden = sec.visible === false;
      if (hidden) head.appendChild(el("span", "ed-hidden-tag", "Skryto před návštěvníky"));
      head.appendChild(toolbar(moveDefs(arr, i).concat([
        {
          label: hidden ? "Zobrazit" : "Skrýt",
          title: hidden ? "Ukázat sekci na webu" : "Skrýt sekci před návštěvníky",
          run: function () { sec.visible = hidden; rerender(); },
        },
        removeDef(arr, i, "section"),
      ]), "ed-tools-inline"));
    },
  };

  /* ---------- bottom bar ---------- */

  function publish() {
    if (busy) return;
    busy = true;
    setDirty(true, "Publikuji…");
    var used = usedPaths(st.content);
    var files = [{ path: "content.json", text: JSON.stringify(st.content, null, 2) + "\n" }];
    var uploaded = Object.keys(pending).filter(function (p) { return used[p]; });
    uploaded.forEach(function (p) { files.push({ path: p, base64: pending[p] }); });

    // Photos that are in the repository but no longer on the page are removed with the same commit.
    gh("GET", "/contents/photos?ref=" + encodeURIComponent(sess.branch))
      .catch(function (e) { if (e.status === 404) return []; throw e; })
      .then(function (list) {
        (Array.isArray(list) ? list : []).forEach(function (f) {
          if (f.type === "file" && /\.(jpg|png|webp)$/.test(f.name) && !used[f.path]) files.push({ path: f.path, remove: true });
        });
        return commit("Editor: úprava obsahu", files, function (i, n) {
          if (n > 1) setDirty(true, "Publikuji… nahrávám " + i + "/" + n);
        });
      })
      .then(function () {
        uploaded.forEach(function (p) { delete pending[p]; });
        busy = false;
        setDirty(false, LOCAL ? "Publikováno do této složky." : "Publikováno. Web se aktualizuje asi do minuty.");
      })
      .catch(function (e) {
        busy = false;
        setDirty(true, ghMessage(e) + " Nic se nepublikovalo.");
      });
  }

  function exportJson() {
    var blob = new Blob([JSON.stringify(st.content, null, 2)], { type: "application/json" });
    var a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = "web-obsah-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function importJson() {
    var inp = el("input");
    inp.type = "file";
    inp.accept = "application/json,.json";
    inp.addEventListener("change", function () {
      var file = inp.files[0];
      if (!file) return;
      file.text().then(function (t) {
        var data;
        try { data = JSON.parse(t); } catch (e) { data = null; }
        if (!data || !data.settings || !data.hero || !Array.isArray(data.sections)) {
          alert("Tento soubor není záloha obsahu z tohoto webu.");
          return;
        }
        if (!confirm("Nahradit celý obsah stránky touto zálohou? Na web se dostane až po Publikovat. Záloha obsahuje texty, ne samotné fotky.")) return;
        st.content = data;
        rerender();
      });
    });
    inp.click();
  }

  function logout() {
    if (dirty && !confirm("Máš nepublikované změny. Odhlásit a přijít o ně?")) return;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* nothing stored */ }
    dirty = false;
    location.reload();
  }

  function buildBar() {
    var bar = el("div", "ed-bar");
    var left = el("div", "ed-bar-left");
    left.appendChild(el("span", "ed-mode", LOCAL ? "Editor · místně" : "Editor"));
    statusEl = el("span", "ed-status");
    statusEl.setAttribute("role", "status");
    left.appendChild(statusEl);
    bar.appendChild(left);

    var right = el("div", "ed-bar-right");
    right.appendChild(button("+ Sekce", "ed-btn", addSection));
    right.appendChild(button("Nastavení", "ed-btn", editSettings));
    right.appendChild(button("Záloha", "ed-btn", exportJson));
    right.appendChild(button("Obnovit", "ed-btn", importJson));
    var view = el("a", "ed-btn", "Web ↗");
    view.href = "../";
    view.target = "_blank";
    view.rel = "noopener";
    right.appendChild(view);
    right.appendChild(button("Odhlásit", "ed-btn", logout));
    right.appendChild(button("Publikovat", "pill pill-solid ed-publish", publish));
    bar.appendChild(right);
    root.appendChild(bar);
  }

  function startEditor() {
    root.textContent = "";
    // The repository holds the newest content; the published site can lag a minute behind it.
    gh("GET", "/contents/content.json?ref=" + encodeURIComponent(sess.branch), null, true)
      .then(function (t) { st.content = JSON.parse(t); })
      .catch(function (e) {
        if (e && e.status === 401) throw e;
        return S.load();
      })
      .then(function () {
        document.body.classList.remove("locked");
        document.body.classList.add("editing");
        st.edit = hooks;
        S.render();
        buildBar();
        setDirty(false);
      })
      .catch(function () {
        // The stored session no longer works: start over from the login screen.
        try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* nothing stored */ }
        sess = null;
        boot();
      });
  }

  // While editing, links never leave the editor: in-page anchors scroll, everything else is inert.
  document.addEventListener("click", function (e) {
    if (!st.edit) return;
    var a = e.target.closest && e.target.closest("a");
    if (!a || a.closest("#admin-root")) return;
    if ((a.getAttribute("href") || "").charAt(0) !== "#" || e.target.closest(".ed")) e.preventDefault();
  }, true);

  window.addEventListener("beforeunload", function (e) {
    if (dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  function boot() {
    if (!window.crypto || !crypto.subtle) {
      panel("admin", "Nelze spustit").appendChild(el("p", "login-help", "Editor funguje jen přes https (nebo na localhost)."));
      return;
    }
    sess = readSession();
    if (sess && sess.token) return startEditor();
    sess = null;
    fetch(ACCESS_FILE, { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (access) {
        if (access && access.data && access.salt && access.iv) showLogin(access);
        else showSetup(null);
      });
  }
  boot();
})();
