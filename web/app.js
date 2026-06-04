/* BlueDot Atlas — Globe.gl frontend (Step 3).
 *
 * Renders a clickable 3D globe. Clicking drops a marker, the user picks a
 * layer + radius, and "Explore" calls the FastAPI /query endpoint and renders
 * the validated results in a side panel.
 */

import Globe from "globe.gl";
import * as THREE from "three";
import * as solar from "https://esm.sh/solar-calculator@0.3";

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
  const cloudsEl = document.getElementById("clouds");
  const aurorasEl = document.getElementById("auroras");
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
      // The tile engine paints over the globe surface, which would hide the
      // day/night shader material. They can't both own the surface, so turning
      // on HD turns off day/night.
      if (dayNightEl.checked) {
        dayNightEl.checked = false;
        applyDayNight();
      }
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
    #define PI 3.141592653589793
    uniform vec3 glowColor;
    uniform float base;
    uniform float power;
    uniform float fade;
    uniform float intensity;
    uniform vec2 sunPosition;
    uniform vec2 globeRotation;
    uniform float sunFade;
    uniform float gaussian;
    uniform float peak;
    uniform float width;
    varying vec3 vNormal;
    varying vec3 vViewPosition;

    float toRad(in float a) { return a * PI / 180.0; }
    vec3 Polar2Cartesian(in vec2 c) { // [lng, lat]
      float theta = toRad(90.0 - c.x);
      float phi = toRad(90.0 - c.y);
      return vec3(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
    }

    void main() {
      vec3 viewDir = normalize(vViewPosition);
      // facing ~1 looking straight at the surface, ~0 at the grazing limb.
      float facing = clamp(dot(vNormal, viewDir), 0.0, 1.0);
      float d = 1.0 - facing; // 0 at the disc centre, 1 at the silhouette.
      float glow;
      if (gaussian > 0.5) {
        // Gaussian altitude band: glow ramps UP with altitude (toward the
        // limb), peaks at the peak uniform, then ramps back down -- a soft
        // shell of light floating above the surface, not a surface gradient.
        float g = exp(-pow((d - peak) / width, 2.0));
        glow = g * intensity;
      } else {
        // rise: even haze (base) plus a swell toward the limb.
        // pow(facing, fade) pulls the glow back to zero right at the silhouette
        // so the outer halo has no hard ring — it dissolves into space.
        float rise = base + (1.0 - base) * pow(d, power);
        glow = rise * pow(facing, fade) * intensity;
      }

      // Sun-aware fade: the halo is brightest on the sunlit hemisphere and
      // fades toward the night side. Compute the sun direction in view space
      // the same way the day/night surface shader does, then dot with the
      // shell normal.
      float invLon = toRad(globeRotation.x);
      float invLat = -toRad(globeRotation.y);
      mat3 rotX = mat3(1.0, 0.0, 0.0, 0.0, cos(invLat), -sin(invLat), 0.0, sin(invLat), cos(invLat));
      mat3 rotY = mat3(cos(invLon), 0.0, sin(invLon), 0.0, 1.0, 0.0, -sin(invLon), 0.0, cos(invLon));
      vec3 sunDir = normalize(rotX * rotY * Polar2Cartesian(sunPosition));
      float sun = dot(normalize(vNormal), sunDir);
      // 0.18 ambient so the dark limb keeps a faint trace instead of vanishing.
      float dayFade = mix(0.18, 1.0, smoothstep(-0.75, 0.25, sun));
      // sunFade (0..1) blends between an even halo and the sun-aware fade, so
      // the day-side-only halo is active only when day/night is enabled.
      glow *= mix(1.0, dayFade, sunFade);

      // Sunset tint: warm the halo toward red along the terminator (twilight
      // band), peaking where day meets night. Only when day/night is on.
      // Centre is biased onto the NIGHT side (sun < 0) so the orange sits just
      // past the terminator into dusk rather than straddling it evenly.
      vec3 col = glowColor;
      // Orange tint covers the whole NIGHT hemisphere, ramping up from the
      // terminator and staying full across the dark side. Only when day/night.
      float twilight = (1.0 - smoothstep(0.0, 0.55, abs(sun + 0.28))) * sunFade;
      col = mix(col, vec3(1.0, 0.34, 0.1), twilight * 0.9);

      gl_FragColor = vec4(col * glow, glow);
    }
  `;

  function makeShell(radiusScale, side, { base, power, fade, intensity, gaussian = false, peak = 0.5, width = 0.25 }) {
    const geom = new THREE.SphereGeometry(GLOBE_R * radiusScale, 64, 48);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color("#a9ccff") },
        base: { value: base },
        power: { value: power },
        fade: { value: fade },
        intensity: { value: intensity },
        sunPosition: { value: new THREE.Vector2() },
        globeRotation: { value: new THREE.Vector2() },
        sunFade: { value: 0.0 },
        gaussian: { value: gaussian ? 1.0 : 0.0 },
        peak: { value: peak },
        width: { value: width },
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
  const atmoInner = makeShell(1.02, THREE.FrontSide, {
    base: 0.05, power: 2.0, fade: 0.5, intensity: 1.4,
  });

  const atmoGroup = new THREE.Group();
  atmoGroup.add(atmoInner);

  function applyAtmosphere() {
    const scene = globe.scene();
    if (atmosphereEl.checked) {
      if (!atmoGroup.parent) scene.add(atmoGroup);
      if (atmoRaf === null) atmoTick();
    } else if (atmoGroup.parent) {
      scene.remove(atmoGroup);
      if (atmoRaf !== null) {
        cancelAnimationFrame(atmoRaf);
        atmoRaf = null;
      }
    }
  }
  let atmoRaf = null;
  function atmoTick() {
    const sun = sunPosAt(Date.now());
    const pov = globe.pointOfView();
    const sunFade = dayNightEl.checked ? 1.0 : 0.0;
    for (const mesh of [atmoInner]) {
      const u = mesh.material.uniforms;
      u.sunPosition.value.set(sun[0], sun[1]);
      u.globeRotation.value.set(pov.lng, pov.lat);
      u.sunFade.value = sunFade;
    }
    atmoRaf = requestAnimationFrame(atmoTick);
  }
  atmosphereEl.addEventListener("change", applyAtmosphere);
  applyAtmosphere();

  // --- Realism: day / night + city lights --------------------------------
  // The robust, official globe.gl technique: replace the globe's OWN surface
  // material with a shader that mixes a daytime map and the NASA night-lights
  // map across the terminator. Because it IS the globe surface (not an overlay
  // sphere), there is no z-fighting, the texture UVs line up perfectly, and the
  // night side shows city lights at full brightness with no dimming veil.
  //
  // sunPosition is the real sub-solar [lng, lat] for the current time (via
  // solar-calculator). globeRotation carries the current point-of-view so the
  // shader can bring the world-space sun direction into the globe's view frame.
  const baseMaterial = globe.globeMaterial();

  const DN_VERT = `
    varying vec3 vNormal;
    varying vec2 vUv;
    void main() {
      vNormal = normalize(normalMatrix * normal);
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  const DN_FRAG = `
    #define PI 3.141592653589793
    uniform sampler2D dayTexture;
    uniform sampler2D nightTexture;
    uniform vec2 sunPosition;
    uniform vec2 globeRotation;
    varying vec3 vNormal;
    varying vec2 vUv;

    float toRad(in float a) { return a * PI / 180.0; }

    vec3 Polar2Cartesian(in vec2 c) { // [lng, lat]
      float theta = toRad(90.0 - c.x);
      float phi = toRad(90.0 - c.y);
      return vec3(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
    }

    void main() {
      float invLon = toRad(globeRotation.x);
      float invLat = -toRad(globeRotation.y);
      mat3 rotX = mat3(
        1, 0, 0,
        0, cos(invLat), -sin(invLat),
        0, sin(invLat), cos(invLat)
      );
      mat3 rotY = mat3(
        cos(invLon), 0, sin(invLon),
        0, 1, 0,
        -sin(invLon), 0, cos(invLon)
      );
      vec3 sunDir = rotX * rotY * Polar2Cartesian(sunPosition);
      float intensity = dot(normalize(vNormal), normalize(sunDir));
      vec4 dayColor = texture2D(dayTexture, vUv);
      vec4 nightColor = texture2D(nightTexture, vUv);

      // Night side: a DIM, desaturated version of the day map so the planet is
      // still visible (continents/oceans readable) but low-contrast, so bright
      // deserts like the Sahara don't blaze. Then add the NASA "black marble"
      // night texture on top — it is real city-lights DATA (black everywhere
      // except cities), so the glow lands exactly on populated areas. No
      // luminance-thresholding of the day map, so snow/desert never glow.
      float dayLum = dot(dayColor.rgb, vec3(0.299, 0.587, 0.114));
      // The night texture isn't pure black marble: its land/ocean is a dim
      // teal-blue, while the real city lights are bright neutral/warm pixels.
      // Cities are red-rich; land/ocean are blue-dominant and dark. Use the red
      // channel to keep ONLY the real city-light data and make the rest black.
      float light = smoothstep(0.08, 0.30, nightColor.r);
      // Warm, bright city lights (amber tint), boosted.
      vec3 cityLights = nightColor.rgb * vec3(1.0, 0.85, 0.62) * light * 2.4;
      // Only fade the city lights in once we're past twilight (well into the
      // dark side), so they aren't blazing along the terminator.
      float nightDepth = smoothstep(0.0, -0.25, intensity);
      cityLights *= nightDepth;
      // Faint dim earth so the dark side is still visible, not pure black.
      // Keep a good amount of the day map's color (not full grayscale). A small
      // gamma >1 adds contrast (darkens the mid/low tones) before scaling down,
      // so the night ground is a touch darker without touching city lights.
      vec3 tint = mix(vec3(dayLum), dayColor.rgb, 0.6);
      vec3 duskEarth = pow(tint, vec3(1.5)) * 0.22;
      vec3 nightCol = duskEarth + cityLights;

      float blend = smoothstep(-0.1, 0.1, intensity);
      vec3 surface = mix(nightCol, dayColor.rgb, blend);

      gl_FragColor = vec4(surface, 1.0);
    }
  `;

  const texLoader = new THREE.TextureLoader();
  // Day side uses the same Blue Marble map as the rest of the app (the one the
  // user liked), so toggling day/night keeps the surface looking consistent.
  // NOTE: do NOT set texture colorSpace here. A raw ShaderMaterial writes its
  // output straight to the canvas with no colour re-encoding, so decoding the
  // textures to linear would make the whole globe look dark.
  const dayTex = texLoader.load(TEX_BASE);
  const nightTex = texLoader.load(IMG + "earth-night.jpg");

  const dayNightMaterial = new THREE.ShaderMaterial({
    uniforms: {
      dayTexture: { value: dayTex },
      nightTexture: { value: nightTex },
      sunPosition: { value: new THREE.Vector2() },
      globeRotation: { value: new THREE.Vector2() },
    },
    vertexShader: DN_VERT,
    fragmentShader: DN_FRAG,
  });

  // Sub-solar point [lng, lat] for a given instant.
  function sunPosAt(dt) {
    const day = new Date(+dt).setUTCHours(0, 0, 0, 0);
    const t = solar.century(dt);
    const lng = ((day - dt) / 864e5) * 360 - 180;
    return [lng - solar.equationOfTime(t) / 4, solar.declination(t)];
  }

  let dayNightRaf = null;
  function dayNightTick() {
    const u = dayNightMaterial.uniforms;
    u.sunPosition.value.set(...sunPosAt(Date.now()));
    const pov = globe.pointOfView();
    u.globeRotation.value.set(pov.lng, pov.lat);
    dayNightRaf = requestAnimationFrame(dayNightTick);
  }

  function applyDayNight() {
    if (dayNightEl.checked) {
      // Day/night owns the globe surface material; the HD tile engine would
      // paint over it, so enabling day/night turns off HD.
      if (hdMapEl.checked) {
        hdMapEl.checked = false;
        globe.globeTileEngineUrl(null);
      }
      globe.globeMaterial(dayNightMaterial);
      if (dayNightRaf === null) dayNightTick();
    } else {
      if (dayNightRaf !== null) {
        cancelAnimationFrame(dayNightRaf);
        dayNightRaf = null;
      }
      globe.globeMaterial(baseMaterial);
      applyHdMap(); // restore the correct base/tile surface state
    }
  }
  dayNightEl.addEventListener("change", applyDayNight);
  applyDayNight();

  // --- Realism: clouds ----------------------------------------------------
  // A translucent sphere just above the surface wrapped in a live cloud map
  // (white clouds on transparent). It sits in the same world frame as the
  // globe surface, so it stays locked to the Earth (the auto-rotate orbits the
  // camera, not the surface). The texture's brightness drives its own alpha,
  // so the clear sky is see-through and only the clouds show.
  const CLOUDS_IMG = "https://clouds.matteason.co.uk/images/4096x2048/clouds.jpg";
  const CLOUDS_FALLBACK = "https://unpkg.com/three-globe@2.31.0/example/img/clouds/clouds.png";
  let cloudMesh = null;
  let cloudRaf = null;

  const CLOUD_VERT = `
    varying vec3 vNormal;
    varying vec2 vUv;
    void main() {
      vNormal = normalize(normalMatrix * normal);
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  const CLOUD_FRAG = `
    #define PI 3.141592653589793
    uniform sampler2D cloudTexture;
    uniform float opacity;
    uniform vec2 sunPosition;
    uniform vec2 globeRotation;
    uniform float sunFade;
    varying vec3 vNormal;
    varying vec2 vUv;

    float toRad(in float a) { return a * PI / 180.0; }
    vec3 Polar2Cartesian(in vec2 c) {
      float theta = toRad(90.0 - c.x);
      float phi = toRad(90.0 - c.y);
      return vec3(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
    }

    void main() {
      vec4 tex = texture2D(cloudTexture, vUv);
      float a = tex.r * opacity; // white clouds -> opaque, black sky -> clear

      // Sun-aware shading: dim the clouds on the night side (only when
      // day/night is on, via sunFade).
      float invLon = toRad(globeRotation.x);
      float invLat = -toRad(globeRotation.y);
      mat3 rotX = mat3(1.0, 0.0, 0.0, 0.0, cos(invLat), -sin(invLat), 0.0, sin(invLat), cos(invLat));
      mat3 rotY = mat3(cos(invLon), 0.0, sin(invLon), 0.0, 1.0, 0.0, -sin(invLon), 0.0, cos(invLon));
      vec3 sunDir = normalize(rotX * rotY * Polar2Cartesian(sunPosition));
      float sun = dot(normalize(vNormal), sunDir);
      // 0.08 floor so night clouds are dark but faintly visible.
      float lit = mix(0.08, 1.0, smoothstep(-0.2, 0.25, sun));
      float shade = mix(1.0, lit, sunFade);

      vec3 col = vec3(shade);

      gl_FragColor = vec4(col, a);
    }
  `;

  function buildClouds() {
    if (cloudMesh) return;
    const geom = new THREE.SphereGeometry(GLOBE_R * 1.012, 64, 48);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        cloudTexture: { value: null },
        opacity: { value: 0.85 },
        sunPosition: { value: new THREE.Vector2() },
        globeRotation: { value: new THREE.Vector2() },
        sunFade: { value: 0.0 },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
    });
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    const apply = (tex) => {
      mat.uniforms.cloudTexture.value = tex;
      mat.needsUpdate = true;
    };
    loader.load(CLOUDS_IMG, apply, undefined, () =>
      loader.load(CLOUDS_FALLBACK, apply)
    );
    cloudMesh = new THREE.Mesh(geom, mat);
  }

  function cloudTick() {
    if (cloudMesh) {
      const u = cloudMesh.material.uniforms;
      u.sunPosition.value.set(...sunPosAt(Date.now()));
      const pov = globe.pointOfView();
      u.globeRotation.value.set(pov.lng, pov.lat);
      u.sunFade.value = dayNightEl.checked ? 1.0 : 0.0;
    }
    cloudRaf = requestAnimationFrame(cloudTick);
  }

  function applyClouds() {
    const scene = globe.scene();
    if (cloudsEl.checked) {
      buildClouds();
      if (!cloudMesh.parent) scene.add(cloudMesh);
      if (cloudRaf === null) cloudTick();
    } else if (cloudMesh && cloudMesh.parent) {
      scene.remove(cloudMesh);
      if (cloudRaf !== null) {
        cancelAnimationFrame(cloudRaf);
        cloudRaf = null;
      }
    }
  }
  cloudsEl.addEventListener("change", applyClouds);
  applyClouds();

  // --- Realism: auroras ---------------------------------------------------
  // Glowing curtains of light standing UP from the auroral ovals near each
  // pole. Each oval is a cone-frustum "wall" rising radially off the surface
  // (built from an open cylinder whose ends follow radial lines from the
  // globe centre). The shader paints vertical green->magenta streaks that
  // drift and shimmer with time, brightest near the surface and fading as the
  // curtain rises, and only visible on the night side.
  // The aurora is a genuine 3D VOLUME, not a sheet. A bounding sphere is drawn
  // and the fragment shader RAYMARCHES through the auroral shell, sampling an
  // emissive density field that has real extent in all three directions:
  //  - radially (altitude, ~the height of the curtains),
  //  - across-track (a band of finite width in colatitude), and
  //  - along-track (drifting vertical streaks in longitude).
  // Because we integrate emission along the view ray through that field, the
  // aurora has actual depth from EVERY angle — head-on you look through the
  // full thickness of the band, edge-on you see the curtains stand up. There
  // are no flat planes anywhere.
  const AURORA_VERT = `
    varying vec3 vWorldPos;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;
  const AURORA_FRAG = `
    #define PI 3.141592653589793
    #define GLOBE_R 100.0
    #define A_BASE 1.0      // inner radius of the shell = GLOBE_R + A_BASE
    #define A_HEIGHT 14.0   // radial thickness of the shell (curtain height)
    #define STEPS 48
    uniform float time;
    uniform vec2 sunPosition;
    uniform vec2 globeRotation;
    uniform float sunFade;
    varying vec3 vWorldPos;

    float toRad(in float a) { return a * PI / 180.0; }
    vec3 Polar2Cartesian(in vec2 c) {
      float theta = toRad(90.0 - c.x);
      float phi = toRad(90.0 - c.y);
      return vec3(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
    }
    float hash(float n) { return fract(sin(n) * 43758.5453123); }
    float noise(in vec2 p) {
      vec2 i = floor(p); vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i.x + i.y * 57.0);
      float b = hash(i.x + 1.0 + i.y * 57.0);
      float c = hash(i.x + (i.y + 1.0) * 57.0);
      float d = hash(i.x + 1.0 + (i.y + 1.0) * 57.0);
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    // Ray vs sphere centred at the origin. Returns the two hit distances
    // (near, far) along rd, or vec2(-1.0) when the ray misses.
    vec2 raySphere(vec3 ro, vec3 rd, float rad) {
      float b = dot(ro, rd);
      float c = dot(ro, ro) - rad * rad;
      float h = b * b - c;
      if (h < 0.0) return vec2(-1.0);
      h = sqrt(h);
      return vec2(-b - h, -b + h);
    }

    // Emissive density of the auroral medium at a point p (globe space).
    // Non-zero only inside a band of finite width around each polar oval, and
    // only between the inner and outer shell radii. This finite across-track
    // width is what gives the aurora real thickness when viewed head-on.
    float density(vec3 p, out float up) {
      float r = length(p);
      up = (r - (GLOBE_R + A_BASE)) / A_HEIGHT;   // 0 at base, 1 at top
      if (up < 0.0 || up > 1.0) return 0.0;
      vec3 d = p / r;
      float colat = acos(clamp(d.y, -1.0, 1.0));   // 0 at N pole, PI at S
      float lon = atan(d.z, d.x);

      // Strong, low-frequency meander of the oval centre so the whole ribbon
      // SNAKES around the pole instead of sitting on a fixed circle. Amplitude
      // is comparable to the band width, so the band visibly waves in and out.
      float snake = 0.06 * sin(lon * 2.0 + time * 0.22)
                  + 0.038 * sin(lon * 3.0 - time * 0.16)
                  + 0.02 * sin(lon * 5.0 + time * 0.32);
      // WIDTH varies along the ribbon and over time, so some stretches bulge
      // out wider while others pinch in narrow.
      float wN = noise(vec2(lon * 0.9 + 30.0, time * 0.04));
      wN += 0.5 * noise(vec2(lon * 2.3 - 6.0, time * 0.07));
      wN /= 1.5;
      float sigma = toRad(mix(1.2, 3.2, smoothstep(0.25, 0.8, wN)));  // half-width

      // PRIMARY oval.
      float cN = toRad(23.0) + snake;
      float cS = toRad(157.0) + snake;
      float band = exp(-pow((colat - cN) / sigma, 2.0))
                 + exp(-pow((colat - cS) / sigma, 2.0));

      // SECONDARY oval — a second ring whose latitude separation from the main
      // oval slowly breathes in and out. When the separation goes to ~0 the two
      // rings COMBINE into one; when it grows they SPLIT into two clear rings.
      float snake2 = 0.05 * sin(lon * 1.0 - time * 0.17)
                   + 0.03 * sin(lon * 4.0 + time * 0.11);
      // Separation swings from nearly coincident up to a wide split.
      float sep = 0.5 + 0.5 * sin(time * 0.06);            // 0..1 breathing
      float off = toRad(0.4) + toRad(5.5) * sep;
      float cN2 = toRad(23.0) + off + snake2;
      float cS2 = toRad(157.0) - off + snake2;
      // Ring 2 is mostly present, but still patchy so it can be partial arcs.
      float g2 = noise(vec2(lon * 1.3 + 5.0, time * 0.05));
      float amp2 = mix(0.55, 1.0, smoothstep(0.25, 0.8, g2));
      float band2 = exp(-pow((colat - cN2) / sigma, 2.0))
                  + exp(-pow((colat - cS2) / sigma, 2.0));
      band = max(band, band2 * amp2);

      // WANDERING ARC — an extra open ribbon that occasionally snakes through
      // the polar region at its own drifting latitude and meander, NOT tied to
      // the main oval and not required to cross the pole. It fades in and out,
      // so now and then a loose arc wanders across the cap instead of the
      // aurora being one clean circle.
      float arcLat = toRad(mix(14.0, 30.0, 0.5 + 0.5 * sin(time * 0.05)));
      float arcSnake = 0.10 * sin(lon * 1.5 + time * 0.25)
                     + 0.06 * sin(lon * 2.5 - time * 0.18)
                     + 0.04 * sin(lon * 4.0 + time * 0.33);
      float arcCN = arcLat + arcSnake;
      float arcCS = (PI - arcLat) + arcSnake;
      float arcSig = toRad(2.0);
      float arcBand = exp(-pow((colat - arcCN) / arcSig, 2.0))
                    + exp(-pow((colat - arcCS) / arcSig, 2.0));
      // Only present over a slowly moving stretch of longitude, and pulsing in
      // and out over time, so it's an occasional partial arc.
      float arcWhere = noise(vec2(lon * 0.7 - 9.0, time * 0.04));
      float arcLife = noise(vec2(21.0, time * 0.05));
      float arcAmp = smoothstep(0.45, 0.75, arcWhere) * smoothstep(0.5, 0.8, arcLife);
      band = max(band, arcBand * arcAmp);

      if (band < 0.01) return 0.0;

      // Soft brightness variation ALONG the ribbon (longitude) — broad, low
      // contrast swells rather than hard blades, so it no longer looks sliced.
      // The flow follows the ribbon as it snakes (lon offset by the meander).
      float flow = lon * 6.0 + snake * 8.0;
      float n = noise(vec2(flow, time * 0.13 + up * 0.4));
      n += 0.5 * noise(vec2(flow * 2.1 + 11.0, time * 0.22));
      n /= 1.5;
      float streak = mix(0.6, 1.0, smoothstep(0.2, 0.9, n));

      // TRANSIENT STREAKS — narrow bright rays that flare up and fade out at
      // random spots along the ribbon. A high-frequency longitude pattern is
      // gated by a fast-moving time window so individual rays pop in and out.
      float ray = noise(vec2(lon * 28.0 + 3.0, up * 1.5));
      float rayLife = noise(vec2(lon * 4.0 - 12.0, time * 0.6));   // fast flicker
      float rays = smoothstep(0.62, 0.95, ray) * smoothstep(0.5, 0.9, rayLife);
      streak += rays * 0.9;

      // BREAKS — a slow large-scale mask along longitude that can pull the
      // ribbon apart into separate arcs and then heal it back together, so the
      // ring isn't always closed. Gaps open and migrate over time.
      float gmask = noise(vec2(lon * 0.8 + 20.0, time * 0.045));
      gmask += 0.5 * noise(vec2(lon * 1.7 - 7.0, time * 0.08));
      gmask /= 1.5;
      float gap = smoothstep(0.22, 0.42, gmask);   // 0 = broken, 1 = present
      streak *= gap;

      // THICKNESS TRANSIENTS — the curtain is taller (thicker) in some places,
      // and those thick zones TRAVEL along the ribbon like a wave. A base slow
      // field gives stationary thick/thin stretches; a second term moves at a
      // steady speed in longitude so bulges of thickness propagate along it.
      float tBase = noise(vec2(lon * 1.1 + 17.0, time * 0.05));
      float tWave = noise(vec2(lon * 2.6 - time * 0.9, 41.0));  // travels in lon
      float thick = mix(tBase, tWave, 0.5);
      float topH = mix(0.45, 1.0, smoothstep(0.25, 0.85, thick));  // curtain top

      // Brightest near the surface, fading up the curtain — capped at topH so
      // the curtain height (thickness) varies and the thick zones travel.
      float vfade = smoothstep(0.0, 0.05, up) * smoothstep(topH, topH * 0.35, up);
      return band * streak * vfade;
    }

    void main() {
      vec3 ro = cameraPosition;             // ray origin (globe space ~ world)
      vec3 rd = normalize(vWorldPos - ro);  // view ray direction

      // Entry/exit of the outer bounding shell.
      vec2 outer = raySphere(ro, rd, GLOBE_R + A_BASE + A_HEIGHT);
      if (outer.y < 0.0) discard;
      float tStart = max(outer.x, 0.0);
      float tEnd = outer.y;
      // Stop the march at the near surface of the solid Earth so the far-side
      // oval is correctly hidden behind the globe.
      vec2 solid = raySphere(ro, rd, GLOBE_R + A_BASE);
      if (solid.x > 0.0) tEnd = min(tEnd, solid.x);
      if (tEnd <= tStart) discard;

      vec3 green = vec3(0.15, 1.0, 0.5);
      vec3 magenta = vec3(0.75, 0.2, 1.0);
      vec3 red = vec3(1.0, 0.15, 0.25);

      float dt = (tEnd - tStart) / float(STEPS);
      vec3 acc = vec3(0.0);
      for (int i = 0; i < STEPS; i++) {
        float t = tStart + (float(i) + 0.5) * dt;
        vec3 p = ro + rd * t;
        float up;
        float dens = density(p, up);
        if (dens <= 0.0) continue;
        vec3 col = mix(green, magenta, smoothstep(0.25, 1.0, up));

        // High-altitude red oxygen glow during especially intense activity.
        // "act" is a slow, patchy storm-intensity field around the pole; where
        // it's high AND we're in the upper part of the curtain, the colour
        // shifts toward red — the classic SAR / strong-storm red tops.
        vec3 dir = normalize(p);
        float lon = atan(dir.z, dir.x);
        float act = noise(vec2(lon * 0.7 - 3.0, time * 0.03));
        act += 0.5 * noise(vec2(lon * 1.5 + 9.0, time * 0.05));
        act /= 1.5;
        float storm = smoothstep(0.45, 0.7, act);    // patchy intense regions
        // Red builds through the upper half of the curtain; gate opens low
        // enough that the still-dense part of the curtain reddens.
        float redMix = storm * smoothstep(0.1, 0.45, up);
        col = mix(col, red, redMix);
        // Intense red patches also glow a bit brighter (oxygen line).
        dens *= 1.0 + 0.8 * redMix;

        acc += col * dens;
      }
      acc *= dt * 0.05;   // integrate; scale to taste
      float lum = max(acc.r, max(acc.g, acc.b));
      if (lum <= 0.001) discard;
      gl_FragColor = vec4(acc, lum);
    }
  `;

  let auroraGroup = null;
  let auroraRaf = null;
  const auroraMats = [];

  // Build the aurora volume: a single bounding sphere just larger than the
  // auroral shell. The raymarching fragment shader does all the work, so this
  // is the only mesh needed — the depth comes from integrating through the
  // density field, not from stacking geometry.
  function buildAuroras() {
    if (auroraGroup) return;
    auroraGroup = new THREE.Group();
    const R = GLOBE_R + 1.0 + 22.0 + 0.5;   // matches A_BASE + A_HEIGHT in frag
    const geom = new THREE.SphereGeometry(R, 64, 48);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        sunPosition: { value: new THREE.Vector2() },
        globeRotation: { value: new THREE.Vector2() },
        sunFade: { value: 0.0 },
      },
      vertexShader: AURORA_VERT,
      fragmentShader: AURORA_FRAG,
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    auroraMats.push(mat);
    auroraGroup.add(new THREE.Mesh(geom, mat));
  }

  function auroraTick() {
    const t = performance.now() / 1000;
    const sun = sunPosAt(Date.now());
    const pov = globe.pointOfView();
    const sunFade = dayNightEl.checked ? 1.0 : 0.0;
    for (const mat of auroraMats) {
      const u = mat.uniforms;
      u.time.value = t;
      u.sunPosition.value.set(sun[0], sun[1]);
      u.globeRotation.value.set(pov.lng, pov.lat);
      u.sunFade.value = sunFade;
    }
    auroraRaf = requestAnimationFrame(auroraTick);
  }

  function applyAuroras() {
    const scene = globe.scene();
    if (aurorasEl.checked) {
      buildAuroras();
      if (!auroraGroup.parent) scene.add(auroraGroup);
      if (auroraRaf === null) auroraTick();
    } else if (auroraGroup && auroraGroup.parent) {
      scene.remove(auroraGroup);
      if (auroraRaf !== null) {
        cancelAnimationFrame(auroraRaf);
        auroraRaf = null;
      }
    }
  }
  aurorasEl.addEventListener("change", applyAuroras);
  applyAuroras();


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
      .pathColor(() => "rgba(200,200,200,0.55)")
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
