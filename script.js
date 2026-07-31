/* ============================================================
   Neon Brick Breaker — game logic
   Vanilla JS. No dependencies. 60 FPS rAF loop with fixed
   delta-time physics so speed is identical on every device.
   ============================================================ */
(function () {
  "use strict";

  /* ---------------------------------------------------------
     DOM references
     --------------------------------------------------------- */
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d", { alpha: false });
  const stage = document.getElementById("stage");

  const el = {
    score: document.getElementById("score"),
    best: document.getElementById("best"),
    level: document.getElementById("level"),
    lives: document.getElementById("lives"),
    overlay: document.getElementById("overlay"),
    ovTitle: document.getElementById("ovTitle"),
    ovText: document.getElementById("ovText"),
    primary: document.getElementById("primaryBtn"),
    secondary: document.getElementById("secondaryBtn"),
    pause: document.getElementById("pauseBtn"),
    mute: document.getElementById("muteBtn"),
    left: document.getElementById("leftBtn"),
    right: document.getElementById("rightBtn"),
    resume: document.getElementById("resumeBtn"),
  };

  /* ---------------------------------------------------------
     Level design — 10 levels of increasing difficulty.
     speed      : ball speed as a fraction of canvas height / second
     rows/cols  : brick grid
     strong     : how many top rows need 2+ hits
     moving     : horizontal drift of the whole brick field
     paddle     : paddle width as a fraction of canvas width
     pattern    : optional (row, col, rows, cols) => boolean filter
     --------------------------------------------------------- */
  const LEVELS = [
    { name: "WARM UP",        speed: 0.52, rows: 3, cols: 6, strong: 0, moving: 0,    paddle: 0.24 },
    { name: "MORE BRICKS",    speed: 0.56, rows: 5, cols: 7, strong: 0, moving: 0,    paddle: 0.24 },
    { name: "SPEED UP",       speed: 0.66, rows: 5, cols: 8, strong: 0, moving: 0,    paddle: 0.23 },
    { name: "ARMOURED",       speed: 0.68, rows: 5, cols: 8, strong: 2, moving: 0,    paddle: 0.23 },
    { name: "DRIFTERS",       speed: 0.70, rows: 5, cols: 8, strong: 1, moving: 0.05, paddle: 0.22 },
    { name: "TINY PADDLE",    speed: 0.72, rows: 6, cols: 8, strong: 2, moving: 0,    paddle: 0.15 },
    { name: "HARD STEEL",     speed: 0.82, rows: 6, cols: 9, strong: 3, moving: 0,    paddle: 0.18 },
    { name: "PATTERNS",       speed: 0.84, rows: 7, cols: 9, strong: 2, moving: 0.03,
      paddle: 0.18, pattern: (r, c) => (r + c) % 2 === 0 || r === 0 },
    { name: "TURBO DRIFT",    speed: 0.95, rows: 7, cols: 9, strong: 3, moving: 0.09, paddle: 0.17 },
    { name: "BOSS",           speed: 1.08, rows: 8, cols: 10, strong: 5, moving: 0.11,
      paddle: 0.15, pattern: (r, c, rows, cols) => Math.abs(c - (cols - 1) / 2) <= (rows - r) },
  ];

  const BRICK_COLORS = ["#ff2fb9", "#b14bff", "#22e6ff", "#3dffd0", "#9dff3d", "#ffd23d", "#ff7a3d"];
  const MAX_LIVES = 3;

  /* ---------------------------------------------------------
     Audio — synthesised with the Web Audio API (zero assets,
     instant load). Background music is a looping arpeggio.
     --------------------------------------------------------- */
  const Audio_ = {
    ctx: null,
    muted: false,
    musicTimer: null,
    step: 0,

    init() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    },

    resume() {
      this.init();
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    },

    /** One short synth blip. */
    beep(freq, duration, type, volume) {
      if (!this.ctx || this.muted) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type || "square";
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      gain.gain.setValueAtTime(volume || 0.15, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
      osc.connect(gain).connect(this.master);
      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    },

    paddle() { this.beep(320, 0.08, "square", 0.14); },
    wall()   { this.beep(220, 0.06, "triangle", 0.1); },
    brick()  { this.beep(660, 0.09, "square", 0.13); },
    crack()  { this.beep(180, 0.09, "sawtooth", 0.12); },
    lose()   { this.beep(140, 0.45, "sawtooth", 0.18); },
    win()    { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.beep(f, 0.22, "triangle", 0.16), i * 110)); },

    /** Simple looping bass arpeggio as background music. */
    startMusic() {
      if (!this.ctx || this.musicTimer) return;
      const notes = [110, 138.6, 164.8, 138.6, 110, 98, 123.5, 146.8];
      this.musicTimer = setInterval(() => {
        if (this.muted) return;
        this.beep(notes[this.step % notes.length], 0.28, "sine", 0.07);
        if (this.step % 4 === 0) this.beep(notes[this.step % notes.length] * 2, 0.16, "triangle", 0.03);
        this.step++;
      }, 320);
    },

    stopMusic() { clearInterval(this.musicTimer); this.musicTimer = null; },
  };

  /* ---------------------------------------------------------
     Entities
     --------------------------------------------------------- */
  class Paddle {
    constructor() { this.x = 0; this.w = 0; this.h = 0; this.y = 0; this.speed = 0; }
    layout(w, h, widthRatio) {
      this.w = w * widthRatio;
      this.h = Math.max(10, h * 0.018);
      this.y = h - this.h - h * 0.045;
      this.speed = w * 1.35;                 // px per second for key/D-pad input
      this.x = Math.min(Math.max(this.x || w / 2, this.w / 2), w - this.w / 2);
    }
    draw(c) {
      const x = this.x - this.w / 2;
      c.save();
      c.shadowColor = "#22e6ff";
      c.shadowBlur = 18;
      const g = c.createLinearGradient(x, 0, x + this.w, 0);
      g.addColorStop(0, "#22e6ff");
      g.addColorStop(0.5, "#9dff3d");
      g.addColorStop(1, "#22e6ff");
      c.fillStyle = g;
      roundRect(c, x, this.y, this.w, this.h, this.h / 2);
      c.fill();
      c.restore();
    }
  }

  class Ball {
    constructor() { this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.r = 6; this.stuck = true; }
    /** Park the ball on the paddle until launch. */
    reset(paddle, w, h, speed) {
      this.r = Math.max(5, Math.min(w, h) * 0.013);
      this.x = paddle.x;
      this.y = paddle.y - this.r - 2;
      this.speed = h * speed;
      const angle = (-Math.PI / 2) + (Math.random() * 0.5 - 0.25);
      this.vx = Math.cos(angle) * this.speed;
      this.vy = Math.sin(angle) * this.speed;
      this.stuck = true;
    }
    draw(c) {
      c.save();
      c.shadowColor = "#ffffff";
      c.shadowBlur = 26;                      // glow effect
      const g = c.createRadialGradient(this.x, this.y, 0, this.x, this.y, this.r * 2.4);
      g.addColorStop(0, "#ffffff");
      g.addColorStop(0.4, "#9dff3d");
      g.addColorStop(1, "rgba(157,255,61,0)");
      c.fillStyle = g;
      c.beginPath();
      c.arc(this.x, this.y, this.r * 2.2, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#ffffff";
      c.beginPath();
      c.arc(this.x, this.y, this.r, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
  }

  class Brick {
    constructor(x, y, w, h, hp, color) {
      this.x = x; this.y = y; this.w = w; this.h = h;
      this.hp = hp; this.maxHp = hp; this.color = color; this.alive = true;
    }
    draw(c, dx) {
      if (!this.alive) return;
      const x = this.x + dx;
      c.save();
      c.globalAlpha = 0.35 + 0.65 * (this.hp / this.maxHp);
      c.shadowColor = this.color;
      c.shadowBlur = 14;
      c.fillStyle = this.color;
      roundRect(c, x, this.y, this.w, this.h, Math.min(8, this.h / 2));
      c.fill();
      c.globalAlpha = 1;
      c.lineWidth = 1.5;
      c.strokeStyle = "rgba(255,255,255,0.6)";
      roundRect(c, x, this.y, this.w, this.h, Math.min(8, this.h / 2));
      c.stroke();
      if (this.maxHp > 1) {                  // hit counter on armoured bricks
        c.shadowBlur = 0;
        c.fillStyle = "rgba(5,6,15,0.85)";
        c.font = `bold ${Math.round(this.h * 0.5)}px system-ui, sans-serif`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(String(this.hp), x + this.w / 2, this.y + this.h / 2 + 1);
      }
      c.restore();
    }
  }

  class Particle {
    constructor(x, y, color) {
      const a = Math.random() * Math.PI * 2;
      const s = 60 + Math.random() * 220;
      this.x = x; this.y = y;
      this.vx = Math.cos(a) * s;
      this.vy = Math.sin(a) * s;
      this.life = 1;
      this.color = color;
      this.size = 2 + Math.random() * 3;
    }
    update(dt) {
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.vy += 420 * dt;                    // gravity
      this.life -= dt * 1.8;
    }
    draw(c) {
      if (this.life <= 0) return;
      c.save();
      c.globalAlpha = Math.max(0, this.life);
      c.fillStyle = this.color;
      c.shadowColor = this.color;
      c.shadowBlur = 10;
      c.fillRect(this.x, this.y, this.size, this.size);
      c.restore();
    }
  }

  /* ---------------------------------------------------------
     Game state
     --------------------------------------------------------- */
  const state = {
    mode: "start",        // start | playing | paused | dead | gameover | levelup | victory
    score: 0,
    best: Number(localStorage.getItem("nbb_best") || 0),
    lives: MAX_LIVES,
    levelIndex: 0,
    bricks: [],
    particles: [],
    drift: 0,
    driftDir: 1,
    keys: { left: false, right: false },
  };

  const paddle = new Paddle();
  const ball = new Ball();
  let W = 0, H = 0;

  /* ---------------------------------------------------------
     Canvas sizing — crisp on retina, re-lays out on resize
     --------------------------------------------------------- */
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = stage.getBoundingClientRect();
    W = Math.max(200, rect.width);
    H = Math.max(240, rect.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cfg = LEVELS[state.levelIndex];
    paddle.layout(W, H, cfg.paddle);
    buildBricks(true);                        // keep hp when only resizing
    if (ball.stuck) ball.reset(paddle, W, H, cfg.speed);
    else ball.r = Math.max(5, Math.min(W, H) * 0.013);
    draw();
  }

  /* ---------------------------------------------------------
     Level construction
     --------------------------------------------------------- */
  function buildBricks(preserve) {
    const cfg = LEVELS[state.levelIndex];
    const old = preserve ? state.bricks : null;

    const marginX = W * (cfg.moving ? 0.09 : 0.04);
    const gap = Math.max(3, W * 0.008);
    const top = H * 0.08;
    const totalW = W - marginX * 2;
    const bw = (totalW - gap * (cfg.cols - 1)) / cfg.cols;
    const bh = Math.max(14, Math.min(H * 0.035, bw * 0.5));

    const bricks = [];
    let i = 0;
    for (let r = 0; r < cfg.rows; r++) {
      for (let c = 0; c < cfg.cols; c++) {
        if (cfg.pattern && !cfg.pattern(r, c, cfg.rows, cfg.cols)) { i++; continue; }
        const hp = r < cfg.strong ? (state.levelIndex >= 8 && r < 2 ? 3 : 2) : 1;
        const b = new Brick(
          marginX + c * (bw + gap),
          top + r * (bh + gap),
          bw, bh, hp,
          BRICK_COLORS[(r + c) % BRICK_COLORS.length]
        );
        if (old && old[i]) { b.hp = old[i].hp; b.alive = old[i].alive; b.maxHp = old[i].maxHp; }
        bricks.push(b);
        i++;
      }
    }
    state.bricks = bricks;
  }

  function loadLevel(index) {
    state.levelIndex = index;
    state.drift = 0;
    state.driftDir = 1;
    state.particles.length = 0;
    const cfg = LEVELS[index];
    paddle.layout(W, H, cfg.paddle);
    buildBricks(false);
    ball.reset(paddle, W, H, cfg.speed);
    updateHUD();
  }

  /* ---------------------------------------------------------
     HUD + overlays
     --------------------------------------------------------- */
  function updateHUD() {
    el.score.textContent = state.score;
    el.best.textContent = state.best;
    el.level.textContent = state.levelIndex + 1;
    el.lives.textContent = state.lives > 0 ? "♥".repeat(state.lives) : "—";
  }

  function showOverlay(title, text, primaryLabel, secondaryLabel) {
    el.ovTitle.innerHTML = title;
    el.ovText.textContent = text;
    el.primary.textContent = primaryLabel;
    el.secondary.style.display = secondaryLabel ? "" : "none";
    if (secondaryLabel) el.secondary.textContent = secondaryLabel;
    el.overlay.classList.remove("hidden");
  }

  function hideOverlay() { el.overlay.classList.add("hidden"); }

  /* ---------------------------------------------------------
     Flow control
     --------------------------------------------------------- */
  function startGame() {
    state.score = 0;
    state.lives = MAX_LIVES;
    loadLevel(0);
    state.mode = "playing";
    hideOverlay();
    Audio_.resume();
    Audio_.startMusic();
  }

  function pauseGame() {
    if (state.mode !== "playing") return;
    state.mode = "paused";
    showOverlay("PAUSED", "Take a breath — the ball will wait.", "RESUME", "RESTART");
  }

  function resumeGame() {
    if (state.mode !== "paused") return;
    state.mode = "playing";
    hideOverlay();
    Audio_.resume();
  }

  function togglePause() {
    if (state.mode === "playing") pauseGame();
    else if (state.mode === "paused") resumeGame();
  }

  function loseLife() {
    state.lives--;
    Audio_.lose();
    updateHUD();
    if (state.lives <= 0) {
      state.mode = "gameover";
      saveBest();
      Audio_.stopMusic();
      showOverlay("GAME OVER", `Score ${state.score} · reached level ${state.levelIndex + 1}`, "PLAY AGAIN", "");
    } else {
      state.mode = "dead";
      ball.reset(paddle, W, H, LEVELS[state.levelIndex].speed);
      showOverlay("BALL LOST", `${state.lives} ${state.lives === 1 ? "life" : "lives"} left.`, "CONTINUE", "RESTART");
    }
  }

  function completeLevel() {
    saveBest();
    if (state.levelIndex >= LEVELS.length - 1) {
      state.mode = "victory";
      Audio_.stopMusic();
      Audio_.win();
      showOverlay("VICTORY!", `All 10 levels cleared with ${state.score} points.`, "PLAY AGAIN", "");
    } else {
      state.mode = "levelup";
      Audio_.win();
      const next = LEVELS[state.levelIndex + 1];
      showOverlay(`LEVEL ${state.levelIndex + 2}`, `${next.name} — score ${state.score}`, "GO", "RESTART");
    }
  }

  function saveBest() {
    if (state.score > state.best) {
      state.best = state.score;
      localStorage.setItem("nbb_best", String(state.best));
    }
    updateHUD();
  }

  /** The primary overlay button is contextual. */
  function onPrimary() {
    Audio_.resume();
    switch (state.mode) {
      case "start":
      case "gameover":
      case "victory":
        startGame();
        break;
      case "paused":
        resumeGame();
        break;
      case "dead":
        state.mode = "playing";
        hideOverlay();
        break;
      case "levelup":
        loadLevel(state.levelIndex + 1);
        state.mode = "playing";
        hideOverlay();
        break;
    }
  }

  /* ---------------------------------------------------------
     Physics helpers
     --------------------------------------------------------- */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function spawnParticles(x, y, color) {
    for (let i = 0; i < 14; i++) state.particles.push(new Particle(x, y, color));
    if (state.particles.length > 300) state.particles.splice(0, state.particles.length - 300);
  }

  /** Circle vs axis-aligned rect collision with side resolution. */
  function hitBrick(b, dx) {
    const bx = b.x + dx;
    const nx = clamp(ball.x, bx, bx + b.w);
    const ny = clamp(ball.y, b.y, b.y + b.h);
    const ddx = ball.x - nx;
    const ddy = ball.y - ny;
    if (ddx * ddx + ddy * ddy > ball.r * ball.r) return false;

    // Bounce off whichever axis has the smaller overlap.
    const overlapX = ball.r - Math.abs(ddx);
    const overlapY = ball.r - Math.abs(ddy);
    if (overlapX < overlapY || ddy === 0) {
      ball.vx = -ball.vx;
      ball.x += ddx >= 0 ? overlapX : -overlapX;
    } else {
      ball.vy = -ball.vy;
      ball.y += ddy >= 0 ? overlapY : -overlapY;
    }
    return true;
  }

  /* ---------------------------------------------------------
     Update
     --------------------------------------------------------- */
  function update(dt) {
    const cfg = LEVELS[state.levelIndex];

    // Keyboard / D-pad paddle movement
    if (state.keys.left) paddle.x -= paddle.speed * dt;
    if (state.keys.right) paddle.x += paddle.speed * dt;
    paddle.x = clamp(paddle.x, paddle.w / 2, W - paddle.w / 2);

    // Moving-brick levels: oscillate the whole field horizontally
    if (cfg.moving) {
      const range = W * cfg.moving;
      state.drift += state.driftDir * W * cfg.moving * 0.55 * dt;
      if (state.drift > range) { state.drift = range; state.driftDir = -1; }
      if (state.drift < -range) { state.drift = -range; state.driftDir = 1; }
    }

    // Particles are always animated
    for (let i = state.particles.length - 1; i >= 0; i--) {
      const p = state.particles[i];
      p.update(dt);
      if (p.life <= 0) state.particles.splice(i, 1);
    }

    if (state.mode !== "playing") return;

    if (ball.stuck) {
      // Ball rides the paddle for a beat, then launches.
      ball.x = paddle.x;
      ball.y = paddle.y - ball.r - 2;
      ball.stuck = false;
      return;
    }

    // Sub-stepping keeps fast balls from tunnelling through bricks.
    const steps = Math.max(1, Math.ceil((Math.abs(ball.vx) + Math.abs(ball.vy)) * dt / (ball.r * 0.8)));
    const sdt = dt / steps;

    for (let s = 0; s < steps; s++) {
      ball.x += ball.vx * sdt;
      ball.y += ball.vy * sdt;

      // Walls
      if (ball.x - ball.r < 0) { ball.x = ball.r; ball.vx = Math.abs(ball.vx); Audio_.wall(); }
      if (ball.x + ball.r > W) { ball.x = W - ball.r; ball.vx = -Math.abs(ball.vx); Audio_.wall(); }
      if (ball.y - ball.r < 0) { ball.y = ball.r; ball.vy = Math.abs(ball.vy); Audio_.wall(); }

      // Paddle — bounce angle depends on where it hits
      if (
        ball.vy > 0 &&
        ball.y + ball.r >= paddle.y &&
        ball.y - ball.r <= paddle.y + paddle.h &&
        ball.x >= paddle.x - paddle.w / 2 - ball.r &&
        ball.x <= paddle.x + paddle.w / 2 + ball.r
      ) {
        const rel = clamp((ball.x - paddle.x) / (paddle.w / 2), -1, 1);
        const angle = rel * (Math.PI / 3);          // max 60° deflection
        const speed = Math.hypot(ball.vx, ball.vy);
        ball.vx = Math.sin(angle) * speed;
        ball.vy = -Math.abs(Math.cos(angle) * speed);
        ball.y = paddle.y - ball.r - 0.5;
        Audio_.paddle();
      }

      // Bricks
      for (let i = 0; i < state.bricks.length; i++) {
        const b = state.bricks[i];
        if (!b.alive) continue;
        if (hitBrick(b, state.drift)) {
          b.hp--;
          if (b.hp <= 0) {
            b.alive = false;
            state.score += 10 * (state.levelIndex + 1) * b.maxHp;
            spawnParticles(b.x + state.drift + b.w / 2, b.y + b.h / 2, b.color);
           

Audio_.brick();
          } else {
            state.score += 5;
            spawnParticles(b.x + state.drift + b.w / 2, b.y + b.h / 2, "#ffffff");
            Audio_.crack();
          }
          updateHUD();
          break;                                    // one brick per sub-step
        }
      }

      // Fell below the paddle
      if (ball.y - ball.r > H) { loseLife(); return; }
    }

    // Level cleared?
    if (state.bricks.every((b) => !b.alive)) completeLevel();
  }

  /* ---------------------------------------------------------
     Render
     --------------------------------------------------------- */
  function draw() {
    // Background
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#0b0f2a");
    g.addColorStop(0.5, "#080a1c");
    g.addColorStop(1, "#04050f");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Subtle neon grid
    ctx.save();
    ctx.strokeStyle = "rgba(34,230,255,0.05)";
    ctx.lineWidth = 1;
    const cell = Math.max(28, W / 14);
    for (let x = 0; x < W; x += cell) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += cell) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.restore();

    for (const b of state.bricks) b.draw(ctx, state.drift);
    for (const p of state.particles) p.draw(ctx);
    paddle.draw(ctx);
    ball.draw(ctx);
  }

  /* ---------------------------------------------------------
     Main loop — delta-time clamped for stability
     --------------------------------------------------------- */
  let last = performance.now();
  function loop(now) {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  /* ---------------------------------------------------------
     Input
     --------------------------------------------------------- */
  // Keyboard
  window.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "a") state.keys.left = true;
    if (e.key === "ArrowRight" || e.key === "d") state.keys.right = true;
    if (e.code === "Space") { e.preventDefault(); togglePause(); }
    if (e.key === "Enter" && state.mode !== "playing") onPrimary();
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "ArrowLeft" || e.key === "a") state.keys.left = false;
    if (e.key === "ArrowRight" || e.key === "d") state.keys.right = false;
  });

  // Pointer / touch drag on the canvas
  function movePaddleTo(clientX) {
    const rect = canvas.getBoundingClientRect();
    paddle.x = clamp(clientX - rect.left, paddle.w / 2, W - paddle.w / 2);
  }
  stage.addEventListener("pointerdown", (e) => { Audio_.resume(); movePaddleTo(e.clientX); });
  stage.addEventListener("pointermove", (e) => { if (e.buttons || e.pointerType === "touch") movePaddleTo(e.clientX); });
  stage.addEventListener("touchmove", (e) => { e.preventDefault(); movePaddleTo(e.touches[0].clientX); }, { passive: false });

  // Big D-pad buttons (hold to move)
  function hold(btn, side) {
    const on = (e) => { e.preventDefault(); state.keys[side] = true; };
    const off = () => { state.keys[side] = false; };
    btn.addEventListener("pointerdown", on);
    btn.addEventListener("pointerup", off);
    btn.addEventListener("pointerleave", off);
    btn.addEventListener("pointercancel", off);
  }
  hold(el.left, "left");
  hold(el.right, "right");

  el.primary.addEventListener("click", onPrimary);
  el.secondary.addEventListener("click", () => { Audio_.resume(); startGame(); });
  el.pause.addEventListener("click", togglePause);
  el.resume.addEventListener("click", togglePause);

  el.mute.addEventListener("click", () => {
    Audio_.resume();
    Audio_.muted = !Audio_.muted;
    el.mute.textContent = Audio_.muted ? "🔇" : "🔊";
  });

  // Auto-pause when the tab or app goes to the background
  document.addEventListener("visibilitychange", () => { if (document.hidden) pauseGame(); });

  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => setTimeout(resize, 150));

  /* ---------------------------------------------------------
     Boot
     --------------------------------------------------------- */
  resize();
  loadLevel(0);
  updateHUD();
  showOverlay("NEON<br />BRICK BREAKER", "10 levels. 3 lives. Don't drop the ball.", "START GAME", "");
  requestAnimationFrame(loop);
})();