/* BlueDot Atlas — Globe.gl frontend (Step 3).
 *
 * Renders a clickable 3D globe. Clicking drops a marker, the user picks a
 * layer + radius, and "Explore" calls the FastAPI /query endpoint and renders
 * the validated results in a side panel.
 */

(function () {
  "use strict";

  // --- DOM handles --------------------------------------------------------
  const coordEl = document.getElementById("coord");
  const layerEl = document.getElementById("layer");
  const radiusEl = document.getElementById("radius");
  const radiusLabel = document.getElementById("radius-label");
  const goBtn = document.getElementById("go");
  const results = document.getElementById("results");
  const closeBtn = document.getElementById("close");
  const reopenBtn = document.getElementById("reopen");
  const statusEl = document.getElementById("status");
  const contentEl = document.getElementById("content");
  const rTitle = document.getElementById("r-title");
  const rSub = document.getElementById("r-sub");
  const globeEl = document.getElementById("globe");

  // --- State --------------------------------------------------------------
  let selected = null;       // { lat, lng } — a fresh, not-yet-explored pick
  let savedMarkers = [];     // explored places loaded from /markers
  let activeRing = null;     // { lat, lng, radius_km } — the location pinging

  // Roughly km per degree of latitude; used to size the ping to a real radius.
  const KM_PER_DEG = 111;

  // --- Globe setup --------------------------------------------------------
  const globe = Globe()(document.getElementById("globe"))
    .globeImageUrl("https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg")
    .bumpImageUrl("https://unpkg.com/three-globe@2.31.0/example/img/earth-topology.png")
    .backgroundImageUrl("https://unpkg.com/three-globe@2.31.0/example/img/night-sky.png")
    .showAtmosphere(true)
    .atmosphereColor("#4ea3ff")
    .atmosphereAltitude(0.18);

  globe.controls().autoRotate = true;
  globe.controls().autoRotateSpeed = 0.35;

  // Keep the globe sized to the window.
  function resize() {
    globe.width(window.innerWidth).height(window.innerHeight);
  }
  window.addEventListener("resize", resize);
  resize();

  // --- Click to select a point -------------------------------------------
  // Tracks whether the most recent click actually hit the globe surface, so
  // clicks on empty space (off the Earth) can resume auto-rotation.
  let globeClicked = false;
  let lastPointClick = 0; // timestamp guard so a marker click isn't also a new pick

  globe.onGlobeClick(({ lat, lng }) => {
    globeClicked = true;
    // If a saved marker was just clicked, ignore this globe-surface click so
    // we don't drop a new selection on top of it.
    if (Date.now() - lastPointClick < 80) return;
    selectFresh(lat, lng);
  });

  // Clicking an existing (saved) marker pulls up its recorded info.
  globe.onPointClick((pt) => {
    // Any marker click is still a click *on* the Earth — keep rotation stopped.
    globeClicked = true;
    lastPointClick = Date.now();
    if (!pt || pt.kind !== "saved") return;
    openSavedMarker(pt.data);
  });

  // Clicking outside the Earth (empty space) resumes rotation. The check is
  // deferred so onGlobeClick (if any) has already run and set the flag.
  // A drag (to rotate/zoom) must NOT be treated as a click, so we measure how
  // far the pointer moved between press and release.
  let downX = 0, downY = 0, dragged = false;
  const DRAG_PX = 6; // movement beyond this counts as a drag, not a click

  globeEl.addEventListener("pointerdown", (e) => {
    downX = e.clientX;
    downY = e.clientY;
    dragged = false;
  });
  globeEl.addEventListener("pointermove", (e) => {
    if (Math.abs(e.clientX - downX) > DRAG_PX ||
        Math.abs(e.clientY - downY) > DRAG_PX) {
      dragged = true;
    }
  });

  globeEl.addEventListener("click", () => {
    setTimeout(() => {
      // Ignore drags entirely — they should never start or stop rotation.
      if (!dragged && !globeClicked) {
        globe.controls().autoRotate = true;
      }
      globeClicked = false;
    }, 0);
  });

  // A brand-new pick: red marker, ping sized to the current radius slider.
  function selectFresh(lat, lng) {
    selected = { lat, lng };
    globe.controls().autoRotate = false;
    activeRing = { lat, lng, radius_km: Number(radiusEl.value) };
    renderMarkers();
    renderRing();
    coordEl.innerHTML =
      `Selected: <b>${lat.toFixed(3)}, ${lng.toFixed(3)}</b>`;
    goBtn.disabled = false;
    goBtn.textContent = "Explore this place";
  }

  // An existing saved marker: sync the controls, ping its stored radius, and
  // load the recorded information immediately.
  function openSavedMarker(m) {
    selected = null; // this is a past place, not a fresh red pick
    globe.controls().autoRotate = false;
    activeRing = { lat: m.lat, lng: m.lon, radius_km: m.radius_km };
    layerEl.value = m.layer;
    radiusEl.value = m.radius_km;
    radiusLabel.textContent = m.radius_km;
    coordEl.innerHTML =
      `Saved: <b>${m.lat.toFixed(3)}, ${m.lon.toFixed(3)}</b>`;
    goBtn.disabled = true;
    goBtn.textContent = "Explore this place";
    renderMarkers();
    renderRing();
    explore(m.lat, m.lon, m.radius_km, m.layer, { saved: true });
  }

  // Draw all saved markers (light blue) plus the current fresh pick (red).
  function renderMarkers() {
    const pts = savedMarkers.map((m) => ({
      lat: m.lat, lng: m.lon, kind: "saved", data: m,
    }));
    if (selected) {
      pts.push({ lat: selected.lat, lng: selected.lng, kind: "selected" });
    }
    globe
      .pointsData(pts)
      .pointLat("lat")
      .pointLng("lng")
      .pointColor((d) => (d.kind === "selected" ? "#ff4d4d" : "#4ea3ff"))
      .pointAltitude(0.02)
      .pointRadius(0.35);
  }

  // Draw the ping ring for the active location, sized to its radius in km.
  function renderRing() {
    if (!activeRing) {
      globe.ringsData([]);
      return;
    }
    const maxDeg = Math.max(0.4, activeRing.radius_km / KM_PER_DEG);
    globe
      .ringsData([{ lat: activeRing.lat, lng: activeRing.lng }])
      .ringLat("lat")
      .ringLng("lng")
      .ringColor(() => (t) => `rgba(78,163,255,${1 - t})`)
      .ringMaxRadius(maxDeg)
      .ringPropagationSpeed(maxDeg * 0.75)
      .ringRepeatPeriod(900);
  }

  // Load previously explored markers from the server on startup.
  async function loadMarkers() {
    try {
      const res = await fetch("/markers");
      if (!res.ok) return;
      savedMarkers = await res.json();
      renderMarkers();
    } catch (_) { /* offline / first run — ignore */ }
  }
  loadMarkers();

  // --- Radius slider ------------------------------------------------------
  radiusEl.addEventListener("input", () => {
    radiusLabel.textContent = radiusEl.value;
    // Resize the live ping while a fresh pick is active.
    if (selected && activeRing) {
      activeRing.radius_km = Number(radiusEl.value);
      renderRing();
    }
  });

  // --- Explore action -----------------------------------------------------
  goBtn.addEventListener("click", runQuery);
  closeBtn.addEventListener("click", () => {
    results.classList.remove("open");
    reopenBtn.classList.add("show");
  });
  reopenBtn.addEventListener("click", () => {
    results.classList.add("open");
    reopenBtn.classList.remove("show");
  });

  async function runQuery() {
    if (!selected) return;
    explore(selected.lat, selected.lng, Number(radiusEl.value), layerEl.value, {
      saved: false,
    });
  }

  async function explore(lat, lon, radius, layer, { saved = false } = {}) {
    openPanel();
    showStatus(
      saved
        ? `<div class="spinner"></div>Loading saved exploration…`
        : `<div class="spinner"></div>Gathering grounded information…<br>` +
            `<small>This calls a live model and can take up to a minute.</small>`
    );
    rTitle.textContent = saved ? "Loading…" : "Exploring…";
    rSub.textContent = `${layer} · ${lat.toFixed(2)}, ${lon.toFixed(2)} · ${radius} km`;
    goBtn.disabled = true;

    const url =
      `/query?lat=${lat}&lon=${lon}&radius=${radius}&layer=${encodeURIComponent(layer)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        let detail = res.statusText;
        try { detail = (await res.json()).detail || detail; } catch (_) {}
        showStatus(
          `<p style="color:var(--warn)">Could not load results (HTTP ${res.status}).</p>` +
          `<p>${escapeHtml(String(detail))}</p>`
        );
        return;
      }
      const data = await res.json();
      renderResults(data);
      // The place is now recorded — clear the red pick and refresh the saved
      // markers so it appears as a persistent light-blue marker.
      selected = null;
      await loadMarkers();
    } catch (err) {
      showStatus(
        `<p style="color:var(--warn)">Network error.</p><p>${escapeHtml(String(err))}</p>`
      );
    } finally {
      goBtn.disabled = false;
    }
  }

  // --- Rendering ----------------------------------------------------------
  function openPanel() {
    results.classList.add("open");
    reopenBtn.classList.remove("show");
  }

  function showStatus(html) {
    statusEl.style.display = "block";
    statusEl.innerHTML = html;
    contentEl.innerHTML = "";
  }

  function renderResults(d) {
    statusEl.style.display = "none";

    rTitle.textContent = d.place_summary
      ? truncate(d.place_summary, 60)
      : "Results";
    rSub.textContent =
      `${d.layer} · ${d.lat.toFixed(2)}, ${d.lon.toFixed(2)} · ${d.radius_km} km`;

    const parts = [];

    if (d.place_summary) {
      parts.push(section("Overview", `<p class="summary">${escapeHtml(d.place_summary)}</p>`));
    }
    if (d.cultural_context) {
      parts.push(section("Cultural context", `<p class="culture">${escapeHtml(d.cultural_context)}</p>`));
    }

    // Issues
    if (d.issues && d.issues.length) {
      const cards = d.issues.map((i) => `
        <div class="card">
          <h3>${escapeHtml(i.title)}</h3>
          ${i.description ? `<p>${escapeHtml(i.description)}</p>` : ""}
          ${srcLinks(i.source_urls)}
        </div>`).join("");
      parts.push(section(`Key issues (${d.issues.length})`, cards));
    } else {
      parts.push(section("Key issues", `<p class="empty">None reported.</p>`));
    }

    // Organizations
    if (d.organizations && d.organizations.length) {
      const cards = d.organizations.map((o) => {
        const meta = [];
        if (o.website) meta.push(`<a href="${attr(o.website)}" target="_blank" rel="noopener">Website ↗</a>`);
        if (o.email) meta.push(`<a href="mailto:${attr(o.email)}">${escapeHtml(o.email)}</a>`);
        if (o.phone) meta.push(`<span>${escapeHtml(o.phone)}</span>`);
        const volBadge = o.accepts_volunteers === "yes"
          ? `<span class="badge vol-yes">Accepts volunteers</span>`
          : (o.accepts_volunteers === "no"
              ? `<span class="badge">No volunteers</span>` : "");
        return `
          <div class="card">
            <h3>${escapeHtml(o.name)} ${volBadge}</h3>
            ${o.description ? `<p>${escapeHtml(o.description)}</p>` : ""}
            ${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}
            ${srcLinks(o.source_urls)}
          </div>`;
      }).join("");
      parts.push(section(`Local organizations (${d.organizations.length})`, cards));
    } else {
      parts.push(section("Local organizations", `<p class="empty">No grounded organizations found.</p>`));
    }

    // Sources
    if (d.sources && d.sources.length) {
      parts.push(section(`Sources (${d.sources.length})`, srcLinks(d.sources)));
    }

    // Warnings
    if (d.warnings && d.warnings.length) {
      parts.push(`<div class="warnings">⚠ ${d.warnings.map(escapeHtml).join("<br>⚠ ")}</div>`);
    }

    contentEl.innerHTML = parts.join("");
  }

  function section(title, inner) {
    return `<div class="section-title">${escapeHtml(title)}</div>${inner}`;
  }

  function srcLinks(urls) {
    if (!urls || !urls.length) return "";
    const links = urls.map((u, i) =>
      `<a href="${attr(u)}" target="_blank" rel="noopener">[${i + 1}] ${escapeHtml(hostOf(u))}</a>`
    ).join("");
    return `<div class="src-links">${links}</div>`;
  }

  // --- Helpers ------------------------------------------------------------
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch (_) { return url; }
  }
  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function attr(s) { return escapeHtml(s); }
})();
