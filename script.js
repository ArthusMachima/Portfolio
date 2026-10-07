(() => {
    const BAR_W = 2, GAP = 1, STEP = BAR_W + GAP, PEAK_RES = 600;

    const TEMPLATE = `
    <div class="mp-top">
      <button class="mp-play" aria-label="Play">
        <svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
        <svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>
      </button>
      <div class="mp-meta">
        <div class="mp-title"></div>
        <div class="mp-status">Loading…</div>
      </div>
    </div>
    <div class="mp-wave" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <canvas></canvas>
      <span class="mp-chip mp-cur">0:00</span>
      <span class="mp-chip mp-dur">0:00</span>
    </div>
    <audio preload="metadata"></audio>`;

    const fmt = (s) => {
        s = Math.max(0, Math.floor(s || 0));
        return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    };

    // One shared AudioContext for decoding (browsers limit how many can exist)
    let sharedCtx;
    const getCtx = () => (sharedCtx ||= new (window.AudioContext || window.webkitAudioContext)());

    function peaksFromBuffer(buf) {
        const out = new Float32Array(PEAK_RES);
        const len = buf.length, seg = len / PEAK_RES;
        for (let c = 0; c < buf.numberOfChannels; c++) {
            const data = buf.getChannelData(c);
            for (let i = 0; i < PEAK_RES; i++) {
                const start = Math.floor(i * seg), end = Math.min(len, Math.floor((i + 1) * seg));
                const stride = Math.max(1, Math.floor((end - start) / 200));
                let m = 0;
                for (let j = start; j < end; j += stride) {
                    const v = Math.abs(data[j]);
                    if (v > m) m = v;
                }
                if (m > out[i]) out[i] = m;
            }
        }
        let max = 0;
        for (const v of out) if (v > max) max = v;
        return out.map((v) => Math.pow(v / (max || 1), 0.85));
    }

    // Fallback when the audio can't be decoded (e.g. host blocks cross-origin requests)
    function fakePeaks(seed) {
        let s = seed;
        const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
        const out = new Float32Array(PEAK_RES);
        for (let i = 0; i < PEAK_RES; i++) {
            const t = i / PEAK_RES;
            const env = 0.55 + 0.25 * Math.sin(t * 9) + 0.15 * Math.sin(t * 23 + 1);
            out[i] = Math.min(1, Math.max(0.08, env * (0.6 + rnd() * 0.5)));
        }
        return out;
    }

    let uid = 0;

    function createPlayer(root, { src, artist = "", title = "" }) {
        root.innerHTML = TEMPLATE;
        const q = (s) => root.querySelector(s);
        const audio = q("audio"), canvas = q("canvas"), ctx = canvas.getContext("2d");
        const wave = q(".mp-wave"), curEl = q(".mp-cur"), durEl = q(".mp-dur"), statusEl = q(".mp-status");
        const playBtn = q(".mp-play");
        const seed = 7 + 13 * ++uid;

        q(".mp-title").textContent = [artist, title].filter(Boolean).join(" - ");
        audio.src = src;

        let peaks = null, duration = 0, seeking = false, seekFrac = 0, hoverFrac = null, raf = 0;

        const getDuration = () => (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration);
        const setStatus = (msg, err) => { statusEl.textContent = msg; statusEl.classList.toggle("err", !!err); };

        function draw() {
            const w = wave.clientWidth, h = wave.clientHeight, dpr = window.devicePixelRatio || 1;
            if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
                canvas.width = Math.round(w * dpr);
                canvas.height = Math.round(h * dpr);
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            const n = Math.max(1, Math.floor((w + GAP) / STEP));
            const base = Math.round(h * 0.68);
            const dur = getDuration();
            const prog = seeking ? seekFrac : (dur ? audio.currentTime / dur : 0);

            for (let i = 0; i < n; i++) {
                let p = 0.12;
                if (peaks) {
                    const a = Math.floor((i / n) * PEAK_RES), b = Math.max(a + 1, Math.floor(((i + 1) / n) * PEAK_RES));
                    p = 0;
                    for (let k = a; k < b; k++) if (peaks[k] > p) p = peaks[k];
                }
                const frac = (i + 0.5) / n;
                let color = "#6d6d6d";
                if (frac <= prog) color = "#f1f3ff";
                else if (hoverFrac !== null && frac <= hoverFrac) color = "#a0a0a0";

                const x = i * STEP;
                const up = Math.max(2, Math.round(p * (base - 2)));
                const down = Math.max(1, Math.round(p * (h - base - 2) * 0.9));
                ctx.globalAlpha = 1;
                ctx.fillStyle = color;
                ctx.fillRect(x, base - up, BAR_W, up);
                ctx.globalAlpha = 0.45;
                ctx.fillRect(x, base + 1, BAR_W, down);
            }
            ctx.globalAlpha = 1;
        }

        function updateTimes() {
            const dur = getDuration();
            const t = seeking ? seekFrac * dur : audio.currentTime;
            curEl.textContent = fmt(t);
            durEl.textContent = fmt(dur);
            wave.setAttribute("aria-valuenow", dur ? Math.round((t / dur) * 100) : 0);
            wave.setAttribute("aria-valuetext", fmt(t) + " of " + fmt(dur));
        }

        const refresh = () => { updateTimes(); draw(); };
        function tick() {
            refresh();
            if (!audio.paused) raf = requestAnimationFrame(tick);
        }

        async function loadPeaks() {
            try {
                const res = await fetch(src);
                if (!res.ok) throw new Error("HTTP " + res.status);
                const arr = await res.arrayBuffer();
                const buf = await new Promise((ok, no) => getCtx().decodeAudioData(arr, ok, no));
                duration = buf.duration;
                peaks = peaksFromBuffer(buf);
                setStatus("");
            } catch (e) {
                console.warn("Waveform: couldn't decode audio, showing approximate shape.", e);
                peaks = fakePeaks(seed);
                setStatus("Approximate waveform (audio host blocks decoding)");
            }
            refresh();
        }

        // Playback
        playBtn.addEventListener("click", () => {
            if (audio.paused) audio.play().catch((e) => setStatus("Couldn't play: " + e.message, true));
            else audio.pause();
        });
        audio.addEventListener("play", () => {
            // Only one player at a time
            document.querySelectorAll("audio").forEach((a) => { if (a !== audio) a.pause(); });
            root.classList.add("is-playing");
            playBtn.setAttribute("aria-label", "Pause");
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(tick);
        });
        audio.addEventListener("pause", () => {
            root.classList.remove("is-playing");
            playBtn.setAttribute("aria-label", "Play");
            refresh();
        });
        audio.addEventListener("ended", () => { audio.currentTime = 0; refresh(); });
        audio.addEventListener("loadedmetadata", refresh);
        audio.addEventListener("seeked", refresh);
        audio.addEventListener("error", () => setStatus("Can't load audio. Check the src.", true));

        // Seeking
        const fracAt = (e) => {
            const r = wave.getBoundingClientRect();
            return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        };
        wave.addEventListener("pointerdown", (e) => {
            if (!getDuration()) return;
            seeking = true; seekFrac = fracAt(e);
            wave.setPointerCapture(e.pointerId);
            refresh();
        });
        wave.addEventListener("pointermove", (e) => {
            hoverFrac = fracAt(e);
            if (seeking) seekFrac = fracAt(e);
            refresh();
        });
        wave.addEventListener("pointerup", (e) => {
            if (!seeking) return;
            seeking = false;
            audio.currentTime = fracAt(e) * getDuration();
            refresh();
        });
        wave.addEventListener("pointercancel", () => { seeking = false; draw(); });
        wave.addEventListener("pointerleave", () => { hoverFrac = null; draw(); });
        wave.addEventListener("keydown", (e) => {
            const dur = getDuration(); if (!dur) return;
            const step = { ArrowLeft: -5, ArrowRight: 5 }[e.key];
            if (step) audio.currentTime = Math.min(dur, Math.max(0, audio.currentTime + step));
            else if (e.key === "Home") audio.currentTime = 0;
            else if (e.key === "End") audio.currentTime = dur - 0.1;
            else return;
            e.preventDefault();
        });

        new ResizeObserver(draw).observe(wave);
        draw();
        loadPeaks();
    }

    // Auto-init every <div class="mini-player" data-src=... data-artist=... data-title=...>
    document.querySelectorAll(".mini-player").forEach((el) =>
        createPlayer(el, { src: el.dataset.src, artist: el.dataset.artist, title: el.dataset.title })
    );

    // Also available for players you add with JS later: createMiniPlayer(div, {src, artist, title})
    window.createMiniPlayer = createPlayer;
})();
// Sliding panel + fullscreen viewer logic, ported from panelTest.html.
//
// Instead of dedicated buttons, ANY element carrying a data-panel="<id>"
// attribute becomes a trigger that opens the panel/backdrop pair with the
// matching id suffix (infoPanel_<id> / panelBackdrop_<id>). Right now that's
// wired up on the 4 cards inside the Games card-grid, but adding
// data-panel="something" to a Models/Music/Art card later (plus its own
// panel + backdrop markup) is all it takes to hook those up too.
document.addEventListener('DOMContentLoaded', () => {
    const fullscreenModal = document.getElementById('fullscreenModal');
    const modalImage = document.getElementById('modalImage');
    const body = document.body;

    let activePanelId = null;

    function openPanel(id) {
        const panel = document.getElementById(`infoPanel_${id}`);
        const backdrop = document.getElementById(`panelBackdrop_${id}`);
        if (!panel || !backdrop) return;

        panel.classList.add('active');
        backdrop.classList.add('active');
        body.style.overflow = 'hidden';
        activePanelId = id;
    }

    function closePanel(id) {
        const panel = document.getElementById(`infoPanel_${id}`);
        const backdrop = document.getElementById(`panelBackdrop_${id}`);
        if (!panel || !backdrop) return;

        panel.classList.remove('active');
        backdrop.classList.remove('active');
        body.style.overflow = 'auto';
        if (activePanelId === id) activePanelId = null;
    }

    function closeActivePanel() {
        if (activePanelId) closePanel(activePanelId);
    }

    function switchHeaderImage(imgEl, panelId) {
        const header = document.getElementById(`mainHeaderImage_${panelId}`);
        if (!header) return;
        header.src = imgEl.src;
        header.alt = imgEl.alt;
    }

    function showFullscreen(panelId) {
        const header = document.getElementById(`mainHeaderImage_${panelId}`);
        if (!header) return;
        modalImage.src = header.src;
        modalImage.alt = `${header.alt} (Fullscreen)`;
        fullscreenModal.classList.add('active');
    }

    function hideFullscreen() {
        fullscreenModal.classList.remove('active');
    }

    // 1. Any [data-panel] element opens its matching panel on click.
    document.querySelectorAll('[data-panel]').forEach(trigger => {
        trigger.addEventListener('click', (event) => {
            event.preventDefault(); // stops <a> cards (like Pawn Turn Crisis) from navigating away
            openPanel(trigger.dataset.panel);
        });
    });

    // 2. Clicking a backdrop closes its own panel.
    document.querySelectorAll('.backdrop').forEach(backdrop => {
        backdrop.addEventListener('click', () => {
            const id = backdrop.id.replace('panelBackdrop_', '');
            closePanel(id);
        });
    });

    // 3. Inside each panel: gallery clicks swap the header image, and
    //    clicking the header image opens the fullscreen viewer.
    document.querySelectorAll('.panel').forEach(panel => {
        const id = panel.id.replace('infoPanel_', '');

        panel.querySelectorAll('.galleryImage').forEach(img => {
            img.addEventListener('click', () => switchHeaderImage(img, id));
        });

        const header = document.getElementById(`mainHeaderImage_${id}`);
        if (header) header.addEventListener('click', () => showFullscreen(id));
    });

    // 4. Escape closes the fullscreen viewer first, then the open panel.
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;

        if (fullscreenModal.classList.contains('active')) {
            hideFullscreen();
        } else {
            closeActivePanel();
        }
    });

    // 5. Clicking outside the image inside the fullscreen viewer closes it.
    fullscreenModal.addEventListener('click', (event) => {
        if (event.target === fullscreenModal) hideFullscreen();
    });
});