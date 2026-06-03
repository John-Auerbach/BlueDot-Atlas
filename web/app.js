/* BlueDot Atlas — Globe.gl frontend (Step 3).
 *
 * Renders a clickable 3D globe. Clicking drops a marker, the user picks a
 * layer + radius, and "Explore" calls the FastAPI /query endpoint and renders
 * the validated results in a side panel.
 */

import Globe from "globe.gl";
import * as THREE from "three";

(function () {
  "use strict";

  // --- DOM handles --------------------------------------------------------
  const coordEl = document.getElementById("coord");
  const layerEl = document.getElementById("layer");
  const radiusEl = document.getElementById("radius");
  const radiusLabel = document.getElementById("radius-label");
  const bordersEl = document.getElementById("borders");
  const hdMapEl = document.getElementById("hd-map");
  const atmosphereEl = document.getElementById("atmosphere");
  const dayNightEl = document.getElementById("daynight");
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
  let borderFeatures = [];   // cached country boundary lines (path arrays)

  // Roughly km per degree of latitude; used to size the ping to a real radius.
  const KM_PER_DEG = 111;

  // --- Globe setup --------------------------------------------------------
  const globe = Globe()(document.getElementById("globe"))
    .globeImageUrl("https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg")
    .bumpImageUrl("https://unpkg.com/three-globe@2.31.0/example/img/earth-topology.png")
    .backgroundImageUrl("https://unpkg.com/three-globe@2.31.0/example/img/night-sky.png")
    // We render our own faint white Fresnel shell instead of the built-in
    // atmosphere (see the atmosphere halo section), so keep this off.
    .showAtmosphere(false);

  globe.controls().autoRotate = true;
  globe.controls().autoRotateSpeed = 0.35;

  // --- Realism: photorealistic satellite tiles --------------------------
  // The flat equirectangular Blue Marble texture is the base/off state.
  // Ticking the box switches on three-globe's slippy-map tile engine. We use a
  // hybrid source so colours match the original far out AND you can zoom deep:
  //   • levels 0–8: NASA GIBS Blue Marble (Shaded Relief + Bathymetry) — the
  //     SAME imagery as the original flat texture, so the colours match.
  //   • levels 9+: Esri World Imagery — real photographic mosaic that stays
  //     sharp down to street level (~level 19).
  // GIBS Blue Marble stops at level 8, so anything deeper would 404; past that
  // we hand off to Esri, which carries the deep-zoom detail.
  const IMG = "https://unpkg.com/three-globe@2.31.0/example/img/";
  const TEX_BASE = IMG + "earth-blue-marble.jpg";
  const TEX_BASE_BUMP = IMG + "earth-topology.png";

  // How deep the engine is allowed to request tiles (Esri serves to ~19).
  const SAT_MAX_LEVEL = 17;
  // Below this level use Blue Marble; at/above it use Esri.
  const ESRI_HANDOFF_LEVEL = 9;
  const SAT_TILE = (x, y, z) =>
    z < ESRI_HANDOFF_LEVEL
      ? `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/${z}/${y}/${x}.jpeg`
      : `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

  function applyHdMap() {
    if (hdMapEl.checked) {
      globe.globeTileEngineMaxLevel(SAT_MAX_LEVEL).globeTileEngineUrl(SAT_TILE);
    } else {
      globe.globeTileEngineUrl(null).globeImageUrl(TEX_BASE).bumpImageUrl(TEX_BASE_BUMP);
    }
  }
  hdMapEl.addEventListener("change", applyHdMap);
  applyHdMap();

  // --- Realism: atmosphere halo (custom Fresnel shell) -------------------
  // A faint, thin, soft white diffuse glow that covers the whole visible
  // hemisphere and swells gently toward the limb. Built from two additive
  // spheres just larger than the globe (radius 100 in three-globe units),
  // shaded by a view-based Fresnel term. Because globe.gl and this file share
  // ONE three.js instance (import map), these meshes drop straight into
  // globe.scene() and the HD tile engine keeps working.
  const GLOBE_R = 100;

  const ATMO_VERT = `
    varying vec3 vNormal;
    varying vec3 vViewPosition;
    void main() {
      vNormal = normalize(normalMatrix * normal);
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      vViewPosition = -mvPosition.xyz;
      gl_Position = projectionMatrix * mvPosition;
    }
  `;
  const ATMO_FRAG = `
    uniform vec3 glowColor;
    uniform float base;
    uniform float power;
    uniform float fade;
    uniform float intensity;
    varying vec3 vNormal;
    varying vec3 vViewPosition;
    void main() {
      vec3 viewDir = normalize(vViewPosition);
      // facing ~1 looking straight at the surface, ~0 at the grazing limb.
      float facing = clamp(dot(vNormal, viewDir), 0.0, 1.0);
      float d = 1.0 - facing; // 0 at the disc centre, 1 at the silhouette.
      // rise: even haze (base) plus a swell toward the limb.
      // pow(facing, fade) pulls the glow back to zero right at the silhouette
      // so the outer halo has no hard ring — it dissolves into space.
      float rise = base + (1.0 - base) * pow(d, power);
      float glow = rise * pow(facing, fade) * intensity;
      gl_FragColor = vec4(glowColor * glow, glow);
    }
  `;

  function makeShell(radiusScale, side, { base, power, fade, intensity }) {
    const geom = new THREE.SphereGeometry(GLOBE_R * radiusScale, 64, 48);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color("#ffffff") },
        base: { value: base },
        power: { value: power },
        fade: { value: fade },
        intensity: { value: intensity },
      },
      vertexShader: ATMO_VERT,
      fragmentShader: ATMO_FRAG,
      side,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    return new THREE.Mesh(geom, mat);
  }

  // Front shell: a very faint, even white haze laid over the whole visible
  // hemisphere that lifts softly toward the limb — the diffuse glow on the
  // planet itself. fade 0 keeps the haze all the way to the edge.
  const atmoInner = makeShell(1.004, THREE.FrontSide, {
    base: 0.12, power: 2.0, fade: 0.0, intensity: 0.5,
  });
  // Outer shell: a thin, soft white band just past the silhouette. The fade
  // term forces it to zero at the outer edge, so it melts into space with no
  // sharp boundary.
  const atmoOuter = makeShell(1.05, THREE.BackSide, {
    base: 0.0, power: 2.0, fade: 2.5, intensity: 1.4,
  });

  const atmoGroup = new THREE.Group();
  atmoGroup.add(atmoInner);
  atmoGroup.add(atmoOuter);

  function applyAtmosphere() {
    const scene = globe.scene();
    if (atmosphereEl.checked) {
      if (!atmoGroup.parent) scene.add(atmoGroup);
    } else if (atmoGroup.parent) {
      scene.remove(atmoGroup);
    }
  }
  atmosphereEl.addEventListener("change", applyAtmosphere);
  applyAtmosphere();

  // --- Realism: day / night + city lights --------------------------------
  // Two shells sitting just above the surface, both driven by a "sun
  // direction" uniform so they only affect the hemisphere facing away from the
  // sun:
  //   • a soft dark veil that dims the night side (the terminator), and
  //   • the NASA night-lights texture added on top so cities glow in the dark.
  // The sun direction is the real sub-solar point for the current UTC time, so
  // the terminator falls where it actually is right now. We sample the lights
  // texture analytically from the surface normal (matching three-globe's
  // lat/lng convention) so the lights line up with the continents regardless
  // of the shell geometry's own UVs.
  const DEG = Math.PI / 180;

  // Sub-solar point → a unit vector in three-globe's world space.
  function sunDirection() {
    const now = new Date();
    const yearStart = Date.UTC(now.getUTCFullYear(), 0, 0);
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const dayOfYear = (today - yearStart) / 86400000;
    // Solar declination (approx) and the longitude the sun is overhead.
    const decl = -23.44 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
    const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    const lng = -15 * (utcHours - 12); // sun over 0° lng at 12:00 UTC
    const lat = decl;
    // three-globe polar→cartesian convention.
    const phi = (90 - lat) * DEG;
    const theta = (90 - lng) * DEG;
    return new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta),
      Math.cos(phi),
      Math.sin(phi) * Math.sin(theta)
    ).normalize();
  }

  const sunUniform = { value: sunDirection() };

  const DN_VERT = `
    varying vec3 vWorldNormal;
    void main() {
      vWorldNormal = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  // Dark veil: black, normal-blended, alpha rises on the night side.
  const SHADE_FRAG = `
    uniform vec3 sunDir;
    varying vec3 vWorldNormal;
    void main() {
      float d = dot(normalize(vWorldNormal), normalize(sunDir));
      // 0 on the day side, 1 deep on the night side, soft across the terminator.
      float night = smoothstep(0.12, -0.18, d);
      gl_FragColor = vec4(0.0, 0.0, 0.0, night * 0.8);
    }
  `;

  // City lights: sample the night texture by analytic lat/lng, add on the
  // night side only. Additive blend makes the lit pixels glow.
  const LIGHTS_FRAG = `
    uniform vec3 sunDir;
    uniform sampler2D nightTex;
    varying vec3 vWorldNormal;
    const float PI = 3.141592653589793;
    void main() {
      vec3 n = normalize(vWorldNormal);
      float lat = asin(clamp(n.y, -1.0, 1.0));         // -PI/2 .. PI/2
      float theta = atan(n.z, n.x);                    // = (90 - lng) in rad
      float lng = (PI * 0.5) - theta;                  // radians
      float u = fract((lng / (2.0 * PI)) + 0.5);
      float v = (lat / PI) + 0.5;
      vec3 lights = texture2D(nightTex, vec2(u, v)).rgb;
      // The black-marble texture has faint dark-blue oceans; subtract a floor
      // to drop them to zero so only genuine city lights remain, then boost.
      lights = max(lights - 0.12, 0.0) * 2.8;
      float d = dot(n, normalize(sunDir));
      float night = smoothstep(0.12, -0.18, d);
      gl_FragColor = vec4(lights * night, 1.0);
    }
  `;

  const nightTex = new THREE.TextureLoader().load(IMG + "earth-night.jpg");
  nightTex.colorSpace = THREE.SRGBColorSpace;

  const dnShade = new THREE.Mesh(
    new THREE.SphereGeometry(GLOBE_R * 1.001, 64, 48),
    new THREE.ShaderMaterial({
      uniforms: { sunDir: sunUniform },
      vertexShader: DN_VERT,
      fragmentShader: SHADE_FRAG,
      side: THREE.FrontSide,
      transparent: true,
      depthWrite: false,
    })
  );
  const dnLights = new THREE.Mesh(
    new THREE.SphereGeometry(GLOBE_R * 1.0015, 64, 48),
    new THREE.ShaderMaterial({
      uniforms: { sunDir: sunUniform, nightTex: { value: nightTex } },
      vertexShader: DN_VERT,
      fragmentShader: LIGHTS_FRAG,
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    })
  );

  const dayNightGroup = new THREE.Group();
  dayNightGroup.add(dnShade);
  dayNightGroup.add(dnLights);

  function applyDayNight() {
    const scene = globe.scene();
    if (dayNightEl.checked) {
      sunUniform.value = sunDirection(); // refresh the terminator on enable
      if (!dayNightGroup.parent) scene.add(dayNightGroup);
    } else if (dayNightGroup.parent) {
      scene.remove(dayNightGroup);
    }
  }
  dayNightEl.addEventListener("change", applyDayNight);
  applyDayNight();


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

  // Clicking outside the Earth (empty space) TOGGLES auto-rotation. The check
  // is deferred so onGlobeClick (if any) has already run and set the flag.
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
        globe.controls().autoRotate = !globe.controls().autoRotate;
      }
      globeClicked = false;
    }, 0);
  });

  // A brand-new pick: red marker, ping sized to the current radius slider.
  function selectFresh(lat, lng) {
    selected = { lat, lng };
    globe.controls().autoRotate = false;
    activeRing = { lat, lng, radius_km: Number(radiusEl.value), rgb: "255,77,77" };
    // Force a brand-new selected-point object so it "pops up" at the new spot
    // instead of sliding from the previous one.
    selectedPt = null;
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
    activeRing = { lat: m.lat, lng: m.lon, radius_km: m.radius_km, rgb: "78,163,255" };
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
  // globe.gl re-runs the "rise" enter-animation for any point object whose
  // identity it hasn't seen before. To keep already-placed markers from
  // re-animating on every click, we reuse the SAME object per saved marker
  // (cached on `_pt`) and a single persistent object for the selected pick —
  // so only a genuinely new marker animates in.
  let selectedPt = null;
  function renderMarkers() {
    const pts = savedMarkers.map((m) => {
      if (!m._pt) m._pt = { lat: m.lat, lng: m.lon, kind: "saved", data: m };
      return m._pt;
    });
    if (selected) {
      if (!selectedPt) selectedPt = { kind: "selected" };
      selectedPt.lat = selected.lat;
      selectedPt.lng = selected.lng;
      pts.push(selectedPt);
    } else {
      selectedPt = null;
    }
    globe
      .pointsData(pts)
      .pointLat("lat")
      .pointLng("lng")
      .pointColor((d) => (d.kind === "selected" ? "#ff4d4d" : "#4ea3ff"))
      .pointAltitude(0.02)
      .pointRadius(0.18);
  }

  // Draw the ping ring for the active location, sized to its radius in km.
  // Only the active location pings; its color matches its marker (red for a
  // fresh pick, light blue for a saved place).
  function renderRing() {
    if (!activeRing) {
      globe.ringsData([]);
      return;
    }
    const maxDeg = Math.max(0.4, activeRing.radius_km / KM_PER_DEG);
    const rgb = activeRing.rgb || "78,163,255";
    globe
      .ringsData([{ lat: activeRing.lat, lng: activeRing.lng }])
      .ringLat("lat")
      .ringLng("lng")
      .ringColor(() => (t) => `rgba(${rgb},${1 - t})`)
      .ringMaxRadius(maxDeg)
      .ringPropagationSpeed(maxDeg * 0.5625)
      .ringRepeatPeriod(1200);
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

  // --- Country borders toggle ---------------------------------------------
  // Borders are drawn as PATHS (lines), not filled polygons. Polygons sit on
  // the globe as solid meshes that intercept the click raycaster, which
  // swallowed clicks over land (no pin, no ring). Path lines don't capture
  // pointer events, so onGlobeClick fires normally everywhere. The GeoJSON is
  // fetched once on first enable and cached as flat lat/lng line arrays.
  const BORDERS_URL =
    "https://unpkg.com/world-atlas@2.0.2/countries-110m.json";

  // Flatten a GeoJSON feature's Polygon/MultiPolygon rings into [lat, lng]
  // line arrays suitable for globe.gl's pathsData.
  function featureToPaths(feature) {
    const geom = feature.geometry;
    if (!geom) return [];
    const polys =
      geom.type === "Polygon" ? [geom.coordinates]
      : geom.type === "MultiPolygon" ? geom.coordinates
      : [];
    const paths = [];
    for (const poly of polys) {
      for (const ring of poly) {
        // GeoJSON stores [lng, lat]; paths default to [lat, lng].
        paths.push(ring.map(([lng, lat]) => [lat, lng]));
      }
    }
    return paths;
  }

  function renderBorders() {
    const data = bordersEl.checked ? borderFeatures : [];
    globe
      .pathsData(data)
      .pathColor(() => "rgba(120,180,255,0.55)")
      .pathStroke(0.6)
      .pathPointAlt(0.004)
      .pathTransitionDuration(0);
  }

  async function loadBorders() {
    if (borderFeatures.length) { renderBorders(); return; }
    try {
      const res = await fetch(BORDERS_URL);
      if (!res.ok) return;
      const topology = await res.json();
      // world-atlas ships TopoJSON; convert via the topojson-client global.
      const features =
        topojson.feature(topology, topology.objects.countries).features;
      borderFeatures = features.flatMap(featureToPaths);
      renderBorders();
    } catch (_) { /* offline — leave borders off */ }
  }

  bordersEl.addEventListener("change", () => {
    if (bordersEl.checked) loadBorders();
    else renderBorders();
  });

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

    rTitle.textContent = d.location_title
      ? d.location_title
      : (d.place_summary ? truncate(d.place_summary, 60) : "Results");
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
