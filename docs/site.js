(function () {
  "use strict";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Nav: solid background after scrolling, and the mobile menu.
  var nav = document.getElementById("nav");
  var btn = document.getElementById("menu-btn");
  function onScroll() { nav.classList.toggle("scrolled", window.scrollY > 12); }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
  btn.addEventListener("click", function () {
    var open = nav.classList.toggle("open");
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    document.body.style.overflow = open ? "hidden" : "";
  });
  document.querySelectorAll("#mobile-menu a").forEach(function (a) {
    a.addEventListener("click", function () {
      nav.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
      document.body.style.overflow = "";
    });
  });

  // Hero motion: the video only loads on screens 768px and wider, without reduced motion or data saver.
  // Everyone else keeps the still poster.
  var saveData = navigator.connection && navigator.connection.saveData;
  var motion = document.querySelector(".hero-motion");
  if (motion && window.matchMedia("(min-width: 768px)").matches && !reduced && !saveData) {
    var v = document.createElement("video");
    v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    v.setAttribute("muted", ""); v.setAttribute("playsinline", "");
    v.poster = "assets/hero-motion-poster.webp";
    v.src = "assets/hero-motion.webm";
    motion.insertBefore(v, motion.querySelector(".hero-shade"));
    var p = v.play(); if (p && p.catch) p.catch(function () {});
  }

  // Headlines generate letter by letter. Screen readers get the plain text.
  document.querySelectorAll("[data-type]").forEach(function (el) {
    var text = el.textContent.trim();
    var delay = Number(el.getAttribute("data-delay") || 400);
    el.textContent = "";
    var sr = document.createElement("span"); sr.className = "sr-only"; sr.textContent = text; el.appendChild(sr);
    var vis = document.createElement("span"); vis.setAttribute("aria-hidden", "true");
    var i = 0;
    text.split(" ").forEach(function (word, wi, all) {
      var w = document.createElement("span"); w.className = "type-word";
      Array.from(word).forEach(function (ch) {
        var c = document.createElement("span"); c.className = "type-char"; c.textContent = ch;
        c.style.transitionDelay = (delay + i++ * 22) + "ms"; w.appendChild(c);
      });
      if (wi < all.length - 1) w.appendChild(document.createTextNode(" "));
      vis.appendChild(w);
    });
    el.appendChild(vis);
  });

  // Eyebrow pills type themselves out behind a cursor.
  function typeEyebrow(el) {
    var full = el.getAttribute("data-eyebrow");
    var t = el.querySelector(".eyebrow-text");
    if (reduced) return;
    var n = 0; t.textContent = ""; el.classList.add("typing");
    var timer = setInterval(function () {
      n += 1; t.textContent = full.slice(0, n);
      if (n >= full.length) { clearInterval(timer); setTimeout(function () { el.classList.remove("typing"); }, 1600); }
    }, 38);
  }

  if (!("IntersectionObserver" in window)) {
    document.querySelectorAll("[data-type]").forEach(function (el) { el.classList.add("in"); });
    document.querySelectorAll("[data-reveal]").forEach(function (el) { el.classList.add("is-in"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var el = e.target;
        if (el.hasAttribute("data-type")) el.classList.add("in");
        else if (el.hasAttribute("data-eyebrow")) typeEyebrow(el);
        else el.classList.add("is-in");
        io.unobserve(el);
      });
    }, { rootMargin: "0px 0px -10% 0px" });
    document.querySelectorAll("[data-type], [data-eyebrow], [data-reveal]").forEach(function (el) { io.observe(el); });
  }

  // Work out the visitor's system and point them at the right download. Nothing is sent anywhere.
  var ua = (navigator.userAgent || "").toLowerCase();
  var plat = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "").toLowerCase();
  var os = null;
  if (/android|iphone|ipad|ipod/.test(ua)) os = "mobile";
  else if (/win/.test(plat) || /windows/.test(ua)) os = "windows";
  else if (/mac/.test(plat) || /macintosh|mac os/.test(ua)) os = "mac";
  else if (/linux|x11|cros/.test(plat + ua)) os = "linux";

  var names = { windows: "Windows", mac: "macOS", linux: "Linux" };
  var label = document.getElementById("hero-dl-label");
  var note = document.getElementById("hero-note");
  if (os && names[os]) {
    label.textContent = "Download for " + names[os];
    document.getElementById("hero-dl").href = "https://github.com/juniortheshooter/portly/releases/latest";
    document.querySelectorAll('.dl[data-os="' + os + '"]').forEach(function (c) { c.classList.add("is-rec"); });
  } else if (os === "mobile") {
    note.textContent = "Portly is a desktop app. Open this page on a computer to download it.";
  }

  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());
})();
