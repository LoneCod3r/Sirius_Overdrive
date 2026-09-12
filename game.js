// ---------------------------------------------------------------------------
// Sirius Overdrive: Edge of Oblivion
// Complete rewrite - single-file HTML5 canvas space shooter.
// Game states: START_MENU -> PLAYING -> GAME_OVER -> (restart) -> PLAYING
// ---------------------------------------------------------------------------

// Canvas is locked to this aspect ratio; resizeCanvas() letterboxes to fit any screen.
const ASPECT_WIDTH = 16;
const ASPECT_HEIGHT = 9;

let canvas;
let ctx;

// Tracks the time of the previous frame so update() can receive a delta time,
// keeping motion consistent regardless of the display's refresh rate.
let lastFrameTime = 0;

// Total playtime in seconds, used to drive time-based visual effects
// (pulsing lights, flashing text) independent of any single object's own age.
let totalElapsedTime = 0;

// 'LOADING' shows a progress bar tied to real sprite-loading progress and
// auto-advances to 'START_MENU' once everything has settled; 'START_MENU'
// shows the title screen and its 4 buttons (START GAME, ABOUT, HOW TO PLAY,
// SCORE); 'ABOUT', 'HOW_TO_PLAY' and 'SCORE_BOARD' are sub-screens reached
// from those buttons, each with its own BACK button - 'ABOUT' further splits
// into a STORY/SHIP LOG tab pair (see aboutTab) covering the backstory and
// the browsable ship codex; 'SHIP_SELECTION' lets the player pick a ship
// before their first launch;
// Clicking START on the title screen goes to 'ENTER_NAME' first (see
// startNameEntry()), where the player types a name (up to NAME_MAX_LENGTH
// characters) before landing on 'SHIP_SELECTION'; that name is then reused
// automatically for any top-5 leaderboard entry the run earns, with no
// further prompting.
// 'PLAYING' runs the full simulation; 'PAUSED' freezes everything (including
// the starfield) until resumed; 'GAME_OVER' and 'VICTORY' freeze gameplay,
// show their respective overlay (a congratulations message for VICTORY,
// after the final boss - the last entry in BOSS_SEQUENCE - is defeated), and
// return to START_MENU (not an automatic restart) on the next input.
let gameState = 'LOADING';
let score = 0;

/**
 * Returns a random number in [min, max).
 */
function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

// ---------------------------------------------------------------------------
// High score leaderboard (localStorage)
// ---------------------------------------------------------------------------

const HIGH_SCORE_STORAGE_KEY = 'nebulaVanguardHighScores';
const HIGH_SCORE_COUNT = 5;
const DEFAULT_HIGH_SCORE_NAME = 'Player';
const NAME_MAX_LENGTH = 10;

/**
 * Reads the top scores from localStorage as { name, score } entries.
 * Defensive against a missing key, corrupted JSON, or an environment where
 * localStorage is unavailable. Also migrates the older format (a bare array
 * of numbers, from before named entries existed) into named entries.
 */
function loadHighScores() {
  try {
    const raw = localStorage.getItem(HIGH_SCORE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => {
        if (typeof value === 'number' && Number.isFinite(value)) {
          return { name: DEFAULT_HIGH_SCORE_NAME, score: value };
        }
        if (value && typeof value.score === 'number' && Number.isFinite(value.score)) {
          const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, NAME_MAX_LENGTH) : DEFAULT_HIGH_SCORE_NAME;
          return { name, score: value.score };
        }
        return null;
      })
      .filter((entry) => entry !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, HIGH_SCORE_COUNT);
  } catch (err) {
    return [];
  }
}

/**
 * Returns true if newScore would land on the top-5 leaderboard, i.e. the
 * board isn't full yet or newScore beats the current lowest qualifying entry.
 */
function qualifiesForHighScore(newScore) {
  const scores = loadHighScores();
  if (scores.length < HIGH_SCORE_COUNT) return true;
  return newScore > scores[scores.length - 1].score;
}

/**
 * Inserts a new { name, score } entry into the leaderboard and persists the
 * top 5.
 */
function saveHighScore(entry) {
  try {
    const scores = loadHighScores();
    scores.push(entry);
    scores.sort((a, b) => b.score - a.score);
    const top = scores.slice(0, HIGH_SCORE_COUNT);
    localStorage.setItem(HIGH_SCORE_STORAGE_KEY, JSON.stringify(top));
    return top;
  } catch (err) {
    return loadHighScores();
  }
}

// ---------------------------------------------------------------------------
// Player name entry ('ENTER_NAME' game state)
// ---------------------------------------------------------------------------

// The name entered before ship selection; reused automatically for any
// leaderboard entry a run earns, with no further prompting mid-game.
let playerName = DEFAULT_HIGH_SCORE_NAME;

// Live text of the in-progress name entry (up to NAME_MAX_LENGTH chars),
// mirrored from the real <input id="nameInput"> element - see setupInput().
// That hidden-but-focusable input is what actually captures keystrokes (and
// what pops the OS keyboard on mobile); this variable is just what
// drawNameEntryScreen() renders onto the canvas.
let nameEntryText = '';
let nameInputEl = null;

// Which state to land on once the name is confirmed (always 'SHIP_SELECTION'
// today, kept as a variable rather than a hardcoded jump so name entry stays
// reusable if another entry point is added later).
let pendingFinalState = null;

/**
 * Filters raw input down to letters/digits/spaces, caps it at
 * NAME_MAX_LENGTH, and force-capitalizes only the first character - every
 * other letter keeps whatever case was actually typed (lowercase by
 * default, uppercase wherever the player held Shift), like a normal name
 * field rather than an all-caps arcade one.
 */
function sanitizeNameInput(raw) {
  const filtered = raw.replace(/[^A-Za-z0-9 ]/g, '').slice(0, NAME_MAX_LENGTH);
  if (!filtered) return filtered;
  return filtered.charAt(0).toUpperCase() + filtered.slice(1);
}

/**
 * Shows the name entry overlay, pre-filled with the player's last-entered
 * name (or "Player" the first time), and focuses the real text input so
 * keystrokes (and, on mobile, the OS keyboard) go straight to it.
 */
function startNameEntry(nextState) {
  nameEntryText = playerName;
  pendingFinalState = nextState;
  gameState = 'ENTER_NAME';
  if (nameInputEl) {
    nameInputEl.value = nameEntryText;
    nameInputEl.focus();
    nameInputEl.select();
  }
}

/**
 * Saves the typed name (falling back to the default if left empty) as the
 * current player name and lands on whichever state (SHIP_SELECTION)
 * triggered name entry.
 */
function confirmNameEntry() {
  const typed = sanitizeNameInput((nameInputEl ? nameInputEl.value : nameEntryText).trim());
  playerName = typed || DEFAULT_HIGH_SCORE_NAME;
  if (nameInputEl) {
    nameInputEl.blur();
  }
  gameState = pendingFinalState;
  pendingFinalState = null;
}

// ---------------------------------------------------------------------------
// Screen shake
// ---------------------------------------------------------------------------

let shakeIntensity = 0; // current max pixel offset applied to the gameplay layer
let shakeDuration = 0;  // seconds of shake remaining

/**
 * Kicks off (or extends) a screen shake. Overlapping triggers take the
 * stronger/longer of the current and requested shake rather than
 * overwriting a big shake with a smaller one.
 */
function triggerScreenShake(intensity, duration) {
  shakeIntensity = Math.max(shakeIntensity, intensity);
  shakeDuration = Math.max(shakeDuration, duration);
}

/**
 * Counts down the active shake and clears it once expired.
 * @param {number} deltaTime - Seconds elapsed since the last frame.
 */
function updateScreenShake(deltaTime) {
  if (shakeDuration <= 0) return;
  shakeDuration -= deltaTime;
  if (shakeDuration <= 0) {
    shakeDuration = 0;
    shakeIntensity = 0;
  }
}

// ---------------------------------------------------------------------------
// Level progression & difficulty scaling
// ---------------------------------------------------------------------------

// Score required to reach levels 1-10. Index i holds the score needed to
// be AT LEAST level (i + 1), so index 0 is level 1's starting threshold.
const LEVEL_SCORE_THRESHOLDS = [0, 500, 1200, 2100, 3200, 4500, 6000, 7700, 9600, 11700];

let currentLevel = 1;
let levelUpMessage = null; // { level, timer } while a "LEVEL X" banner is fading in/out

const LEVEL_UP_DISPLAY_DURATION = 2.5; // seconds the banner stays visible (including fade-out)
const LEVEL_UP_FADE_START = 0.8; // seconds remaining when the fade-out begins

// Multiplies enemy/star speed. Starts at 1.0 and steps up by 0.25
// every 2 levels (at levels 3, 5, 7, 9), so the pace visibly shifts into overdrive.
let globalSpeedModifier = 1.0;

/**
 * Recomputes globalSpeedModifier from the current level.
 */
function updateGlobalSpeedModifier() {
  globalSpeedModifier = 1 + 0.25 * Math.floor((currentLevel - 1) / 2);
}

/**
 * Checks the current score against the level thresholds and advances
 * currentLevel (possibly by more than one level) whenever it's exceeded.
 */
function updateLevelProgress() {
  let leveledUp = false;
  while (currentLevel < LEVEL_SCORE_THRESHOLDS.length && score >= LEVEL_SCORE_THRESHOLDS[currentLevel]) {
    currentLevel++;
    leveledUp = true;
    levelUpMessage = { level: currentLevel, timer: LEVEL_UP_DISPLAY_DURATION };
  }
  if (leveledUp) {
    updateGlobalSpeedModifier();
  }
}

/**
 * Counts down the active level-up banner's lifetime, if any.
 * @param {number} deltaTime - Seconds elapsed since the last frame.
 */
function updateLevelUpMessage(deltaTime) {
  if (!levelUpMessage) return;
  levelUpMessage.timer -= deltaTime;
  if (levelUpMessage.timer <= 0) {
    levelUpMessage = null;
  }
}

/**
 * Draws a large, fading "LEVEL X" banner while one is active.
 */
function drawLevelUpMessage() {
  if (!levelUpMessage) return;

  const alpha = levelUpMessage.timer < LEVEL_UP_FADE_START
    ? Math.max(levelUpMessage.timer / LEVEL_UP_FADE_START, 0)
    : 1;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffd93d';
  ctx.shadowColor = '#ffb703';
  ctx.shadowBlur = 20;
  ctx.font = `bold ${Math.round(canvas.width * 0.045)}px 'Orbitron', monospace`;
  ctx.fillText(`LEVEL ${levelUpMessage.level}`, canvas.width / 2, canvas.height * 0.35);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Parallax starfield
// ---------------------------------------------------------------------------

let backgroundStars = [];
let foregroundStars = [];

const BACKGROUND_STAR_COUNT = 70;
const BACKGROUND_STAR_MIN_RADIUS = 0.5;
const BACKGROUND_STAR_MAX_RADIUS = 1.5;
const BACKGROUND_STAR_MIN_SPEED = 20;
const BACKGROUND_STAR_MAX_SPEED = 50;

const FOREGROUND_STAR_COUNT = 30;
const FOREGROUND_STAR_MIN_RADIUS = 1.5;
const FOREGROUND_STAR_MAX_RADIUS = 3;
const FOREGROUND_STAR_MIN_SPEED = 90;
const FOREGROUND_STAR_MAX_SPEED = 170;

/**
 * Builds a field of stars spread across the current canvas, each with a
 * random size and speed within the given ranges.
 */
function createStarField(count, radiusMin, radiusMax, speedMin, speedMax) {
  const stars = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: randomRange(0, canvas.width),
      y: randomRange(0, canvas.height),
      radius: randomRange(radiusMin, radiusMax),
      speed: randomRange(speedMin, speedMax),
    });
  }
  return stars;
}

/**
 * (Re)builds both starfield layers. Called on init so stars are already
 * spread across the screen instead of all entering from the right at once.
 */
function initStars() {
  backgroundStars = createStarField(
    BACKGROUND_STAR_COUNT,
    BACKGROUND_STAR_MIN_RADIUS,
    BACKGROUND_STAR_MAX_RADIUS,
    BACKGROUND_STAR_MIN_SPEED,
    BACKGROUND_STAR_MAX_SPEED
  );
  foregroundStars = createStarField(
    FOREGROUND_STAR_COUNT,
    FOREGROUND_STAR_MIN_RADIUS,
    FOREGROUND_STAR_MAX_RADIUS,
    FOREGROUND_STAR_MIN_SPEED,
    FOREGROUND_STAR_MAX_SPEED
  );
}

/**
 * Scrolls a star layer right-to-left, wrapping each star back to the right
 * edge at a new random height once it exits to the left. Speed is scaled by
 * globalSpeedModifier so the whole starfield surges as the level climbs.
 * @param {number} deltaTime - Seconds elapsed since the last frame.
 */
function updateStarField(stars, deltaTime) {
  for (const star of stars) {
    star.x -= star.speed * globalSpeedModifier * deltaTime;
    if (star.x + star.radius < 0) {
      star.x = canvas.width + star.radius;
      star.y = randomRange(0, canvas.height);
    }
  }
}

/**
 * Draws a star layer as simple dots using the given fill style.
 */
function drawStarField(stars, fillStyle) {
  ctx.fillStyle = fillStyle;
  for (const star of stars) {
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Nebula (part of the background/starfield rendering layer)
// ---------------------------------------------------------------------------

let nebulaClouds = [];

const NEBULA_CLOUD_COUNT = 3;
// Deep purple, cosmic blue, and a muted magenta accent - kept at very low
// opacity so the clouds read as atmosphere, not solid shapes.
const NEBULA_PALETTE = [
  { r: 75, g: 0, b: 130 },
  { r: 0, g: 0, b: 128 },
  { r: 128, g: 0, b: 90 },
];

/**
 * Builds a handful of large, softly-colored nebula clouds spread across the
 * canvas. Each drifts and slowly "morphs" (via a sine-driven radius pulse)
 * independently, giving the background a volumetric, cinematic feel.
 */
function initNebula() {
  nebulaClouds = [];
  for (let i = 0; i < NEBULA_CLOUD_COUNT; i++) {
    nebulaClouds.push({
      x: randomRange(0, canvas.width),
      y: randomRange(0, canvas.height),
      radius: randomRange(canvas.width * 0.3, canvas.width * 0.55),
      color: NEBULA_PALETTE[i % NEBULA_PALETTE.length],
      opacity: randomRange(0.02, 0.04),
      driftX: randomRange(-6, 6),
      driftY: randomRange(-3, 3),
      pulsePhase: randomRange(0, Math.PI * 2),
      pulseSpeed: randomRange(0.05, 0.15),
    });
  }
}

/**
 * Drifts each cloud slowly and advances its morph phase, wrapping around
 * the screen edges so clouds roam indefinitely without popping.
 * @param {number} deltaTime - Seconds elapsed since the last frame.
 */
function updateNebulaClouds(deltaTime) {
  for (const cloud of nebulaClouds) {
    cloud.x += cloud.driftX * deltaTime;
    cloud.y += cloud.driftY * deltaTime;
    cloud.pulsePhase += cloud.pulseSpeed * deltaTime;

    const margin = cloud.radius;
    if (cloud.x < -margin) cloud.x = canvas.width + margin;
    if (cloud.x > canvas.width + margin) cloud.x = -margin;
    if (cloud.y < -margin) cloud.y = canvas.height + margin;
    if (cloud.y > canvas.height + margin) cloud.y = -margin;
  }
}

/**
 * Renders each nebula cloud as a large, low-opacity radial gradient blob.
 * Cheap to draw (a handful of gradient fills) so it never impacts performance.
 */
function drawNebulaClouds() {
  ctx.save();
  for (const cloud of nebulaClouds) {
    const morph = 0.9 + Math.sin(cloud.pulsePhase) * 0.1;
    const radius = cloud.radius * morph;
    const { r, g, b } = cloud.color;

    const gradient = ctx.createRadialGradient(cloud.x, cloud.y, 0, cloud.x, cloud.y, radius);
    gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${cloud.opacity})`);
    gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cloud.x, cloud.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Audio - streamed directly from stable, freely-licensed public CDNs.
// No local files are used, so there is nothing to go "missing".
// ---------------------------------------------------------------------------

/**
 * Thin wrapper around HTML5 Audio. Every operation is defensive: a slow
 * network, a blocked autoplay policy, or an offline browser should degrade
 * silently instead of ever crashing the game loop.
 *
 * Sources (all directly reachable, no auth/API key required):
 * - Laser: "LASRGun-CU_Zap" from the Designer's Choice Collection (archive.org), CC0.
 * - Explosion: "EXPLMisc-CU_Explosion" from the Designer's Choice Collection (archive.org), CC0.
 * - Music: "Space Jazz" by Kevin MacLeod (incompetech.com), CC BY 4.0.
 */
const audioManager = {
  laserSound: null,
  explosionSound: null,
  music: null,
  musicStarted: false,
  musicMuted: false,

  LASER_URL:
    'https://archive.org/download/Designers-Choice-Collection-Laser/LASERS%2FGUN%2FLASRGun-CU_Zap%2C%20Synthesized%2C%20Anime_Nicholas%20Judy_TDC.mp3',
  EXPLOSION_URL:
    'https://archive.org/download/Designers-Choice-Collection-Explosions/EXPLOSIONS/MISC/EXPLMisc-CU_Explosion_Nicholas%20Judy_TDC.mp3',
  MUSIC_URL: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Space%20Jazz.mp3',

  init() {
    try {
      this.laserSound = new Audio(this.LASER_URL);
      this.laserSound.preload = 'auto';
      this.laserSound.volume = 0.5;

      this.explosionSound = new Audio(this.EXPLOSION_URL);
      this.explosionSound.preload = 'auto';
      this.explosionSound.volume = 0.6;

      this.music = new Audio(this.MUSIC_URL);
      this.music.preload = 'auto';
      this.music.loop = true;
      this.music.volume = 0.35;
    } catch (err) {
      // Audio API unavailable - the game continues without sound.
      this.laserSound = null;
      this.explosionSound = null;
      this.music = null;
    }
  },

  /**
   * Plays a one-shot sound effect. Clones the node so rapid, overlapping
   * shots/explosions each play in full instead of cutting each other off.
   */
  _playOneShot(sound) {
    if (!sound) return;
    try {
      const instance = sound.cloneNode(true);
      instance.volume = sound.volume;
      instance.play().catch(() => {});
    } catch (err) {
      try {
        sound.currentTime = 0;
        sound.play().catch(() => {});
      } catch (err2) {
        // Missing/blocked audio - fail silently.
      }
    }
  },

  playLaserSound() {
    this._playOneShot(this.laserSound);
  },

  playExplosionSound() {
    this._playOneShot(this.explosionSound);
  },

  /**
   * Starts the background music loop once, on the first user interaction
   * (starting or restarting the game), which satisfies browser autoplay
   * policies. Safe to call repeatedly - only the first call has any effect.
   */
  playMusic() {
    if (!this.music || this.musicMuted || this.musicStarted) return;
    this.musicStarted = true;
    this.music.play().catch(() => {
      this.musicStarted = false;
    });
  },

  /**
   * Mutes/unmutes the music track (bound to the 'M' key).
   */
  toggleMusic() {
    if (!this.music) return;
    try {
      this.musicMuted = !this.musicMuted;
      if (this.musicMuted) {
        this.music.pause();
      } else if (this.musicStarted) {
        this.music.play().catch(() => {});
      }
    } catch (err) {
      // Ignore - music is a nice-to-have, never worth crashing over.
    }
  },

  audioContext: null,

  /**
   * Synthesizes a quick ascending two-tone "blip" via the Web Audio API for
   * weapon pickups - no network dependency, so it can never 404 and is
   * always distinct from the laser/explosion sound effects.
   */
  playPickupSound() {
    try {
      if (!this.audioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        this.audioContext = new AudioContextClass();
      }
      const audioCtx = this.audioContext;
      const now = audioCtx.currentTime;

      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      oscillator.type = 'square';
      oscillator.frequency.setValueAtTime(660, now);
      oscillator.frequency.linearRampToValueAtTime(1320, now + 0.12);
      gainNode.gain.setValueAtTime(0.15, now);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

      oscillator.connect(gainNode).connect(audioCtx.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.2);
    } catch (err) {
      // Web Audio unavailable - skip the cue silently.
    }
  },
};

// ---------------------------------------------------------------------------
// Sprite image loader engine
// ---------------------------------------------------------------------------

// Caches loaded HTML Image (or, for chroma-keyed sources, an offscreen
// Canvas standing in for one - both are valid ctx.drawImage() sources).
const images = {
  player: null,
  scout: null,
  interceptor: null,
  destroyer: null,
  boss1: null,
  boss2: null,
  boss3: null,
  // Selectable player ships from spaceships-for-player/ (index 0-2 -> ships 1-3).
  playerShips: [null, null, null],
};

// True once a given key has a usable sprite loaded. Every draw path checks
// this first and falls back to the existing procedural vector art when a
// file is missing or still loading, so nothing ever renders blank.
const imagesLoaded = {
  player: false,
  scout: false,
  interceptor: false,
  destroyer: false,
  boss1: false,
  boss2: false,
  boss3: false,
  playerShips: [false, false, false],
};

/**
 * Some source art (e.g. boss2) ships on a solid green chroma-key background
 * instead of real transparency. This strips it: draws the image to an
 * offscreen canvas, zeroes the alpha of any strongly green-dominant pixel,
 * and returns that canvas (a drop-in ctx.drawImage() source). Falls back to
 * the original image untouched if pixel access is blocked (e.g. a stricter
 * file:// CORS policy in some browsers) rather than crashing.
 */
function stripGreenScreen(image) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const offCtx = offscreen.getContext('2d');
  offCtx.drawImage(image, 0, 0, width, height);

  try {
    const frame = offCtx.getImageData(0, 0, width, height);
    const data = frame.data;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (g > 90 && g > r * 1.3 && g > b * 1.3) {
        data[i + 3] = 0;
      }
    }
    offCtx.putImageData(frame, 0, 0);
    return offscreen;
  } catch (err) {
    return image;
  }
}

/**
 * Strips a solid/near-white background the same way stripGreenScreen()
 * strips green - needed for formats like JPEG that can't carry real
 * transparency at all, so the source art ships with a white backing
 * instead. Harmless no-op on art that's already transparent (its
 * background pixels have alpha 0, so re-zeroing does nothing).
 */
/**
 * Prepares a player ship sprite for use: strips a solid/near-white
 * background (needed for formats like JPEG that can't carry real alpha at
 * all - e.g. Main1.jpg - and a harmless no-op on art that's already
 * transparent there), then tightly crops the result to the bounding box of
 * its actual visible pixels.
 *
 * The trim step matters a lot here: these source exports carry generous
 * padding around the ship (confirmed by inspection - e.g. Main2.webp's
 * ship only occupies the middle ~29% of its canvas height). Without
 * trimming, the padding is included in every size computed from the
 * image's raw width/height - the ship renders far smaller than expected,
 * and anything positioned relative to its edges (like where the engine
 * exhaust should emit from) ends up nowhere near the ship's visible hull.
 */
function preparePlayerShipSprite(image) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  const working = document.createElement('canvas');
  working.width = width;
  working.height = height;
  const workingCtx = working.getContext('2d');
  workingCtx.drawImage(image, 0, 0, width, height);

  try {
    const frame = workingCtx.getImageData(0, 0, width, height);
    const data = frame.data;

    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235) {
        data[i + 3] = 0;
      }
    }

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    workingCtx.putImageData(frame, 0, 0);

    if (maxX < minX || maxY < minY) {
      return working; // nothing visible found (shouldn't happen) - skip cropping
    }

    const cropWidth = maxX - minX + 1;
    const cropHeight = maxY - minY + 1;
    const cropped = document.createElement('canvas');
    cropped.width = cropWidth;
    cropped.height = cropHeight;
    cropped.getContext('2d').drawImage(working, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    return cropped;
  } catch (err) {
    // Most commonly a tainted-canvas SecurityError - happens if this ever
    // runs on an image loaded from a real file:// path instead of the
    // embedded data URIs (see loadPlayerShipSprites). Falls back to the
    // untouched original rather than crashing, but its background/padding
    // won't be cleaned up.
    console.warn('preparePlayerShipSprite: pixel access failed, using image unprocessed.', err);
    return image;
  }
}

/**
 * Returns a source's pixel aspect ratio, whether it's an HTMLImageElement
 * (naturalWidth/naturalHeight) or an offscreen Canvas (width/height).
 */
function getSpriteAspect(source) {
  const w = source.naturalWidth || source.width;
  const h = source.naturalHeight || source.height;
  return w / h;
}

/**
 * Loads an image, trying each candidate path in turn (first one that
 * actually exists wins) - this is how SCOUT/INTERCEPTOR resolve to
 * whichever of scout.png/enemy1.png or interceptor.png/enemy2.png is
 * actually present. Boss sprites are passed through stripGreenScreen() in
 * case they carry a chroma-key background. If every candidate 404s, the
 * key is simply left unloaded and the caller's vector fallback takes over.
 */
function loadSpriteImage(key, candidatePaths, index) {
  const i = index || 0;
  if (i >= candidatePaths.length) {
    markAssetSettled();
    return;
  }

  const img = new Image();
  img.onload = () => {
    images[key] = key.startsWith('boss') ? stripGreenScreen(img) : img;
    imagesLoaded[key] = true;
    markAssetSettled();
  };
  img.onerror = () => {
    loadSpriteImage(key, candidatePaths, i + 1);
  };
  img.src = candidatePaths[i];
}

// Exact confirmed filenames/extensions for the 3 selectable player ships -
// note the folder is spaceships-for-player/ (not starships-for-player/),
// mixed case, and mixed formats (jpg/webp/png).
const PLAYER_SHIP_FILES = ['Main1.jpg', 'Main2.webp', 'Main3.png'];

// Main1/Main2's source art faces left; Main3 already faces right. Flipping
// the left-facing ones mirrors them to face right, matching the direction
// the player actually flies/shoots.
const PLAYER_SHIP_FLIPS = [true, true, false];

/**
 * Loads the 3 selectable player ships from spaceships-for-player/ into
 * images.playerShips / imagesLoaded.playerShips by index, running each
 * through preparePlayerShipSprite() to strip any white background and trim
 * away the source art's padding. A missing file just leaves that index
 * unloaded - the ship-selection screen and drawPlayer() both simply skip
 * drawing that slot until it arrives, per the "no vector fallback"
 * requirement.
 */
function loadPlayerShipSprites() {
  // Prefer the embedded base64 data URIs (player-ship-assets.js, loaded via
  // its own <script> tag before this file) over the raw file:// paths.
  // Loading from a real file:// path taints the canvas the moment we
  // getImageData() on it in preparePlayerShipSprite(), which throws and
  // silently falls back to the unprocessed original image (that's exactly
  // what caused ship 1's white JPEG background to stay visible). data:
  // URIs are never treated as cross-origin, so this works identically
  // whether the page is opened directly or served over HTTP.
  const dataUris = typeof PLAYER_SHIP_DATA_URIS !== 'undefined' ? PLAYER_SHIP_DATA_URIS : null;

  for (let i = 0; i < PLAYER_SHIP_COUNT; i++) {
    const img = new Image();
    const slot = i;
    img.onload = () => {
      images.playerShips[slot] = preparePlayerShipSprite(img);
      imagesLoaded.playerShips[slot] = true;
      markAssetSettled();
    };
    img.onerror = () => {
      // Missing file - that slot is simply skipped when drawing.
      markAssetSettled();
    };
    img.src = (dataUris && dataUris[slot]) ? dataUris[slot] : `spaceships-for-player/${PLAYER_SHIP_FILES[slot]}`;
  }
}

// Drives the LOADING screen's progress bar: assetsToLoad is the total
// number of sprite loads loadAllSprites() will kick off (set once, below);
// assetsLoaded counts how many have settled (loaded OR exhausted every
// candidate path/404'd) via markAssetSettled(), so the bar always reaches
// 100% even if an asset is missing rather than stalling forever.
let assetsToLoad = 0;
let assetsLoaded = 0;

function markAssetSettled() {
  assetsLoaded += 1;
}

// Real asset loading is usually near-instant (well under a second), which
// makes the loading screen flash by too fast to read. A minimum on-screen
// duration is enforced regardless of how fast assets actually finish - the
// displayed bar (see drawLoadingScreen) is paced to this timer, not to
// assetsLoaded/assetsToLoad directly, so it fills smoothly over the full
// duration instead of jumping to 100% and then just sitting there.
const LOADING_MIN_DURATION = 10; // seconds
let loadingElapsed = 0;

/**
 * Kicks off loading for every sprite. Each entry lists its preferred
 * filename first, falling back to the actual delivered asset names.
 */
function loadAllSprites() {
  assetsToLoad = 1 + PLAYER_SHIP_COUNT + Object.keys(ENEMY_SPRITE_MAP).length + 3;
  assetsLoaded = 0;

  loadSpriteImage('player', ['starships/player.png']);
  loadPlayerShipSprites();

  // Loads every enemy variation registered in ENEMY_SPRITE_MAP (see the
  // "Enemy ships" section), using the exact filenames confirmed present in
  // the starships/ folder - no guessed names.
  for (const key of Object.keys(ENEMY_SPRITE_MAP)) {
    const mapping = ENEMY_SPRITE_MAP[key];
    loadSpriteImage(mapping.spriteKey, [`starships/${mapping.file}`]);
  }

  loadSpriteImage('boss1', ['starships/boss1.png']);
  loadSpriteImage('boss2', ['starships/boss2.png']);
  loadSpriteImage('boss3', ['starships/boss3.png']);
}

// ---------------------------------------------------------------------------
// Sprite hit-flash (alpha-masked - never a box/circle over transparent PNG areas)
// ---------------------------------------------------------------------------

// A single reusable offscreen canvas for compositing the white "hit" tint.
// Isolating the composite here (rather than doing it directly on the main
// canvas) guarantees the tint can never bleed onto anything else already
// drawn in the scene.
let flashScratchCanvas = null;
let flashScratchCtx = null;

function getFlashScratchContext(width, height) {
  if (!flashScratchCanvas) {
    flashScratchCanvas = document.createElement('canvas');
    flashScratchCtx = flashScratchCanvas.getContext('2d');
  }
  if (flashScratchCanvas.width !== width || flashScratchCanvas.height !== height) {
    flashScratchCanvas.width = width;
    flashScratchCanvas.height = height;
  } else {
    flashScratchCtx.clearRect(0, 0, width, height);
  }
  return flashScratchCtx;
}

/**
 * Returns a drawImage()-ready source for `source` with a white "hit" tint
 * baked in, using 'source-atop' compositing so the tint strictly follows
 * the sprite's own alpha channel - it can never appear as a rectangle or
 * circle over the PNG's transparent margins. Returns the original source
 * untouched when there's no flash to apply.
 */
function getFlashedSprite(source, width, height, flashAmount) {
  if (!flashAmount || flashAmount <= 0) return source;

  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  const scratch = getFlashScratchContext(w, h);

  scratch.drawImage(source, 0, 0, w, h);
  scratch.globalCompositeOperation = 'source-atop';
  scratch.globalAlpha = Math.min(flashAmount, 1) * 0.85;
  scratch.fillStyle = '#ffffff';
  scratch.fillRect(0, 0, w, h);
  scratch.globalCompositeOperation = 'source-over';
  scratch.globalAlpha = 1;

  return flashScratchCanvas;
}

/**
 * Draws a loaded sprite centered at (centerX, centerY), scaled to
 * targetWidth while preserving its natural aspect ratio, optionally
 * rotated and/or horizontally mirrored (for art that ships nose-right but
 * needs to face left, our direction of enemy travel), and optionally
 * tinted white by an alpha-masked hit flash (see getFlashedSprite) -
 * never a box or circle over the sprite's transparent margins.
 */
function drawShipSprite(source, centerX, centerY, targetWidth, rotation, flipHorizontal, flashAmount) {
  const aspect = getSpriteAspect(source);
  const width = targetWidth;
  const height = targetWidth / aspect;
  const drawSource = getFlashedSprite(source, width, height, flashAmount);

  ctx.save();
  ctx.translate(centerX, centerY);
  if (rotation) ctx.rotate(rotation);
  if (flipHorizontal) ctx.scale(-1, 1);
  ctx.drawImage(drawSource, -width / 2, -height / 2, width, height);
  ctx.restore();
}

// Clean fixed render width for the player ship; height always follows the
// equipped sprite's own native aspect ratio (see getPlayerSpriteDimensions),
// so it can never stretch/skew regardless of each source image's shape.
// Bumped up from an earlier 75px: the selectable ships (especially Main1,
// a highly detailed capital-ship painting) blurred into an unrecognizable
// blob at that size once downscaled. 120px keeps enough detail to actually
// read as the source art while staying comparable to enemy sprite sizes.
const PLAYER_SHIP_DISPLAY_WIDTH = 120;
const ENEMY_SPRITE_SCALE = 1.6; // sprite render width relative to each enemy's hitbox width

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

const player = {
  x: 0,
  y: 0,
  width: 48,
  height: 32,
  speed: 400, // pixels per second
  lives: 3,
  rotation: 0, // current visual bank angle in radians, eased toward vertical input
  shipIndex: 0, // which spaceships-for-player/ sprite is currently equipped
};

/**
 * Returns whichever image should currently represent the player: the
 * selected ship from spaceships-for-player/ if it loaded, otherwise the
 * generic starships/player.png, otherwise null (nothing loaded yet - the
 * caller simply skips drawing rather than falling back to any vector shape).
 */
function getEquippedPlayerSprite() {
  if (imagesLoaded.playerShips[player.shipIndex]) {
    return images.playerShips[player.shipIndex];
  }
  return imagesLoaded.player ? images.player : null;
}

/**
 * Computes the player's actual on-screen render size: PLAYER_SHIP_DISPLAY_WIDTH
 * wide, with height derived from the equipped sprite's true native aspect
 * ratio (source.naturalWidth / source.naturalHeight) so the art is never
 * stretched or skewed. Falls back to the hitbox dimensions only when no
 * sprite has loaded yet (nothing to measure).
 */
function getPlayerSpriteDimensions() {
  const sprite = getEquippedPlayerSprite();
  if (!sprite) {
    return { width: player.width, height: player.height };
  }
  const width = PLAYER_SHIP_DISPLAY_WIDTH;
  return { width, height: width / getSpriteAspect(sprite) };
}

// ---------------------------------------------------------------------------
// Ship selection
// ---------------------------------------------------------------------------

const PLAYER_SHIP_COUNT = 3;
const PLAYER_SHIP_LABELS = ['SHIP 1', 'SHIP 2', 'SHIP 3'];

// Persists across restarts (picking once shouldn't force reselecting every
// time the player dies) - only reset by explicitly returning to the menu.
let selectedShipIndex = 0;

// Clickable/tappable hit boxes for the ship selection screen, rebuilt every
// time drawShipSelection() runs so input handling always matches what's on
// screen (including after a resize).
let shipSelectionSlots = [];

// ---------------------------------------------------------------------------
// Ship Log ("Biography/Legend" codex) - browsable via arrow keys or the
// on-screen PREV/NEXT buttons, one entry shown at a time. Covers every
// selectable player ship plus every enemy variant and boss.
// ---------------------------------------------------------------------------

let shipLogIndex = 0;

const SHIP_LOG_ENTRIES = [
  {
    category: 'PLAYER FLEET',
    name: 'OVERDRIVE MK.I',
    spriteType: 'player',
    index: 0,
    bio: 'The first hull off the Overdrive line - a rugged, mass-produced interceptor '
      + 'with its engines pushed past rated limits to survive at the edge of Oblivion, '
      + 'trusted by rookie pilots for its forgiving handling and no-frills reliability.',
  },
  {
    category: 'PLAYER FLEET',
    name: 'OVERDRIVE MK.II',
    spriteType: 'player',
    index: 1,
    bio: 'A field-modified variant favored by veteran squadrons, trading a little armor '
      + 'for a tighter turning radius. Its scorched hull plating tells the story of every '
      + 'close call at the rift\'s edge.',
  },
  {
    category: 'PLAYER FLEET',
    name: 'OVERDRIVE MK.III',
    spriteType: 'player',
    index: 2,
    bio: 'The newest experimental prototype, built from alloy salvaged out of the '
      + 'Oblivion itself after the first Crimson Warden encounter. Sleeker and faster, '
      + 'but still unproven against what\'s coming through.',
  },
  {
    category: 'ENEMY FORCES',
    name: 'SCOUT RAIDER',
    spriteType: 'sprite',
    key: 'scout',
    flip: false,
    bio: 'A lightly-armored saucer sent ahead of every incursion to probe defenses. '
      + 'Fast and fragile - one well-placed shot ends it, but there are always more '
      + 'spilling through behind it.',
  },
  {
    category: 'ENEMY FORCES',
    name: 'INTERCEPTOR',
    spriteType: 'sprite',
    key: 'interceptor',
    flip: true,
    bio: 'A nimble strike-jet that weaves in tight sine-wave patterns to dodge return '
      + 'fire. Tougher than a Scout Raider, and rarely flies alone.',
  },
  {
    category: 'ENEMY FORCES',
    name: 'DESTROYER',
    spriteType: 'sprite',
    key: 'destroyer',
    flip: true,
    bio: 'A squat, heavily-plated gunship that trades speed for firepower. Its wide '
      + 'profile makes it an easy target, but it can absorb serious punishment before '
      + 'going down.',
  },
  {
    category: 'BOSS ENCOUNTERS',
    name: 'CRIMSON WARDEN',
    spriteType: 'sprite',
    key: 'boss1',
    flip: false,
    bio: 'The Oblivion\'s first line of command, bobbing menacingly at the edge of '
      + 'sensor range. Its crimson hull marks it as a battle-tested veteran of a dozen '
      + 'prior breaches.',
  },
  {
    category: 'BOSS ENCOUNTERS',
    name: 'VOID CORSAIR',
    spriteType: 'sprite',
    key: 'boss2',
    flip: false,
    bio: 'A raider-captain\'s flagship, notorious for sudden dash attacks that close '
      + 'the distance in an instant. Few pilots who\'ve faced it forget the sound of its '
      + 'engines igniting.',
  },
  {
    category: 'BOSS ENCOUNTERS',
    name: 'OMEGA REAPER',
    spriteType: 'sprite',
    key: 'boss3',
    flip: true,
    bio: 'The Oblivion\'s final, terrible answer - a command dreadnought built '
      + 'from the wreckage of every ship it has ever destroyed. Defeating it seals '
      + 'the breach for good.',
  },
];

/**
 * Returns the ship-selection slot index under canvas coordinates (x, y),
 * or null if the point isn't over any slot (or coordinates weren't given -
 * e.g. a keyboard-triggered confirm has no click position).
 */
function getShipSelectionSlotAt(x, y) {
  if (x === undefined || y === undefined) return null;
  for (const slot of shipSelectionSlots) {
    if (x >= slot.x && x <= slot.x + slot.width && y >= slot.y && y <= slot.y + slot.height) {
      return slot.index;
    }
  }
  return null;
}

/**
 * Locks in a ship choice and launches the game with it equipped.
 */
function confirmShipSelection(index) {
  selectedShipIndex = index;
  startGame();
}

// Set of currently-held movement keys (normalized to arrow-key direction names).
const keysPressed = new Set();

// Maps every supported key to the direction it represents.
const KEY_TO_DIRECTION = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  W: 'up',
  s: 'down',
  S: 'down',
  a: 'left',
  A: 'left',
  d: 'right',
  D: 'right',
};

// Active touch id, so we only track one finger's drag at a time.
let activeTouchId = null;

/**
 * Places the player on the left side of the screen, vertically centered.
 * Called on init and whenever the canvas is resized.
 */
function resetPlayerPosition() {
  player.x = canvas.width * 0.08;
  player.y = canvas.height / 2 - player.height / 2;
}

/**
 * Keeps the player's bounding box fully inside the canvas.
 */
function clampPlayerToBounds() {
  player.x = Math.max(0, Math.min(canvas.width - player.width, player.x));
  player.y = Math.max(0, Math.min(canvas.height - player.height, player.y));
}

// ---------------------------------------------------------------------------
// Engine exhaust particles
// ---------------------------------------------------------------------------

const exhaustParticles = [];
const EXHAUST_PARTICLES_PER_FRAME = 2;
const EXHAUST_VERTICAL_JITTER = 6; // small fixed spread, used by every ship's default single trail

// Main1 specifically needed a lower, 3-way fan trail to match its nozzle
// position and shape - ships 2/3 (and everything else) already looked
// right with the plain single trail, so this tuning only applies to
// shipIndex 0 rather than every ship.
const MAIN1_SHIP_INDEX = 0;
const MAIN1_EXHAUST_VERTICAL_OFFSET = 18; // nudges the fan's origin down to Main1's nozzle
const MAIN1_EXHAUST_FAN_SPEED = 70; // px/sec vertical bias for the two diagonal trails
// Each fan trail also starts from its own slightly offset origin (yOffset), not just a
// shared point distinguished by velocity - with the particles' short lifetime, starting
// all three at one point never gave them time/distance to visually separate into three
// tails, so they just piled up into a single fuzzy blob instead of a fan.
const MAIN1_EXHAUST_FAN = [
  { vy: -MAIN1_EXHAUST_FAN_SPEED, yOffset: -10 },
  { vy: 0, yOffset: 0 },
  { vy: MAIN1_EXHAUST_FAN_SPEED, yOffset: 10 },
];

/**
 * Spawns a few small particles at the rear of a ship, drifting backward
 * with random speed and a short, fading lifetime. Every ship gets a single
 * straight trail from its back-center, except Main1 (see
 * MAIN1_SHIP_INDEX), which fans into three diverging trails from a
 * lower origin point to match its own nozzle position/shape.
 */
function spawnExhaustParticles(ship) {
  const centerX = ship.x + ship.width / 2;
  const centerY = ship.y + ship.height / 2;
  const dims = ship === player ? getPlayerSpriteDimensions() : { width: ship.width, height: ship.height };
  const backEdgeX = centerX - dims.width / 2;

  const isMain1 = ship === player && player.shipIndex === MAIN1_SHIP_INDEX;
  const fanTrails = isMain1 ? MAIN1_EXHAUST_FAN : [{ vy: 0, yOffset: 0 }];
  const baseOriginY = isMain1 ? centerY + MAIN1_EXHAUST_VERTICAL_OFFSET : centerY;

  for (const trail of fanTrails) {
    const originY = baseOriginY + trail.yOffset;
    for (let i = 0; i < EXHAUST_PARTICLES_PER_FRAME; i++) {
      const life = randomRange(0.3, 0.6);
      exhaustParticles.push({
        x: backEdgeX,
        y: originY + randomRange(-EXHAUST_VERTICAL_JITTER, EXHAUST_VERTICAL_JITTER),
        vx: -randomRange(60, 150),
        vy: isMain1 ? trail.vy + randomRange(-15, 15) : randomRange(-30, 30),
        radius: randomRange(1.5, 3.5),
        life,
        maxLife: life,
      });
    }
  }
}

/**
 * Advances particle positions/lifetimes and prunes any that have expired.
 * @param {number} deltaTime - Seconds elapsed since the last frame.
 */
function updateExhaustParticles(deltaTime) {
  for (const particle of exhaustParticles) {
    particle.x += particle.vx * deltaTime;
    particle.y += particle.vy * deltaTime;
    particle.life -= deltaTime;
  }

  for (let i = exhaustParticles.length - 1; i >= 0; i--) {
    if (exhaustParticles[i].life <= 0) {
      exhaustParticles.splice(i, 1);
    }
  }
}

// How far behind its current position each particle's streak tail reaches,
// in seconds of its own velocity - i.e. "draw a short trail of where this
// particle was a moment ago" rather than a single round dot. Round dots at
// this particle count/lifetime just pile up into a fuzzy blob; streaks read
// as directional flame instead.
const EXHAUST_STREAK_SECONDS = 0.05;

/**
 * Draws each exhaust particle as a short glowing orange/yellow streak
 * (trailing back along its own velocity) that fades out and tapers as its
 * remaining lifetime shrinks.
 */
function drawExhaustParticles() {
  ctx.save();
  ctx.lineCap = 'round';
  for (const particle of exhaustParticles) {
    const alpha = Math.max(particle.life / particle.maxLife, 0);
    ctx.globalAlpha = alpha;
    const tailX = particle.x - particle.vx * EXHAUST_STREAK_SECONDS;
    const tailY = particle.y - particle.vy * EXHAUST_STREAK_SECONDS;
    const gradient = ctx.createLinearGradient(particle.x, particle.y, tailX, tailY);
    gradient.addColorStop(0, 'rgba(255, 230, 150, 0.9)');
    gradient.addColorStop(1, 'rgba(255, 100, 20, 0)');
    ctx.strokeStyle = gradient;
    ctx.lineWidth = particle.radius * 2;
    ctx.beginPath();
    ctx.moveTo(particle.x, particle.y);
    ctx.lineTo(tailX, tailY);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Player damage feedback (smoke + sparks)
// ---------------------------------------------------------------------------

const damageParticles = [];

/**
 * Spawns smoke (lives <= 2) and, once critical (1 life left), bright
 * sparks from the ship's wings - a visible warning that it's about to blow.
 */
function spawnDamageSmoke(ship) {
  const lives = player.lives;
  if (lives > 2) return;

  const smokeChance = lives === 1 ? 0.6 : 0.3;
  if (Math.random() < smokeChance) {
    damageParticles.push(
      createDamageParticle(ship, { r: 90, g: 90, b: 90 }, 0.5, randomRange(0.5, 0.9), randomRange(2, 5))
    );
  }

  if (lives === 1 && Math.random() < 0.4) {
    damageParticles.push(
      createDamageParticle(ship, { r: 255, g: 210, b: 120 }, 0.9, randomRange(0.1, 0.22), randomRange(1, 2))
    );
  }
}

/**
 * Builds a single damage particle emitting from one of the ship's wings.
 */
function createDamageParticle(ship, color, maxAlpha, life, radius) {
  const wingY = Math.random() < 0.5 ? ship.y + ship.height * 0.08 : ship.y + ship.height * 0.92;
  return {
    x: ship.x + ship.width * randomRange(0.15, 0.45),
    y: wingY,
    vx: -randomRange(20, 60),
    vy: randomRange(-40, -10),
    radius,
    life,
    maxLife: life,
    color,
    maxAlpha,
  };
}

/**
 * Advances damage particle positions/lifetimes and prunes expired ones.
 * @param {number} deltaTime - Seconds elapsed since the last frame.
 */
function updateDamageParticles(deltaTime) {
  for (const particle of damageParticles) {
    particle.x += particle.vx * deltaTime;
    particle.y += particle.vy * deltaTime;
    particle.life -= deltaTime;
  }

  for (let i = damageParticles.length - 1; i >= 0; i--) {
    if (damageParticles[i].life <= 0) {
      damageParticles.splice(i, 1);
    }
  }
}

/**
 * Draws smoke/spark damage particles, fading out over their lifetime.
 */
function drawDamageParticles() {
  ctx.save();
  for (const particle of damageParticles) {
    const alpha = Math.max(particle.life / particle.maxLife, 0) * particle.maxAlpha;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = `rgb(${particle.color.r}, ${particle.color.g}, ${particle.color.b})`;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Explosion/debris particles
// ---------------------------------------------------------------------------

const explosions = [];

const EXPLOSION_PARTICLE_MIN = 15;
const EXPLOSION_PARTICLE_MAX = 25;
const EXPLOSION_FRICTION = 3; // per-second velocity decay factor

// Debris colors matched to what was destroyed.
const EXPLOSION_COLORS = {
  ENEMY: ['#fff2b8', '#ffd166', '#ff8c3d', '#ff4d2e', '#3a2a22'],
  METAL: ['#8a8f97', '#4a4d52', '#2c2f33', '#1a1c1f'],
};

// Small orange spark burst for a player-hit-by-enemy-laser impact - visibly
// distinct from (and much smaller than) a full ship-destroyed explosion.
const ENEMY_LASER_SPARK_COLORS = ['#ff9a3d', '#ffd166', '#ff5d3d'];
const ENEMY_LASER_SPARK_COUNT = 8;

/**
 * Spawns a burst of debris particles at (x, y) - by default 15-25, or
 * exactly `countOverride` when given (used for smaller "spark" bursts) -
 * flying outward in all directions with varying speed. Particles slow down
 * (friction) and fade out over their lifetime, then prune themselves once dead.
 * A short-lived bright flash and a handful of dark smoke puffs are layered in
 * alongside the fire particles so the burst reads as a real explosion rather
 * than a spray of flat colored dots.
 */
function createExplosion(x, y, colors, countOverride) {
  const isSpark = Boolean(countOverride);
  const count = countOverride || Math.round(randomRange(EXPLOSION_PARTICLE_MIN, EXPLOSION_PARTICLE_MAX));

  if (!isSpark) {
    explosions.push({
      x,
      y,
      vx: 0,
      vy: 0,
      radius: randomRange(20, 30),
      color: '#ffffff',
      life: 0.12,
      maxLife: 0.12,
      kind: 'flash',
    });
  }

  for (let i = 0; i < count; i++) {
    const angle = randomRange(0, Math.PI * 2);
    const speed = randomRange(60, 260);
    const life = randomRange(0.35, 0.75);
    explosions.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: randomRange(2, 5),
      color: colors[Math.floor(Math.random() * colors.length)],
      life,
      maxLife: life,
      kind: 'fire',
    });
  }

  if (!isSpark) {
    const smokeCount = Math.round(count / 4);
    for (let i = 0; i < smokeCount; i++) {
      const angle = randomRange(0, Math.PI * 2);
      const speed = randomRange(15, 60);
      const life = randomRange(0.6, 1.1);
      explosions.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: randomRange(6, 12),
        color: '#2a2a2a',
        life,
        maxLife: life,
        kind: 'smoke',
      });
    }
  }
}

/**
 * Applies friction, advances positions/lifetimes, and prunes dead particles.
 * Smoke puffs grow as they age instead of shrinking, matching how real smoke
 * expands while it dissipates.
 * @param {number} deltaTime - Seconds elapsed since the last frame.
 */
function updateExplosions(deltaTime) {
  for (const particle of explosions) {
    const friction = Math.max(0, 1 - EXPLOSION_FRICTION * deltaTime);
    particle.vx *= friction;
    particle.vy *= friction;
    particle.x += particle.vx * deltaTime;
    particle.y += particle.vy * deltaTime;
    particle.life -= deltaTime;
    if (particle.kind === 'smoke') {
      particle.radius += deltaTime * 18;
    }
  }

  for (let i = explosions.length - 1; i >= 0; i--) {
    if (explosions[i].life <= 0) {
      explosions.splice(i, 1);
    }
  }
}

/**
 * Draws every particle. Fire particles and the initial flash use a radial
 * gradient (bright core fading to transparent) with additive blending so
 * overlapping bursts glow instead of stacking as flat colored discs; smoke
 * puffs render as soft fading gray blobs on top with normal blending.
 */
function drawExplosions() {
  ctx.save();
  for (const particle of explosions) {
    const alpha = Math.max(particle.life / particle.maxLife, 0);

    if (particle.kind === 'smoke') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = alpha * 0.35;
      ctx.fillStyle = particle.color;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }

    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha;
    const gradient = ctx.createRadialGradient(
      particle.x, particle.y, 0,
      particle.x, particle.y, particle.radius
    );
    if (particle.kind === 'flash') {
      gradient.addColorStop(0, '#ffffff');
      gradient.addColorStop(0.5, 'rgba(255, 230, 160, 0.8)');
      gradient.addColorStop(1, 'rgba(255, 180, 80, 0)');
    } else {
      gradient.addColorStop(0, '#ffffff');
      gradient.addColorStop(0.35, particle.color);
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    }
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Enemy ships
// ---------------------------------------------------------------------------

const enemies = [];

const ENEMY_SPAWN_INTERVAL = 1.5; // seconds between spawns - frequent and visible from level 1

// Every enemy variation is exclusively a real PNG from starships/ - add a
// new entry here (plus a matching images/imagesLoaded key) to register
// another downloaded ship, and spawning/quotas/rendering all pick it up
// automatically. `flip` mirrors art that ships nose-right so it faces left,
// our enemies' direction of travel; the confirmed exact filenames living in
// starships/ are enemy1.png (a saucer, so no flip needed), enemy2.png (a
// jet, nose right), and enemy3.png (a capital ship, nose right).
const ENEMY_SPRITE_MAP = {
  SCOUT: { spriteKey: 'scout', file: 'enemy1.png', flip: false },
  INTERCEPTOR: { spriteKey: 'interceptor', file: 'enemy2.png', flip: true },
  DESTROYER: { spriteKey: 'destroyer', file: 'enemy3.png', flip: true },
};

// Sizes are large on purpose so ships are impossible to miss.
const ENEMY_TYPES = {
  SCOUT: {
    width: 56, height: 56,
    minSpeed: 120, maxSpeed: 220,
    minAmplitude: 40, maxAmplitude: 120,
    minFrequency: 1.5, maxFrequency: 3,
    health: 1,
    scoreValue: 10,
    fireInterval: 2.5,
  },
  INTERCEPTOR: {
    width: 84, height: 84,
    minSpeed: 70, maxSpeed: 130,
    minAmplitude: 20, maxAmplitude: 60,
    minFrequency: 0.8, maxFrequency: 1.6,
    health: 2,
    scoreValue: 10,
    fireInterval: 1.8,
  },
  DESTROYER: {
    width: 90, height: 56,
    minSpeed: 60, maxSpeed: 110,
    minAmplitude: 20, maxAmplitude: 60,
    minFrequency: 0.6, maxFrequency: 1.4,
    health: 2,
    scoreValue: 10,
    fireInterval: 2.0,
  },
};

const ENEMY_TYPE_KEYS = Object.keys(ENEMY_TYPES); // ['SCOUT', 'INTERCEPTOR', 'DESTROYER']

// Strict equal balance: exactly 20 of each type per level (60 total here,
// scaling automatically if a new type is added to ENEMY_TYPES above).
const ENEMIES_PER_TYPE_PER_LEVEL = 20;

/**
 * Builds a { TYPE: 0, ... } counter object for every currently registered
 * enemy type, so adding a new type never requires touching this logic.
 */
function createEmptyEnemySpawnCounts() {
  const counts = {};
  for (const key of ENEMY_TYPE_KEYS) {
    counts[key] = 0;
  }
  return counts;
}

// How many of each type have spawned so far during `quotaLevel`. Reset to
// zero for all types whenever currentLevel advances past quotaLevel.
let enemySpawnCounts = createEmptyEnemySpawnCounts();
let quotaLevel = 1;

let enemySpawnTimer = 0;

/**
 * Resets the per-level spawn quotas whenever the level has changed since
 * they were last tracked.
 */
function refreshEnemyQuotasForLevel() {
  if (quotaLevel === currentLevel) return;
  quotaLevel = currentLevel;
  enemySpawnCounts = createEmptyEnemySpawnCounts();
}

/**
 * Rolls which enemy type to spawn next, chosen randomly among whichever
 * types still have quota left this level - this is what keeps all three
 * mixing together dynamically instead of spawning in rigid blocks.
 *
 * If all 60 (20 of each type) have already spawned for the level, this
 * starts a fresh quota cycle immediately rather than returning null and
 * halting spawns. The quota only resets on a level-up otherwise, and a
 * level-up depends on score, which depends on killing enemies - if enough
 * of them escape off-screen unkilled, the quota could run out before the
 * player ever earns enough score to level up, permanently starving the
 * player of enemies with no way to recover. Cycling avoids that soft-lock
 * while still keeping each cycle an even 20/20/20 mix.
 */
function pickEnemyType() {
  let available = ENEMY_TYPE_KEYS.filter((key) => enemySpawnCounts[key] < ENEMIES_PER_TYPE_PER_LEVEL);
  if (available.length === 0) {
    enemySpawnCounts = createEmptyEnemySpawnCounts();
    available = ENEMY_TYPE_KEYS;
  }
  return available[Math.floor(Math.random() * available.length)];
}

/**
 * Creates a single enemy ship just off-screen to the right. Its vertical
 * motion is a sine wave around the spawn height (baseY).
 */
function spawnEnemy() {
  const type = pickEnemyType();

  enemySpawnCounts[type] += 1;
  const config = ENEMY_TYPES[type];
  const baseY = randomRange(config.height, canvas.height - config.height);

  enemies.push({
    type,
    x: canvas.width + config.width,
    baseY,
    y: baseY,
    width: config.width,
    height: config.height,
    speed: randomRange(config.minSpeed, config.maxSpeed),
    amplitude: randomRange(config.minAmplitude, config.maxAmplitude),
    frequency: randomRange(config.minFrequency, config.maxFrequency),
    age: 0, // seconds since spawn, drives the sine wave and pulse effects
    health: config.health,
    maxHealth: config.health,
    scoreValue: config.scoreValue,
    hitFlash: 0, // 0-1, briefly flashes white when hit; fades out over time
    fireInterval: config.fireInterval,
    // Randomized initial offset so a wave of enemies doesn't all fire in sync.
    fireTimer: randomRange(0, config.fireInterval),
  });
}

/**
 * Advances spawn timers/positions, fires enemy lasers on each type's own
 * interval, and prunes off-screen enemies. Speed is scaled by
 * globalSpeedModifier so enemies surge as the level climbs.
 * @param {number} deltaTime - Seconds elapsed since the last frame.
 */
function updateEnemies(deltaTime) {
  refreshEnemyQuotasForLevel();

  // Normal spawning freezes during a boss fight (see checkBossSpawnTrigger);
  // existing enemies still move/prune below so the arena clears naturally.
  if (!bossActive) {
    enemySpawnTimer += deltaTime;
    if (enemySpawnTimer >= ENEMY_SPAWN_INTERVAL) {
      enemySpawnTimer -= ENEMY_SPAWN_INTERVAL;
      spawnEnemy();
    }
  }

  for (const enemy of enemies) {
    enemy.age += deltaTime;
    enemy.x -= enemy.speed * globalSpeedModifier * deltaTime;
    enemy.y = enemy.baseY + Math.sin(enemy.age * enemy.frequency) * enemy.amplitude;

    // Hard clamp: baseY alone doesn't account for the sine swing, so without
    // this an enemy spawned near the top/bottom edge could swing off-canvas
    // for part of its flight. This guarantees it always stays fully visible.
    const verticalMargin = enemy.height / 2 + 4;
    enemy.y = Math.max(verticalMargin, Math.min(canvas.height - verticalMargin, enemy.y));

    if (enemy.hitFlash > 0) {
      enemy.hitFlash = Math.max(0, enemy.hitFlash - deltaTime * 4);
    }

    enemy.fireTimer -= deltaTime;
    if (enemy.fireTimer <= 0) {
      fireEnemyLaser(enemy);
      enemy.fireTimer = enemy.fireInterval;
    }
  }

  // Remove enemies that have fully exited the left edge of the screen.
  for (let i = enemies.length - 1; i >= 0; i--) {
    if (enemies[i].x + enemies[i].width < 0) {
      enemies.splice(i, 1);
    }
  }
}

/**
 * Draws every active enemy exclusively as its real PNG sprite via
 * ctx.drawImage() (see drawShipSprite) - there is no vector fallback shape
 * of any kind. If a sprite hasn't finished loading yet, that enemy is
 * simply skipped for this one frame rather than drawn as a placeholder
 * shape. The hitFlash tint is alpha-masked to the sprite's own pixels, so
 * it never shows as a box or circle over its transparent margins.
 */
function drawEnemies() {
  for (const enemy of enemies) {
    const mapping = ENEMY_SPRITE_MAP[enemy.type];
    if (!mapping || !imagesLoaded[mapping.spriteKey]) continue;

    const cx = enemy.x + enemy.width / 2;
    const cy = enemy.y;
    drawShipSprite(images[mapping.spriteKey], cx, cy, enemy.width * ENEMY_SPRITE_SCALE, 0, mapping.flip, enemy.hitFlash);
  }
}

// ---------------------------------------------------------------------------
// Lasers
// ---------------------------------------------------------------------------

const lasers = [];

const LASER_WIDTH = 26;
const LASER_HEIGHT = 4;
const LASER_SPEED = 900; // pixels per second
const LASER_COOLDOWN = 1 / 5; // seconds between shots (5 shots/sec max)

// Super Contra-style plasma beam: a much bigger, faster, single hit.
const LASER_BEAM_SPEED = 1600;
const LASER_BEAM_WIDTH = 40; // collision box width
const LASER_BEAM_HEIGHT = 10; // collision box height
const LASER_BEAM_VISUAL_LENGTH = 48;

// Spread shot fans its two side lasers this many radians off center.
const SPREAD_SHOT_ANGLE = 0.35;

let laserCooldownRemaining = 0;

/**
 * Builds a single laser traveling at (vx, vy), gated to the standard
 * collision box unless overridden (used by the plasma beam).
 */
function createLaser(vx, vy, overrides) {
  return Object.assign(
    {
      x: player.x + player.width,
      y: player.y + player.height / 2 - LASER_HEIGHT / 2,
      width: LASER_WIDTH,
      height: LASER_HEIGHT,
      vx,
      vy,
      isBeam: false,
    },
    overrides
  );
}

/**
 * Fires the player's current weapon, gated by that weapon's own fire-rate
 * cooldown (see WEAPON_TYPES) so the player can't spam infinite shots.
 * NORMAL and MACHINE_GUN fire one straight laser (machine gun just cools
 * down far faster); SPREAD_SHOT fires three at once in a fan; LASER_BEAM
 * fires a single hyper-fast, thick plasma bolt.
 */
function fireLaser() {
  if (laserCooldownRemaining > 0) return;

  if (activeWeapon === 'SPREAD_SHOT') {
    lasers.push(createLaser(LASER_SPEED, 0));
    lasers.push(createLaser(LASER_SPEED * Math.cos(-SPREAD_SHOT_ANGLE), LASER_SPEED * Math.sin(-SPREAD_SHOT_ANGLE)));
    lasers.push(createLaser(LASER_SPEED * Math.cos(SPREAD_SHOT_ANGLE), LASER_SPEED * Math.sin(SPREAD_SHOT_ANGLE)));
  } else if (activeWeapon === 'LASER_BEAM') {
    lasers.push(createLaser(LASER_BEAM_SPEED, 0, { width: LASER_BEAM_WIDTH, height: LASER_BEAM_HEIGHT, isBeam: true }));
  } else {
    lasers.push(createLaser(LASER_SPEED, 0));
  }

  laserCooldownRemaining = WEAPON_TYPES[activeWeapon].cooldown;
  audioManager.playLaserSound();
}

/**
 * Advances the cooldown and every laser along its own velocity, then prunes
 * any that have left the canvas in any direction (spread-shot lasers can
 * exit through the top/bottom, not just the right edge).
 * @param {number} deltaTime - Seconds elapsed since the last frame.
 */
function updateLasers(deltaTime) {
  if (laserCooldownRemaining > 0) {
    laserCooldownRemaining -= deltaTime;
  }

  for (const laser of lasers) {
    laser.x += laser.vx * deltaTime;
    laser.y += laser.vy * deltaTime;
  }

  for (let i = lasers.length - 1; i >= 0; i--) {
    const laser = lasers[i];
    if (laser.x > canvas.width || laser.x + laser.width < 0 || laser.y > canvas.height || laser.y + laser.height < 0) {
      lasers.splice(i, 1);
    }
  }
}

/**
 * Draws every active laser as an intense energy beam, rotated to match its
 * actual travel direction (straight, or fanned out for spread shot): a
 * wide, translucent outer glow behind a thin, bright white inner core.
 * Plasma beam shots (LASER_BEAM) render longer, thicker, and in a
 * distinct magenta/purple palette so they read as a heavier weapon.
 */
function drawLasers() {
  ctx.save();
  ctx.lineCap = 'round';

  for (const laser of lasers) {
    const centerX = laser.x + laser.width / 2;
    const centerY = laser.y + laser.height / 2;
    const angle = Math.atan2(laser.vy, laser.vx);
    const halfLength = (laser.isBeam ? LASER_BEAM_VISUAL_LENGTH : LASER_WIDTH) / 2;
    const thickness = laser.isBeam ? 10 : laser.height;

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(angle);

    // Outer glow.
    ctx.strokeStyle = laser.isBeam ? 'rgba(200, 80, 255, 0.4)' : 'rgba(0, 200, 255, 0.35)';
    ctx.lineWidth = thickness * 2.5;
    ctx.shadowColor = laser.isBeam ? '#c850ff' : '#00e5ff';
    ctx.shadowBlur = laser.isBeam ? 20 : 12;
    ctx.beginPath();
    ctx.moveTo(-halfLength, 0);
    ctx.lineTo(halfLength, 0);
    ctx.stroke();

    // Bright inner core.
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(thickness * 0.5, 1);
    ctx.shadowBlur = laser.isBeam ? 8 : 4;
    ctx.beginPath();
    ctx.moveTo(-halfLength, 0);
    ctx.lineTo(halfLength, 0);
    ctx.stroke();

    ctx.restore();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Enemy lasers (the armed alien fleet shooting back)
// ---------------------------------------------------------------------------

const enemyLasers = [];

const ENEMY_LASER_WIDTH = 22;
const ENEMY_LASER_HEIGHT = 4;
const ENEMY_LASER_SPEED = 480; // pixels per second, travels leftward

/**
 * Fires one straight red laser from an enemy's nose, traveling left toward
 * the player. Called on each enemy's own fireInterval (see updateEnemies).
 */
function fireEnemyLaser(enemy) {
  enemyLasers.push({
    x: enemy.x,
    y: enemy.y - ENEMY_LASER_HEIGHT / 2,
    width: ENEMY_LASER_WIDTH,
    height: ENEMY_LASER_HEIGHT,
    speed: ENEMY_LASER_SPEED,
  });
}

/**
 * Advances enemy lasers leftward and prunes any that have exited the screen.
 * @param {number} deltaTime - Seconds elapsed since the last frame.
 */
function updateEnemyLasers(deltaTime) {
  for (const laser of enemyLasers) {
    laser.x -= laser.speed * deltaTime;
  }

  for (let i = enemyLasers.length - 1; i >= 0; i--) {
    if (enemyLasers[i].x + enemyLasers[i].width < 0) {
      enemyLasers.splice(i, 1);
    }
  }
}

/**
 * Draws every enemy laser as a red energy beam - the same core-and-glow
 * treatment as the player's laser, in a hostile red palette so the two are
 * never confused mid-fight.
 */
function drawEnemyLasers() {
  ctx.save();
  ctx.lineCap = 'round';

  for (const laser of enemyLasers) {
    const centerY = laser.y + laser.height / 2;
    const startX = laser.x + laser.width;
    const endX = laser.x;

    ctx.strokeStyle = 'rgba(255, 40, 40, 0.35)';
    ctx.lineWidth = laser.height * 2.5;
    ctx.shadowColor = '#ff2020';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(startX, centerY);
    ctx.lineTo(endX, centerY);
    ctx.stroke();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(laser.height * 0.5, 1);
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(startX, centerY);
    ctx.lineTo(endX, centerY);
    ctx.stroke();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Super Contra weapon power-ups
// ---------------------------------------------------------------------------

// 'NORMAL' is the default single-shot laser. Cooldowns are looked up here so
// fireLaser() and the HUD both stay in sync with whatever is currently active.
const WEAPON_TYPES = {
  NORMAL: { label: 'STANDARD LASER', cooldown: LASER_COOLDOWN },
  MACHINE_GUN: { label: 'MACHINE GUN', cooldown: 0.08 },
  SPREAD_SHOT: { label: 'SPREAD SHOT', cooldown: LASER_COOLDOWN },
  LASER_BEAM: { label: 'PLASMA BEAM', cooldown: LASER_COOLDOWN },
};

// Maps a capsule's letter to the weapon it grants.
const POWERUP_WEAPON_MAP = { M: 'MACHINE_GUN', S: 'SPREAD_SHOT', P: 'LASER_BEAM' };
const POWERUP_COLORS = { M: '#ff5d3d', S: '#4dff9e', P: '#00e5ff' };
// Same colors, keyed by weapon name instead of capsule letter, for the HUD.
const WEAPON_COLORS = { MACHINE_GUN: '#ff5d3d', SPREAD_SHOT: '#4dff9e', LASER_BEAM: '#00e5ff' };
const POWERUP_LETTERS = Object.keys(POWERUP_WEAPON_MAP);

const POWERUP_DROP_CHANCE = 0.15; // 15% chance per destroyed regular enemy
const POWERUP_SPEED = 130; // pixels per second
const POWERUP_RADIUS = 16;
const POWERUP_DURATION = 10; // seconds an upgraded weapon lasts before reverting

// The 1UP heart icon is still used (HUD/how-to-play), but it is no longer a
// random drop - lives are now awarded automatically every LIFE_AWARD_SCORE_INTERVAL
// points (see checkLifeAward), so the player always knows exactly when the
// next extra life is coming instead of hoping for a rare pickup.
const HEART_LETTER = 'HEART';
const HEART_COLOR = '#ff4d6d';
const MAX_PLAYER_LIVES = 5; // extra lives stop being granted once lives reach this cap
const LIFE_AWARD_SCORE_INTERVAL = 100; // grant +1 life every 100 points

let activeWeapon = 'NORMAL';
let weaponTimer = 0; // seconds remaining on the current upgrade; irrelevant while NORMAL

const powerUps = [];

// A brief banner shown on pickup ("WEAPON: X!" or "1UP! EXTRA LIFE!") - the
// pickup's "distinct message", alongside audioManager.playPickupSound()'s
// "distinct sound".
let pickupMessage = null; // { text, timer }
const PICKUP_MESSAGE_DURATION = 1.6;

/**
 * 15% chance to drop a floating weapon capsule (M/S/P) at (x, y) - called
 * whenever a regular SCOUT/INTERCEPTOR/DESTROYER is destroyed.
 */
function maybeDropPowerUp(x, y) {
  if (Math.random() > POWERUP_DROP_CHANCE) return;

  const letter = POWERUP_LETTERS[Math.floor(Math.random() * POWERUP_LETTERS.length)];

  powerUps.push({ x, y, letter, radius: POWERUP_RADIUS, age: randomRange(0, Math.PI * 2) });
}

/**
 * Drifts capsules leftward (scaled by globalSpeedModifier, like other
 * entities) and prunes any that exit the screen.
 * @param {number} deltaTime - Seconds elapsed since the last frame.
 */
function updatePowerUps(deltaTime) {
  for (const powerUp of powerUps) {
    powerUp.age += deltaTime;
    powerUp.x -= POWERUP_SPEED * globalSpeedModifier * deltaTime;
  }

  for (let i = powerUps.length - 1; i >= 0; i--) {
    if (powerUps[i].x + powerUps[i].radius < 0) {
      powerUps.splice(i, 1);
    }
  }
}

/**
 * Draws each capsule as a glowing orb in its weapon's color with the
 * classic Super Contra letter tag ('M'/'S'/'P') at its center - except the
 * 1UP heart, which renders as an actual pulsing heart shape instead.
 */
function drawPowerUps() {
  for (const powerUp of powerUps) {
    if (powerUp.letter === HEART_LETTER) {
      drawHeartPowerUp(powerUp);
      continue;
    }

    const pulse = 0.75 + Math.sin(powerUp.age * 6) * 0.25;
    const color = POWERUP_COLORS[powerUp.letter];

    ctx.save();
    ctx.globalAlpha = pulse;
    const gradient = ctx.createRadialGradient(powerUp.x, powerUp.y, 0, powerUp.x, powerUp.y, powerUp.radius);
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.5, color);
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(powerUp.x, powerUp.y, powerUp.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 18px 'Orbitron', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = 3;
    ctx.fillText(powerUp.letter, powerUp.x, powerUp.y);
    ctx.restore();
  }
}

/**
 * Traces a heart-shaped path centered at (cx, cy), sized by `size`, using
 * the classic two-bezier-lobes-plus-point construction.
 */
function traceHeartPath(cx, cy, size) {
  const top = cy - size * 0.35;
  ctx.beginPath();
  ctx.moveTo(cx, cy + size * 0.55);
  ctx.bezierCurveTo(cx - size, cy - size * 0.1, cx - size * 0.5, top - size * 0.5, cx, top);
  ctx.bezierCurveTo(cx + size * 0.5, top - size * 0.5, cx + size, cy - size * 0.1, cx, cy + size * 0.55);
  ctx.closePath();
}

/**
 * Draws the 1UP heart pickup: a glowing, pulsing red heart with a "+1" tag.
 */
function drawHeartPowerUp(powerUp) {
  const pulse = 0.8 + Math.sin(powerUp.age * 6) * 0.2;
  const size = powerUp.radius * 0.85;

  ctx.save();
  ctx.globalAlpha = pulse;
  ctx.shadowColor = HEART_COLOR;
  ctx.shadowBlur = 18;
  const gradient = ctx.createRadialGradient(powerUp.x, powerUp.y, 0, powerUp.x, powerUp.y, size * 1.6);
  gradient.addColorStop(0, '#ffffff');
  gradient.addColorStop(0.45, HEART_COLOR);
  gradient.addColorStop(1, '#8a0020');
  ctx.fillStyle = gradient;
  traceHeartPath(powerUp.x, powerUp.y, size);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 13px 'Orbitron', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
  ctx.shadowBlur = 3;
  ctx.fillText('+1', powerUp.x, powerUp.y + powerUp.radius + 12);
  ctx.restore();
}

/**
 * Grants the weapon tied to a capsule's letter, (re)starting its
 * POWERUP_DURATION countdown, and shows a brief pickup banner + cue sound.
 */
function activatePowerUp(letter) {
  activeWeapon = POWERUP_WEAPON_MAP[letter];
  weaponTimer = POWERUP_DURATION;
  pickupMessage = { text: `WEAPON: ${WEAPON_TYPES[activeWeapon].label}!`, timer: PICKUP_MESSAGE_DURATION };
  audioManager.playPickupSound();
}

/**
 * Claims a 1UP heart: grants an extra life (capped at MAX_PLAYER_LIVES) and
 * shows the pickup banner + cue sound, same as a weapon capsule.
 */
function claimHeart() {
  if (player.lives < MAX_PLAYER_LIVES) {
    player.lives += 1;
  }
  pickupMessage = { text: '1UP! EXTRA LIFE!', timer: PICKUP_MESSAGE_DURATION };
  audioManager.playPickupSound();
}

// Next score total that grants an automatic extra life; advances by
// LIFE_AWARD_SCORE_INTERVAL each time it's reached (reset in startGame).
let nextLifeAwardScore = LIFE_AWARD_SCORE_INTERVAL;

/**
 * Checks whether the score has crossed the next LIFE_AWARD_SCORE_INTERVAL
 * milestone and, if so, grants an extra life (same claimHeart banner/sound
 * as the old pickup) and advances the milestone. Uses a while loop so a
 * big single-frame score jump (e.g. a boss defeat bonus) can't skip past
 * multiple milestones at once.
 */
function checkLifeAward() {
  while (score >= nextLifeAwardScore) {
    claimHeart();
    nextLifeAwardScore += LIFE_AWARD_SCORE_INTERVAL;
  }
}

/**
 * Counts down the active weapon upgrade, reverting to NORMAL once expired.
 * @param {number} deltaTime - Seconds elapsed since the last frame.
 */
function updateWeaponTimer(deltaTime) {
  if (activeWeapon === 'NORMAL') return;
  weaponTimer -= deltaTime;
  if (weaponTimer <= 0) {
    activeWeapon = 'NORMAL';
    weaponTimer = 0;
  }
}

/**
 * Counts down the pickup banner's lifetime, if one is showing.
 * @param {number} deltaTime - Seconds elapsed since the last frame.
 */
function updatePickupMessage(deltaTime) {
  if (!pickupMessage) return;
  pickupMessage.timer -= deltaTime;
  if (pickupMessage.timer <= 0) {
    pickupMessage = null;
  }
}

/**
 * Draws the brief pickup banner ("WEAPON: X!" or "1UP! EXTRA LIFE!"),
 * fading out over its lifetime.
 */
function drawPickupMessage() {
  if (!pickupMessage) return;

  const fadeStart = 0.5;
  const alpha = pickupMessage.timer < fadeStart
    ? Math.max(pickupMessage.timer / fadeStart, 0)
    : 1;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#4dff9e';
  ctx.shadowColor = '#4dff9e';
  ctx.shadowBlur = 16;
  ctx.font = `bold ${Math.round(canvas.width * 0.024)}px 'Orbitron', monospace`;
  ctx.fillText(pickupMessage.text, canvas.width / 2, canvas.height * 0.42);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Stage bosses
// ---------------------------------------------------------------------------

let activeBoss = null;
let bossActive = false;
const BOSS_DEFEAT_SCORE = 500;

// Boss 1 (bobs smoothly up/down, fires straight forward) appears at exactly
// 500 points. Boss 2 (faster sine weave plus aggressive forward/backward
// dashes) at exactly 1000. Boss 3 - the final boss (heaviest HP, fires a
// spreading fan of aimed projectiles) - at exactly 1500. Each fires only
// once the score reaches its threshold; once boss 3 is defeated, the game
// ends in victory (see destroyBoss()).
// `flip` mirrors art that ships facing right so it faces left toward the
// player instead - boss3's source art faces right by default.
const BOSS_CONFIGS = {
  1: { key: 'boss1', name: 'CRIMSON WARDEN', hp: 15, displayWidth: 220, behavior: 'bob', scoreThreshold: 1000, flip: false },
  2: { key: 'boss2', name: 'VOID CORSAIR', hp: 30, displayWidth: 260, behavior: 'dash', scoreThreshold: 2000, flip: false },
  3: { key: 'boss3', name: 'OMEGA REAPER', hp: 50, displayWidth: 300, behavior: 'final', scoreThreshold: 3000, flip: true },
};
const BOSS_SEQUENCE = [BOSS_CONFIGS[1], BOSS_CONFIGS[2], BOSS_CONFIGS[3]];

// Index into BOSS_SEQUENCE of the next boss still to appear; once it reaches
// BOSS_SEQUENCE.length, every boss (including the final one) has been
// defeated and no more spawn.
let nextBossIndex = 0;

// Guarantees a stretch of normal enemy combat between boss fights. Without
// this, BOSS_DEFEAT_SCORE (500) exactly matches the gap between consecutive
// boss thresholds (500/1000/1500), so a boss's own defeat bonus alone was
// enough to instantly satisfy the NEXT boss's threshold - spawning it the
// very same frame, with zero regular enemies appearing in between.
let bossCooldownTimer = 0;
const BOSS_COOLDOWN_AFTER_DEFEAT = 10; // seconds of guaranteed normal combat before another boss can appear

const bossProjectiles = [];
const BOSS_PROJECTILE_SPEED = 260;
const BOSS_PROJECTILE_RADIUS = 6;

/**
 * Checks whether the score just crossed the next boss's exact threshold
 * and, if so, spawns it (unless still within the post-defeat cooldown).
 * Called every frame while playing.
 */
function checkBossSpawnTrigger() {
  if (bossActive || nextBossIndex >= BOSS_SEQUENCE.length || bossCooldownTimer > 0) return;
  const next = BOSS_SEQUENCE[nextBossIndex];
  if (score >= next.scoreThreshold) {
    spawnBoss(next);
  }
}

/**
 * Spawns a boss off-screen to the right and clears the arena for a clean,
 * dramatic entrance. Normal enemy spawning stays frozen (see the
 * `if (!bossActive)` guard in updateEnemies) until it dies.
 */
function spawnBoss(config) {
  const aspect = imagesLoaded[config.key] ? getSpriteAspect(images[config.key]) : 1.4;
  const width = config.displayWidth;
  const height = width / aspect;
  const homeX = canvas.width - width * 0.75;

  activeBoss = {
    key: config.key,
    name: config.name,
    behavior: config.behavior,
    flip: !!config.flip,
    width,
    height,
    x: canvas.width + width,
    y: canvas.height / 2 - height / 2,
    homeX,
    hp: config.hp,
    maxHp: config.hp,
    hitFlash: 0,
    age: 0,
    entered: false,
    projectileTimer: 1,
    dashState: 'idle',
    dashTimer: randomRange(1.5, 2.2),
  };
  bossActive = true;

  enemies.length = 0;
  enemyLasers.length = 0;
  bossProjectiles.length = 0;
  powerUps.length = 0;
}

/**
 * Fires one boss projectile aimed at the player's current position, with an
 * optional vertical fan offset (used for boss3's spread pattern).
 */
function fireBossProjectile(boss, fanOffset) {
  const startX = boss.x;
  const startY = boss.y + boss.height / 2;
  const targetX = player.x + player.width / 2;
  const targetY = player.y + player.height / 2;
  const dx = targetX - startX;
  const dy = targetY - startY;
  const dist = Math.max(1, Math.hypot(dx, dy));

  bossProjectiles.push({
    x: startX,
    y: startY,
    vx: (dx / dist) * BOSS_PROJECTILE_SPEED,
    vy: (dy / dist) * BOSS_PROJECTILE_SPEED + (fanOffset || 0) * 55,
    radius: BOSS_PROJECTILE_RADIUS,
  });
}

/**
 * Fires a spreading fan of aimed projectiles - boss3's signature attack,
 * hard to dodge cleanly since it covers a wide vertical band at once.
 */
function fireBossSpread(boss) {
  const shots = 5;
  for (let i = 0; i < shots; i++) {
    fireBossProjectile(boss, i - (shots - 1) / 2);
  }
}

/**
 * Drives the active boss's entrance, movement pattern, and attack timers.
 * @param {number} deltaTime - Seconds elapsed since the last frame.
 */
function updateBoss(deltaTime) {
  if (!activeBoss) return;
  const boss = activeBoss;
  boss.age += deltaTime;

  if (boss.hitFlash > 0) {
    boss.hitFlash = Math.max(0, boss.hitFlash - deltaTime * 3);
  }

  if (!boss.entered) {
    boss.x += (boss.homeX - boss.x) * Math.min(1, deltaTime * 2);
    if (Math.abs(boss.x - boss.homeX) < 2) {
      boss.entered = true;
      boss.x = boss.homeX;
    }
    return; // holds fire until fully on-screen
  }

  if (boss.behavior === 'bob') {
    boss.y = canvas.height / 2 - boss.height / 2 + Math.sin(boss.age * 1.2) * (canvas.height * 0.28);
    boss.projectileTimer -= deltaTime;
    if (boss.projectileTimer <= 0) {
      fireBossProjectile(boss, 0);
      boss.projectileTimer = 1.4;
    }
  } else if (boss.behavior === 'dash') {
    boss.y = canvas.height / 2 - boss.height / 2 + Math.sin(boss.age * 2.6) * (canvas.height * 0.32);
    boss.dashTimer -= deltaTime;

    if (boss.dashState === 'idle') {
      boss.x += (boss.homeX - boss.x) * Math.min(1, deltaTime * 4);
      if (boss.dashTimer <= 0) {
        boss.dashState = 'dashing-in';
        boss.dashTimer = 0.35;
      }
    } else if (boss.dashState === 'dashing-in') {
      boss.x += (boss.homeX * 0.55 - boss.x) * Math.min(1, deltaTime * 10);
      if (boss.dashTimer <= 0) {
        boss.dashState = 'dashing-out';
        boss.dashTimer = 0.5;
        fireBossProjectile(boss, 0);
      }
    } else if (boss.dashState === 'dashing-out') {
      boss.x += (boss.homeX - boss.x) * Math.min(1, deltaTime * 6);
      if (boss.dashTimer <= 0) {
        boss.dashState = 'idle';
        boss.dashTimer = randomRange(1.8, 2.6);
      }
    }
  } else if (boss.behavior === 'final') {
    boss.y = canvas.height / 2 - boss.height / 2 + Math.sin(boss.age * 0.9) * (canvas.height * 0.22);
    boss.projectileTimer -= deltaTime;
    if (boss.projectileTimer <= 0) {
      fireBossSpread(boss);
      boss.projectileTimer = 2.2;
    }
  }

  boss.y = Math.max(0, Math.min(canvas.height - boss.height, boss.y));
}

/**
 * Advances boss projectiles and prunes any that have left the canvas.
 * @param {number} deltaTime - Seconds elapsed since the last frame.
 */
function updateBossProjectiles(deltaTime) {
  for (const projectile of bossProjectiles) {
    projectile.x += projectile.vx * deltaTime;
    projectile.y += projectile.vy * deltaTime;
  }

  for (let i = bossProjectiles.length - 1; i >= 0; i--) {
    const p = bossProjectiles[i];
    if (p.x < -30 || p.x > canvas.width + 30 || p.y < -30 || p.y > canvas.height + 30) {
      bossProjectiles.splice(i, 1);
    }
  }
}

/**
 * Builds an AABB for the active boss (x, y are already its top-left corner).
 */
function getBossBounds(boss) {
  return { x: boss.x, y: boss.y, width: boss.width, height: boss.height };
}

/**
 * Destroys the active boss: a massive screen shake, a huge multi-colored
 * debris burst, +500 score, and resuming normal arcade spawning until the
 * next boss's threshold (if any remain) is reached.
 */
function destroyBoss() {
  const cx = activeBoss.x + activeBoss.width / 2;
  const cy = activeBoss.y + activeBoss.height / 2;

  triggerScreenShake(30, 0.7);
  createExplosion(cx, cy, EXPLOSION_COLORS.ENEMY);
  createExplosion(cx, cy, EXPLOSION_COLORS.METAL);
  createExplosion(cx, cy, ['#fff2b8', '#ffd166', '#ff8c3d', '#ff4d2e']);
  audioManager.playExplosionSound();

  score += BOSS_DEFEAT_SCORE;
  bossActive = false;
  activeBoss = null;
  nextBossIndex += 1;
  bossCooldownTimer = BOSS_COOLDOWN_AFTER_DEFEAT;

  if (nextBossIndex >= BOSS_SEQUENCE.length) {
    // That was the last boss in the sequence - the Oblivion is sealed.
    if (qualifiesForHighScore(score)) {
      saveHighScore({ name: playerName, score });
    }
    gameState = 'VICTORY';
  }
}

/**
 * Draws the active boss projectiles as glowing orange/red energy orbs,
 * visually distinct from the player's cyan lasers.
 */
function drawBossProjectiles() {
  ctx.save();
  for (const p of bossProjectiles) {
    const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius * 2);
    gradient.addColorStop(0, '#fff2b8');
    gradient.addColorStop(0.4, '#ff5d3d');
    gradient.addColorStop(1, 'rgba(255, 61, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.shadowColor = '#ff5d3d';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Draws the active boss: its real sprite (boss1/boss2/boss3.png) when
 * loaded, otherwise a large pulsating vector hulk as a seamless fallback.
 * A brief translucent white flash overlays it on every hit.
 */
function drawBoss() {
  if (!activeBoss) return;
  const boss = activeBoss;

  if (imagesLoaded[boss.key]) {
    // The hit flash is alpha-masked to the sprite's own pixels (see
    // getFlashedSprite) - never a rectangle over its transparent margins.
    const drawSource = getFlashedSprite(images[boss.key], boss.width, boss.height, boss.hitFlash);

    if (boss.flip) {
      // Mirror horizontally around the boss's own center so art that ships
      // facing right (e.g. boss3) instead faces left, toward the player.
      const cx = boss.x + boss.width / 2;
      const cy = boss.y + boss.height / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(-1, 1);
      ctx.drawImage(drawSource, -boss.width / 2, -boss.height / 2, boss.width, boss.height);
      ctx.restore();
    } else {
      ctx.drawImage(drawSource, boss.x, boss.y, boss.width, boss.height);
    }
  } else {
    drawBossFallback(boss);
  }
}

/**
 * Vector fallback boss art: a large pulsating crimson/gold hulk, used only
 * if a boss's PNG failed to load.
 */
function drawBossFallback(boss) {
  const cx = boss.x + boss.width / 2;
  const cy = boss.y + boss.height / 2;
  const radius = Math.max(boss.width, boss.height) / 2;

  const gradient = ctx.createRadialGradient(cx - radius * 0.3, cy - radius * 0.3, radius * 0.1, cx, cy, radius);
  gradient.addColorStop(0, '#ff8a5c');
  gradient.addColorStop(0.6, '#8b0000');
  gradient.addColorStop(1, '#2a0505');

  ctx.save();
  ctx.shadowColor = '#ff4d4d';
  ctx.shadowBlur = 24;
  ctx.fillStyle = gradient;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const px = cx + Math.cos(angle) * radius;
    const py = cy + Math.sin(angle) * radius;
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
  ctx.fill();

  // Hit flash: filled on the exact same octagon path, so it never extends
  // past this fallback shape's own silhouette.
  if (boss.hitFlash > 0) {
    ctx.globalAlpha = boss.hitFlash * 0.7;
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

/**
 * Draws the boss health bar, top-center, while a boss fight is active.
 */
function drawBossHealthBar() {
  if (!activeBoss) return;

  const barWidth = canvas.width * 0.5;
  const barHeight = 22;
  const x = canvas.width / 2 - barWidth / 2;
  // Leaves room above the bar for the name/HP label (drawn at y - 8); at
  // y = 16 that label's top clipped off the top edge of the canvas.
  const y = 44;
  const hpRatio = Math.max(0, activeBoss.hp / activeBoss.maxHp);

  ctx.save();

  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(x - 3, y - 3, barWidth + 6, barHeight + 6);

  const barGradient = ctx.createLinearGradient(x, y, x + barWidth, y);
  barGradient.addColorStop(0, '#ff4d4d');
  barGradient.addColorStop(1, '#ffd166');
  ctx.fillStyle = barGradient;
  ctx.fillRect(x, y, barWidth * hpRatio, barHeight);

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, barWidth, barHeight);

  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(canvas.width * 0.012)}px 'Orbitron', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
  ctx.shadowBlur = 4;
  ctx.fillText(`${activeBoss.name}   ${Math.max(0, activeBoss.hp)}/${activeBoss.maxHp}`, canvas.width / 2, y - 6);

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Collision detection
// ---------------------------------------------------------------------------

/**
 * Classic AABB overlap test between two {x, y, width, height} rectangles.
 */
function rectsOverlap(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * Overlap test between a {x, y, radius} circle and a {x, y, width, height}
 * rectangle, used for boss projectile collisions.
 */
function circleRectOverlap(circle, rect) {
  const closestX = Math.max(rect.x, Math.min(circle.x, rect.x + rect.width));
  const closestY = Math.max(rect.y, Math.min(circle.y, rect.y + rect.height));
  const dx = circle.x - closestX;
  const dy = circle.y - closestY;
  return dx * dx + dy * dy < circle.radius * circle.radius;
}

/**
 * Builds an AABB for an enemy, whose x/y represent its center-left anchor
 * (see spawnEnemy), matching the coordinate convention drawEnemies() uses.
 */
function getEnemyBounds(enemy) {
  return {
    x: enemy.x,
    y: enemy.y - enemy.height / 2,
    width: enemy.width,
    height: enemy.height,
  };
}

/**
 * Resolves all combat collisions for the current frame:
 * the player's lasers vs. enemies/boss (destroy/damage them, award score),
 * and enemies/boss/enemy lasers/boss projectiles vs. the player (lose a
 * life and reset the encounter).
 */
function checkCollisions() {
  for (let li = lasers.length - 1; li >= 0; li--) {
    const laser = lasers[li];
    let laserConsumed = false;

    if (activeBoss && rectsOverlap(laser, getBossBounds(activeBoss))) {
      activeBoss.hp -= 1;
      activeBoss.hitFlash = 1;
      laserConsumed = true;
      if (activeBoss.hp <= 0) {
        destroyBoss();
      }
    }

    if (!laserConsumed) {
      for (let ei = enemies.length - 1; ei >= 0; ei--) {
        const enemy = enemies[ei];
        if (rectsOverlap(laser, getEnemyBounds(enemy))) {
          enemy.health -= 1;
          enemy.hitFlash = 1;
          laserConsumed = true;

          if (enemy.health <= 0) {
            enemies.splice(ei, 1);
            score += enemy.scoreValue;
            audioManager.playExplosionSound();
            createExplosion(enemy.x + enemy.width / 2, enemy.y, EXPLOSION_COLORS.ENEMY);
            maybeDropPowerUp(enemy.x + enemy.width / 2, enemy.y);
            if (enemy.type === 'INTERCEPTOR') {
              triggerScreenShake(6, 0.25);
            }
          }
          break;
        }
      }
    }

    if (laserConsumed) {
      lasers.splice(li, 1);
    }
  }

  let playerHit = enemies.some((enemy) => rectsOverlap(player, getEnemyBounds(enemy)));

  if (!playerHit && activeBoss) {
    playerHit = rectsOverlap(player, getBossBounds(activeBoss));
  }

  if (!playerHit) {
    for (let pi = bossProjectiles.length - 1; pi >= 0; pi--) {
      if (circleRectOverlap(bossProjectiles[pi], player)) {
        bossProjectiles.splice(pi, 1);
        playerHit = true;
        break;
      }
    }
  }

  if (!playerHit) {
    for (let eli = enemyLasers.length - 1; eli >= 0; eli--) {
      if (rectsOverlap(enemyLasers[eli], player)) {
        enemyLasers.splice(eli, 1);
        createExplosion(player.x + player.width / 2, player.y + player.height / 2, ENEMY_LASER_SPARK_COLORS, ENEMY_LASER_SPARK_COUNT);
        playerHit = true;
        break;
      }
    }
  }

  if (playerHit) {
    handlePlayerHit();
  }

  // Power-up pickups are independent of combat damage - grabbing one never
  // costs a life.
  for (let pi = powerUps.length - 1; pi >= 0; pi--) {
    if (circleRectOverlap(powerUps[pi], player)) {
      const collected = powerUps[pi];
      powerUps.splice(pi, 1);
      if (collected.letter === HEART_LETTER) {
        claimHeart();
      } else {
        activatePowerUp(collected.letter);
      }
    }
  }
}

/**
 * Applies the consequences of the player taking a hit: lose a life, clear
 * the screen for a safe respawn window, and end the game if out of lives.
 */
function handlePlayerHit() {
  player.lives -= 1;
  enemies.length = 0;
  enemyLasers.length = 0;
  bossProjectiles.length = 0;
  audioManager.playExplosionSound();
  triggerScreenShake(18, 0.4);

  if (player.lives <= 0) {
    if (qualifiesForHighScore(score)) {
      saveHighScore({ name: playerName, score });
    }
    gameState = 'GAME_OVER';
  } else {
    resetPlayerPosition();
  }
}

// ---------------------------------------------------------------------------
// Game flow: start menu <-> playing <-> game over
// ---------------------------------------------------------------------------

/**
 * Resets all game state and enters active play. Used both for the initial
 * start (from the menu) and for restarting after a game over.
 */
function startGame() {
  score = 0;
  currentLevel = 1;
  globalSpeedModifier = 1.0;
  levelUpMessage = null;
  player.lives = 3;
  player.shipIndex = selectedShipIndex;
  enemies.length = 0;
  enemyLasers.length = 0;
  lasers.length = 0;
  exhaustParticles.length = 0;
  damageParticles.length = 0;
  explosions.length = 0;
  shakeIntensity = 0;
  shakeDuration = 0;
  laserCooldownRemaining = 0;
  activeBoss = null;
  bossActive = false;
  nextBossIndex = 0;
  bossCooldownTimer = 0;
  nextLifeAwardScore = LIFE_AWARD_SCORE_INTERVAL;
  bossProjectiles.length = 0;
  powerUps.length = 0;
  activeWeapon = 'NORMAL';
  weaponTimer = 0;
  pickupMessage = null;
  resetPlayerPosition();

  // Aliens unlock immediately: seed the spawn timer so the first enemy
  // arrives right away instead of waiting out a full interval.
  enemySpawnTimer = ENEMY_SPAWN_INTERVAL;
  enemySpawnCounts = createEmptyEnemySpawnCounts();
  quotaLevel = 1;

  gameState = 'PLAYING';
  audioManager.playMusic();
}

/**
 * Toggles between 'PLAYING' and 'PAUSED' (bound to the 'P' key). A no-op
 * from any other state (menu, game over). Pauses/resumes the background
 * music track in lockstep with the game state.
 */
function togglePause() {
  if (gameState === 'PLAYING') {
    gameState = 'PAUSED';
    if (audioManager.music) {
      audioManager.music.pause();
    }
  } else if (gameState === 'PAUSED') {
    gameState = 'PLAYING';
    // Respect an existing mute (the 'M' key) - don't resurrect music the
    // player deliberately silenced before pausing.
    if (audioManager.music && !audioManager.musicMuted) {
      audioManager.music.play().catch(() => {});
    }
  }
}

/**
 * Returns the action of whichever menu button (x, y) lands on, or null if
 * it's outside all of them (or coordinates weren't given - e.g. a
 * keyboard-triggered call has no click position). `buttons` is whichever
 * menu screen's activeMenuButtons was populated by its own draw call.
 */
function getButtonAt(buttons, x, y) {
  if (x === undefined || y === undefined) return null;
  for (const button of buttons) {
    if (x >= button.x && x <= button.x + button.width && y >= button.y && y <= button.y + button.height) {
      return button.action;
    }
  }
  return null;
}

/**
 * Routes a "primary" input (tap or click - the menu screens have no
 * catch-all "click/tap anywhere" behavior anymore, only their actual
 * buttons do anything) based on game state: START_MENU/HOW_TO_PLAY/
 * SCORE_BOARD only react to their own buttons; ship selection confirms a
 * tapped/clicked ship; PLAYING fires a laser; GAME_OVER/VICTORY return to
 * the main menu. (x, y) are canvas coordinates when available (a
 * click/tap) and undefined for a keyboard-triggered call (Spacebar).
 */
function handlePrimaryAction(x, y) {
  if (gameState === 'START_MENU' || gameState === 'ABOUT' || gameState === 'HOW_TO_PLAY' || gameState === 'SCORE_BOARD') {
    const action = getButtonAt(activeMenuButtons, x, y);
    if (action === 'START') {
      startNameEntry('SHIP_SELECTION');
    } else if (action === 'ABOUT') {
      gameState = 'ABOUT';
      aboutTab = 'STORY';
    } else if (action === 'ABOUT_TAB_STORY') {
      aboutTab = 'STORY';
    } else if (action === 'ABOUT_TAB_SHIPLOG') {
      aboutTab = 'SHIP_LOG';
    } else if (action === 'HOW_TO_PLAY') {
      gameState = 'HOW_TO_PLAY';
    } else if (action === 'SCORE') {
      gameState = 'SCORE_BOARD';
    } else if (action === 'PREV') {
      shipLogIndex = (shipLogIndex - 1 + SHIP_LOG_ENTRIES.length) % SHIP_LOG_ENTRIES.length;
    } else if (action === 'NEXT') {
      shipLogIndex = (shipLogIndex + 1) % SHIP_LOG_ENTRIES.length;
    } else if (action === 'WEBSITE') {
      window.open(ABOUT_WEBSITE_URL, '_blank', 'noopener,noreferrer');
    } else if (action === 'BACK') {
      gameState = 'START_MENU';
    }
  } else if (gameState === 'SHIP_SELECTION') {
    const hitIndex = getShipSelectionSlotAt(x, y);
    if (hitIndex !== null) {
      confirmShipSelection(hitIndex);
    }
  } else if (gameState === 'ENTER_NAME') {
    const action = getButtonAt(activeMenuButtons, x, y);
    if (action === 'CONFIRM') {
      confirmNameEntry();
    } else if (nameInputEl) {
      // Tapping anywhere else on the overlay (the text field itself, or just
      // the background) re-focuses the input - needed on mobile, where the
      // OS keyboard/focus can be dismissed by a tap outside it.
      nameInputEl.focus();
    }
  } else if (gameState === 'GAME_OVER' || gameState === 'VICTORY') {
    gameState = 'START_MENU';
  } else if (gameState === 'PLAYING') {
    fireLaser();
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Converts a touch/mouse event's page coordinates into canvas-space
 * coordinates, accounting for the canvas's CSS scaling.
 */
function getCanvasCoordinates(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

/**
 * Wires up keyboard, touch, and mouse listeners for movement and the
 * primary action (start/fire/restart).
 */
function setupInput() {
  nameInputEl = document.getElementById('nameInput');

  // The name field itself: sanitizes on every keystroke (uppercase,
  // NAME_MAX_LENGTH cap, letters/digits/space only) so what's on screen
  // always matches what confirmNameEntry() will actually save, and confirms
  // on Enter (including a mobile keyboard's "Go"/"Done" action, which also
  // fires a regular 'Enter' keydown).
  if (nameInputEl) {
    nameInputEl.addEventListener('input', () => {
      const sanitized = sanitizeNameInput(nameInputEl.value);
      nameInputEl.value = sanitized;
      nameEntryText = sanitized;
    });
    nameInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // Without this, the same Enter keystroke would go on to bubble up
        // to the window keydown handler below - which, by then, would see
        // the already-updated gameState (e.g. 'SHIP_SELECTION') and act on
        // it too, so one Enter press would confirm the name AND immediately
        // confirm ship selection.
        e.stopPropagation();
        confirmNameEntry();
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    // Ship selection has its own dedicated arrow-key/confirm handling,
    // separate from in-flight movement, so it doesn't touch keysPressed.
    if (gameState === 'SHIP_SELECTION') {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        selectedShipIndex = (selectedShipIndex - 1 + PLAYER_SHIP_COUNT) % PLAYER_SHIP_COUNT;
      } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        selectedShipIndex = (selectedShipIndex + 1) % PLAYER_SHIP_COUNT;
      } else if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        confirmShipSelection(selectedShipIndex);
      }
      return;
    }

    // Name entry is handled entirely by the real #nameInput element (see
    // its own listeners below) - typed keystrokes go there, not here, since
    // it's focused for the whole 'ENTER_NAME' state. Just don't let this
    // handler's movement/Space/P shortcuts fire underneath it.
    if (gameState === 'ENTER_NAME') {
      return;
    }

    // The Ship Log tab of the About screen browses entries with the same
    // arrow keys, independent of in-flight movement handling below.
    if (gameState === 'ABOUT' && aboutTab === 'SHIP_LOG') {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        shipLogIndex = (shipLogIndex - 1 + SHIP_LOG_ENTRIES.length) % SHIP_LOG_ENTRIES.length;
      } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        shipLogIndex = (shipLogIndex + 1) % SHIP_LOG_ENTRIES.length;
      }
      return;
    }

    const direction = KEY_TO_DIRECTION[e.key];
    if (direction) {
      keysPressed.add(direction);
      e.preventDefault();
      return;
    }

    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      handlePrimaryAction();
      return;
    }

    if (e.key === 'm' || e.key === 'M') {
      audioManager.toggleMusic();
      return;
    }

    if (e.code === 'KeyP' || e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      togglePause();
    }
  });

  window.addEventListener('keyup', (e) => {
    const direction = KEY_TO_DIRECTION[e.key];
    if (direction) {
      keysPressed.delete(direction);
      e.preventDefault();
    }
  });

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.changedTouches[0];
    activeTouchId = touch.identifier;
    const { x, y } = getCanvasCoordinates(touch.clientX, touch.clientY);

    if (gameState === 'PLAYING') {
      player.x = x - player.width / 2;
      player.y = y - player.height / 2;
      clampPlayerToBounds();
    }

    // A tap doubles as the primary action (start/shoot/restart/pick a
    // ship); it fires once here rather than on touchmove, so dragging
    // can't spam it.
    handlePrimaryAction(x, y);
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (gameState !== 'PLAYING') return;

    for (const touch of e.changedTouches) {
      if (touch.identifier === activeTouchId) {
        const { x, y } = getCanvasCoordinates(touch.clientX, touch.clientY);
        player.x = x - player.width / 2;
        player.y = y - player.height / 2;
        clampPlayerToBounds();
        break;
      }
    }
  }, { passive: false });

  const clearActiveTouch = (e) => {
    for (const touch of e.changedTouches) {
      if (touch.identifier === activeTouchId) {
        activeTouchId = null;
        break;
      }
    }
  };
  canvas.addEventListener('touchend', clearActiveTouch, { passive: false });
  canvas.addEventListener('touchcancel', clearActiveTouch, { passive: false });

  // Mouse click support: opens ship selection from the menu, picks a
  // clicked ship during selection, shoots while playing, and restarts
  // after game over.
  canvas.addEventListener('click', (e) => {
    const { x, y } = getCanvasCoordinates(e.clientX, e.clientY);
    handlePrimaryAction(x, y);
  });
}

// ---------------------------------------------------------------------------
// Core loop: init, resize, update, draw
// ---------------------------------------------------------------------------

// Both navigator.maxTouchPoints/'ontouchstart' AND the (pointer: coarse)/
// (hover: none) media features turned out to report "touch" on this user's
// desktop despite a mouse being the actual input - device/pointer detection
// is simply not reliable enough here. A phone-sized viewport is: real phones
// are at most ~500 CSS px on their short edge, so requiring BOTH portrait
// AND a narrow width is what actually distinguishes "phone held upright"
// from "desktop window," with no dependency on unreliable input detection.
const PHONE_PORTRAIT_MAX_WIDTH = 500;

/**
 * Shows/hides the "rotate your device" overlay: this is a landscape-style
 * shooter, so a phone held in portrait would otherwise just show the 16:9
 * canvas letterboxed down to a thin, barely-playable strip.
 */
function updateOrientationOverlay() {
  const overlay = document.getElementById('rotateOverlay');
  if (!overlay) return;
  const isPortrait = window.innerHeight > window.innerWidth;
  const isPhoneSized = window.innerWidth <= PHONE_PORTRAIT_MAX_WIDTH;
  const shouldShow = isPortrait && isPhoneSized;
  overlay.hidden = !shouldShow;
  // Belt-and-suspenders: also drive display directly via inline style
  // (highest CSS priority short of !important) rather than relying solely
  // on the [hidden] attribute plus a stylesheet rule - a stale cached
  // style.css (seen happening in Brave, independently of Chrome's cache)
  // could otherwise keep the overlay's own `display: flex` in effect no
  // matter what the [hidden] attribute says.
  overlay.style.display = shouldShow ? 'flex' : 'none';
}

/**
 * Resizes the canvas to the largest size that fits the window while
 * preserving a 16:9 aspect ratio.
 */
function resizeCanvas() {
  updateOrientationOverlay();

  const windowWidth = window.innerWidth;
  const windowHeight = window.innerHeight;

  let width = windowWidth;
  let height = (width * ASPECT_HEIGHT) / ASPECT_WIDTH;

  if (height > windowHeight) {
    height = windowHeight;
    width = (height * ASPECT_WIDTH) / ASPECT_HEIGHT;
  }

  canvas.width = width;
  canvas.height = height;

  clampPlayerToBounds();
}

/**
 * One-time setup: grabs canvas/context, wires up the resize handler,
 * and kicks off the game loop. gameState starts as 'START_MENU'.
 */
function init() {
  canvas = document.getElementById('gameCanvas');
  ctx = canvas.getContext('2d');

  // High-quality downscaling: our source ship art is much higher-res than
  // its on-screen display size, and the default smoothing quality can blur
  // fine detail more than necessary when shrinking it that much.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', resizeCanvas);
  resizeCanvas();
  resetPlayerPosition();
  initStars();
  initNebula();
  audioManager.init();
  loadAllSprites();
  setupInput();

  requestAnimationFrame(gameLoop);
}

/**
 * The main loop, driven by requestAnimationFrame for smooth, frame-rate
 * independent animation.
 * @param {number} timestamp - High-resolution time supplied by the browser.
 */
function gameLoop(timestamp) {
  const deltaTime = (timestamp - lastFrameTime) / 1000; // seconds
  lastFrameTime = timestamp;

  update(deltaTime);
  draw();

  requestAnimationFrame(gameLoop);
}

/**
 * Updates game state. The starfield/nebula always drift (even on the start
 * menu and game-over screen); every other system only runs while PLAYING.
 * @param {number} deltaTime - Seconds elapsed since the last frame.
 */
function update(deltaTime) {
  // Still advances while paused, so cosmetic effects like the "PAUSED"
  // banner's pulse keep animating even though the game world is frozen.
  totalElapsedTime += deltaTime;

  if (gameState === 'PAUSED') return;

  updateNebulaClouds(deltaTime);
  updateStarField(backgroundStars, deltaTime);
  updateStarField(foregroundStars, deltaTime);

  if (gameState === 'LOADING') {
    loadingElapsed += deltaTime;
    if (assetsLoaded >= assetsToLoad && loadingElapsed >= LOADING_MIN_DURATION) {
      gameState = 'START_MENU';
    }
    return;
  }

  if (gameState !== 'PLAYING') return;

  updateExhaustParticles(deltaTime);
  updateDamageParticles(deltaTime);
  updateExplosions(deltaTime);
  updateScreenShake(deltaTime);
  updateLevelUpMessage(deltaTime);
  updateWeaponTimer(deltaTime);
  updatePickupMessage(deltaTime);
  updatePowerUps(deltaTime);
  updatePlayer(deltaTime);

  // Mobile has no "held key" repeat-fire equivalent - holding a finger down
  // to drag the ship should also keep firing, the same way holding Space
  // does on desktop (via the browser's own key-repeat).
  if (activeTouchId !== null) {
    fireLaser();
  }

  updateEnemies(deltaTime);
  updateLasers(deltaTime);
  updateEnemyLasers(deltaTime);
  updateBoss(deltaTime);
  updateBossProjectiles(deltaTime);
  checkCollisions();
  checkLifeAward();
  updateLevelProgress();
  if (bossCooldownTimer > 0) {
    bossCooldownTimer -= deltaTime;
  }
  checkBossSpawnTrigger();
}

/**
 * Moves the player based on currently-held keys. Touch dragging sets the
 * player's position directly (see setupInput), so it doesn't go through here.
 * @param {number} deltaTime - Seconds elapsed since the last frame.
 */
function updatePlayer(deltaTime) {
  let dx = 0;
  let dy = 0;

  if (keysPressed.has('up')) dy -= 1;
  if (keysPressed.has('down')) dy += 1;
  if (keysPressed.has('left')) dx -= 1;
  if (keysPressed.has('right')) dx += 1;

  // Normalize so diagonal movement isn't faster than axis-aligned movement.
  if (dx !== 0 && dy !== 0) {
    const length = Math.sqrt(dx * dx + dy * dy);
    dx /= length;
    dy /= length;
  }

  player.x += dx * player.speed * deltaTime;
  player.y += dy * player.speed * deltaTime;

  // Eases toward a bank angle based on vertical input - used when rendering
  // the player sprite (see drawPlayer), a subtle touch that has no effect
  // on the vector fallback's fixed silhouette.
  const targetRotation = dy * 0.3;
  player.rotation += (targetRotation - player.rotation) * Math.min(1, deltaTime * 8);

  clampPlayerToBounds();
  spawnExhaustParticles(player);
  spawnDamageSmoke(player);
}

/**
 * Renders the current game state to the canvas.
 */
function draw() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // The gameplay layer (nebula, stars, entities) shakes on impact; the HUD
  // and menu/game-over overlays, drawn after restore(), never do.
  ctx.save();
  if (shakeDuration > 0) {
    const offsetX = randomRange(-shakeIntensity, shakeIntensity);
    const offsetY = randomRange(-shakeIntensity, shakeIntensity);
    ctx.translate(offsetX, offsetY);
  }

  drawNebulaClouds();
  drawStarField(backgroundStars, 'rgba(255, 255, 255, 0.4)');
  drawStarField(foregroundStars, 'rgba(255, 255, 255, 0.85)');

  if (gameState === 'PLAYING' || gameState === 'PAUSED' || gameState === 'GAME_OVER' || gameState === 'VICTORY') {
    // Draw order matters here: entities are drawn after the nebula/starfield
    // above, so enemies/boss/player always render on top of the background.
    drawEnemies();
    drawBoss();
    drawBossProjectiles();
    drawEnemyLasers();
    drawPowerUps();
    drawExplosions();
    drawLasers();
    drawPlayer();
  }

  ctx.restore();

  if (gameState === 'LOADING') {
    drawLoadingScreen();
  } else if (gameState === 'START_MENU') {
    drawStartMenu();
  } else if (gameState === 'ABOUT') {
    drawAboutScreen();
  } else if (gameState === 'HOW_TO_PLAY') {
    drawHowToPlay();
  } else if (gameState === 'SCORE_BOARD') {
    drawScoreBoard();
  } else if (gameState === 'SHIP_SELECTION') {
    drawShipSelection();
  } else if (gameState === 'PLAYING') {
    drawHUD();
    drawLevelUpMessage();
    drawPickupMessage();
    drawBossHealthBar();
  } else if (gameState === 'PAUSED') {
    drawHUD();
    drawBossHealthBar();
    drawPauseOverlay();
  } else if (gameState === 'ENTER_NAME') {
    drawNameEntryScreen();
  } else if (gameState === 'GAME_OVER') {
    drawHUD();
    drawGameOverScreen();
  } else if (gameState === 'VICTORY') {
    drawHUD();
    drawVictoryScreen();
  }
}

/**
 * Draws a semi-transparent dark overlay with a large, pulsing "PAUSED"
 * title over the frozen (but still rendered) gameplay frame.
 */
function drawPauseOverlay() {
  ctx.save();

  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const pulse = 0.85 + Math.sin(totalElapsedTime * 3) * 0.15;
  ctx.globalAlpha = pulse;
  ctx.fillStyle = '#00e5ff';
  ctx.shadowColor = '#00e5ff';
  ctx.shadowBlur = 24;
  ctx.font = `bold ${Math.round(canvas.width * 0.07)}px 'Orbitron', monospace`;
  ctx.fillText('PAUSED', canvas.width / 2, canvas.height / 2 - 20);
  ctx.globalAlpha = 1;

  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffffff';
  ctx.font = `${Math.round(canvas.width * 0.02)}px 'Orbitron', monospace`;
  ctx.fillText('Press P to Resume', canvas.width / 2, canvas.height / 2 + 40);

  ctx.restore();
}

/**
 * Draws the Score/Level/Lives/Weapon overlay in the top corners with a drop
 * shadow for readability against the busy starfield/gameplay behind it.
 */
function drawHUD() {
  const margin = canvas.width * 0.012;
  const lineHeight = canvas.height * 0.045;

  ctx.save();
  ctx.font = `bold ${Math.round(canvas.width * 0.016)}px 'Orbitron', monospace`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;

  ctx.textAlign = 'left';
  ctx.fillText(`Score: ${score}`, margin, margin);
  ctx.fillText(`Level: ${currentLevel}`, margin, margin + lineHeight);

  // Active weapon modifier - highlighted in its power-up color once upgraded,
  // with the remaining seconds shown so the player can see it about to expire.
  ctx.fillStyle = WEAPON_COLORS[activeWeapon] || '#ffffff';
  const weaponLabel = `Weapon: ${WEAPON_TYPES[activeWeapon].label}`;
  ctx.fillText(activeWeapon === 'NORMAL' ? weaponLabel : `${weaponLabel} (${Math.ceil(weaponTimer)}s)`, margin, margin + lineHeight * 2);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`Lives: ${player.lives}`, canvas.width - margin, margin);

  ctx.restore();
}

// Hit boxes for whichever menu screen is currently drawn (START_MENU,
// HOW_TO_PLAY, or SCORE_BOARD) - rebuilt every draw call so they always
// match what's on screen (including after a resize), and read by
// handlePrimaryAction() via getButtonAt().
let activeMenuButtons = [];

/**
 * Draws one rectangular menu button with a label, filled/stroked per the
 * given style overrides.
 */
function drawMenuButton(x, y, width, height, label, options) {
  const opts = options || {};

  ctx.save();
  ctx.fillStyle = opts.fillStyle || 'rgba(0, 20, 30, 0.55)';
  ctx.strokeStyle = opts.strokeStyle || 'rgba(0, 229, 255, 0.5)';
  ctx.lineWidth = opts.lineWidth || 3;
  ctx.shadowColor = opts.shadowColor || 'rgba(0, 229, 255, 0.5)';
  ctx.shadowBlur = opts.shadowBlur || 10;
  ctx.fillRect(x, y, width, height);
  ctx.strokeRect(x, y, width, height);

  ctx.shadowBlur = 0;
  ctx.fillStyle = opts.textColor || '#ffffff';
  ctx.font = opts.font || `bold ${Math.round(height * 0.42)}px 'Orbitron', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + width / 2, y + height / 2);
  ctx.restore();
}

/**
 * Draws a "BACK" button near the bottom of the screen and registers its
 * hit box - shared by the HOW_TO_PLAY and SCORE_BOARD screens.
 */
function drawBackButton() {
  const width = canvas.width * 0.2;
  const height = canvas.height * 0.08;
  const x = canvas.width / 2 - width / 2;
  const y = canvas.height * 0.84;

  drawMenuButton(x, y, width, height, 'BACK');
  activeMenuButtons.push({ x, y, width, height, action: 'BACK' });
}

/**
 * Renders the "LOADING" screen: the title, a "SHIELDS CHARGING..." label,
 * and a beveled progress bar. The displayed fill is the lesser of real
 * sprite-loading progress and elapsed-time progress toward
 * LOADING_MIN_DURATION - real loads finish almost instantly, so in
 * practice the time-based pace is what's visible, filling smoothly over
 * the full minimum duration instead of jumping straight to 100%.
 */
function drawLoadingScreen() {
  const assetProgress = assetsToLoad > 0 ? assetsLoaded / assetsToLoad : 1;
  const timeProgress = Math.min(loadingElapsed / LOADING_MIN_DURATION, 1);
  const progress = Math.min(assetProgress, timeProgress);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#ffd700';
  ctx.shadowColor = '#ffae00';
  ctx.shadowBlur = 24;
  ctx.font = `bold ${Math.round(canvas.width * 0.05)}px 'Orbitron', monospace`;
  ctx.fillText('SIRIUS OVERDRIVE', canvas.width / 2, canvas.height * 0.4);
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#8fe3f5';
  ctx.shadowColor = '#8fe3f5';
  ctx.shadowBlur = 10;
  ctx.font = `bold ${Math.round(canvas.width * 0.018)}px 'Orbitron', monospace`;
  ctx.fillText('SHIELDS CHARGING...', canvas.width / 2, canvas.height * 0.5);
  ctx.restore();

  const barWidth = canvas.width * 0.4;
  const barHeight = canvas.height * 0.06;
  const barX = canvas.width / 2 - barWidth / 2;
  const barY = canvas.height * 0.56;
  const padding = 4;

  ctx.save();
  ctx.fillStyle = 'rgba(0, 10, 15, 0.85)';
  ctx.fillRect(barX, barY, barWidth, barHeight);
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 3;
  ctx.shadowColor = '#00e5ff';
  ctx.shadowBlur = 14;
  ctx.strokeRect(barX, barY, barWidth, barHeight);
  ctx.shadowBlur = 0;

  const fillWidth = Math.max(0, (barWidth - padding * 2) * progress);
  if (fillWidth > 0) {
    const gradient = ctx.createLinearGradient(barX, 0, barX + barWidth, 0);
    gradient.addColorStop(0, '#00e5ff');
    gradient.addColorStop(1, '#4dff9e');
    ctx.fillStyle = gradient;
    ctx.fillRect(barX + padding, barY + padding, fillWidth, barHeight - padding * 2);
  }
  ctx.restore();

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(canvas.width * 0.016)}px 'Orbitron', monospace`;
  ctx.fillText(`${Math.round(progress * 100)}%`, canvas.width / 2, barY + barHeight + canvas.height * 0.025);
  ctx.restore();
}

/**
 * Renders the cinematic title screen: massive gold title, neon-cyan
 * subtitle, and 4 buttons (START GAME, HOW TO PLAY, SCORE, ABOUT) - each
 * screen only reacts to its own buttons now, there's no more "click/tap
 * anywhere" catch-all.
 */
function drawStartMenu() {
  activeMenuButtons = [];

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Title.
  ctx.fillStyle = '#ffd700';
  ctx.shadowColor = '#ffae00';
  ctx.shadowBlur = 30;
  ctx.font = `bold ${Math.round(canvas.width * 0.06)}px 'Orbitron', monospace`;
  ctx.fillText('SIRIUS OVERDRIVE', canvas.width / 2, canvas.height * 0.22);

  // Subtitle.
  ctx.fillStyle = '#00e5ff';
  ctx.shadowColor = '#00e5ff';
  ctx.shadowBlur = 18;
  ctx.font = `bold ${Math.round(canvas.width * 0.026)}px 'Orbitron', monospace`;
  ctx.fillText('EDGE OF OBLIVION', canvas.width / 2, canvas.height * 0.32);
  ctx.restore();

  // Buttons: all styled identically now - no button is permanently
  // highlighted/"marked" by default.
  const buttonWidth = canvas.width * 0.34;
  const buttonHeight = canvas.height * 0.075;
  const buttonX = canvas.width / 2 - buttonWidth / 2;
  const buttonGap = canvas.height * 0.025;
  const firstButtonY = canvas.height * 0.43;

  const buttons = [
    { label: 'START GAME', action: 'START' },
    { label: 'HOW TO PLAY', action: 'HOW_TO_PLAY' },
    { label: 'SCORE', action: 'SCORE' },
    { label: 'ABOUT', action: 'ABOUT' },
  ];

  buttons.forEach((button, i) => {
    const y = firstButtonY + i * (buttonHeight + buttonGap);

    drawMenuButton(buttonX, y, buttonWidth, buttonHeight, button.label, {
      font: `bold ${Math.round(canvas.width * 0.022)}px 'Orbitron', monospace`,
    });

    activeMenuButtons.push({ x: buttonX, y, width: buttonWidth, height: buttonHeight, action: button.action });
  });
}

/**
 * Renders the "HOW TO PLAY" screen: the desktop control scheme, plus a
 * BACK button to return to the start menu.
 */
/**
 * Draws one retro arcade keycap: a beveled 3D button (a darker "shadow"
 * slab behind a lighter gradient face, both outlined in a neon border) with
 * a bold label centered on its face - used to render WASD/SPACE/P/M as
 * actual key-shaped buttons instead of plain text.
 */
function drawKeycap(x, y, width, height, label, options) {
  const opts = options || {};
  const borderColor = opts.borderColor || '#00e5ff';
  const topColor = opts.topColor || '#3a4a55';
  const faceColor = opts.faceColor || '#141b21';
  const depth = Math.max(3, Math.round(height * 0.16));

  ctx.save();

  // Recessed shadow slab, offset down - gives the key a pressed-in 3D depth.
  ctx.fillStyle = '#05080a';
  ctx.fillRect(x, y + depth, width, height);

  // Key face.
  const faceGradient = ctx.createLinearGradient(x, y, x, y + height);
  faceGradient.addColorStop(0, topColor);
  faceGradient.addColorStop(1, faceColor);
  ctx.shadowColor = borderColor;
  ctx.shadowBlur = opts.glow != null ? opts.glow : 10;
  ctx.fillStyle = faceGradient;
  ctx.fillRect(x, y, width, height);
  ctx.shadowBlur = 0;

  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, width, height);

  ctx.fillStyle = opts.textColor || '#ffffff';
  ctx.font = opts.font || `bold ${Math.round(height * 0.4)}px 'Orbitron', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + width / 2, y + height / 2 - depth * 0.35);

  ctx.restore();
}

/**
 * Draws a small caption centered under a control group (a keycap, cluster,
 * or power-up capsule) on the HOW TO PLAY screen.
 */
function drawControlCaption(centerX, y, text, options) {
  const opts = options || {};
  ctx.save();
  ctx.fillStyle = opts.color || '#8fe3f5';
  ctx.font = opts.font || `bold ${Math.round(canvas.width * 0.014)}px 'Orbitron', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(text, centerX, y);
  ctx.restore();
}

/**
 * Draws the WASD movement keys as a plus-shaped cluster (W above, A/S/D in
 * a row below), centered at (centerX, centerY).
 */
function drawWasdCluster(centerX, centerY, keySize) {
  const gap = keySize * 0.15;
  drawKeycap(centerX - keySize / 2, centerY - keySize - gap, keySize, keySize, 'W');
  drawKeycap(centerX - keySize * 1.5 - gap, centerY, keySize, keySize, 'A');
  drawKeycap(centerX - keySize / 2, centerY, keySize, keySize, 'S');
  drawKeycap(centerX + keySize / 2 + gap, centerY, keySize, keySize, 'D');
}

/**
 * Renders the "HOW TO PLAY" screen as a retro arcade control panel: WASD,
 * SPACE, P, and M rendered as actual beveled, glowing keycaps, plus a row
 * of the real weapon power-up capsules (matching their in-game look) with
 * captions - a lot more evocative than a plain bullet list, and a BACK
 * button to return to the start menu.
 */
function drawHowToPlay() {
  activeMenuButtons = [];

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#ffd700';
  ctx.shadowColor = '#ffae00';
  ctx.shadowBlur = 24;
  ctx.font = `bold ${Math.round(canvas.width * 0.05)}px 'Orbitron', monospace`;
  ctx.fillText('HOW TO PLAY', canvas.width / 2, canvas.height * 0.15);
  ctx.restore();

  // --- Extra lives row (directly under the title) ------------------------
  const heartX = canvas.width / 2;
  const heartY = canvas.height * 0.23;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = HEART_COLOR;
  ctx.shadowColor = HEART_COLOR;
  ctx.shadowBlur = 12;
  ctx.font = `bold ${Math.round(canvas.width * 0.02)}px 'Orbitron', monospace`;
  ctx.fillText(`+1 LIFE EVERY ${LIFE_AWARD_SCORE_INTERVAL} POINTS`, heartX, heartY);
  ctx.restore();

  // --- Control keys row ------------------------------------------------
  const keySize = canvas.width * 0.05;
  const rowY = canvas.height * 0.42;

  const wasdCenterX = canvas.width * 0.18;
  drawWasdCluster(wasdCenterX, rowY, keySize);
  drawControlCaption(wasdCenterX, rowY + keySize * 1.35, 'MOVE');

  const spaceWidth = canvas.width * 0.24;
  const spaceX = canvas.width / 2 - spaceWidth / 2;
  drawKeycap(spaceX, rowY - keySize / 2, spaceWidth, keySize, 'SPACE', {
    borderColor: '#ffd166',
    topColor: '#4a3d1c',
    faceColor: '#1c1710',
  });
  drawControlCaption(spaceX + spaceWidth / 2, rowY + keySize * 0.85, 'FIRE WEAPON');

  const pX = canvas.width * 0.72;
  drawKeycap(pX, rowY - keySize / 2, keySize, keySize, 'P', {
    borderColor: '#4dff9e',
    topColor: '#1c3a2c',
    faceColor: '#0c1712',
  });
  drawControlCaption(pX + keySize / 2, rowY + keySize * 0.85, 'PAUSE');

  const mX = canvas.width * 0.84;
  drawKeycap(mX, rowY - keySize / 2, keySize, keySize, 'M', {
    borderColor: '#ff4d6d',
    topColor: '#3a1c26',
    faceColor: '#170c10',
  });
  drawControlCaption(mX + keySize / 2, rowY + keySize * 0.85, 'MUTE MUSIC');

  // --- Weapon power-ups row ----------------------------------------------
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#00e5ff';
  ctx.shadowColor = '#00e5ff';
  ctx.shadowBlur = 12;
  ctx.font = `bold ${Math.round(canvas.width * 0.022)}px 'Orbitron', monospace`;
  ctx.fillText('POWER-UPS FROM DESTROYED ENEMIES', canvas.width / 2, canvas.height * 0.6);
  ctx.restore();

  const capsuleY = canvas.height * 0.68;
  const capsuleRadius = canvas.width * 0.02;
  const capsuleInfo = [
    { letter: 'M', label: 'MACHINE GUN' },
    { letter: 'S', label: 'SPREAD SHOT' },
    { letter: 'P', label: 'PLASMA BEAM' },
  ];
  const capsuleXs = [canvas.width * 0.32, canvas.width * 0.5, canvas.width * 0.68];

  capsuleInfo.forEach((info, i) => {
    const cx = capsuleXs[i];
    const isHeart = info.letter === HEART_LETTER;
    const color = isHeart ? HEART_COLOR : POWERUP_COLORS[info.letter];
    const pulse = 0.75 + Math.sin(totalElapsedTime * 6 + i) * 0.25;

    ctx.save();
    ctx.globalAlpha = pulse;
    const gradient = ctx.createRadialGradient(cx, capsuleY, 0, cx, capsuleY, capsuleRadius * (isHeart ? 1.6 : 1));
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.5, color);
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    if (isHeart) {
      traceHeartPath(cx, capsuleY, capsuleRadius);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(cx, capsuleY, capsuleRadius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    if (!isHeart) {
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.round(capsuleRadius * 1.1)}px 'Orbitron', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
      ctx.shadowBlur = 3;
      ctx.fillText(info.letter, cx, capsuleY);
      ctx.restore();
    }

    drawControlCaption(cx, capsuleY + capsuleRadius * 1.5, info.label, { color: '#ffffff' });
  });

  drawBackButton();
}

/**
 * Renders the "SCORE" screen: the top-5 leaderboard pulled from
 * localStorage, plus a BACK button to return to the start menu.
 */
function drawScoreBoard() {
  activeMenuButtons = [];

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#ffd700';
  ctx.shadowColor = '#ffae00';
  ctx.shadowBlur = 24;
  ctx.font = `bold ${Math.round(canvas.width * 0.05)}px 'Orbitron', monospace`;
  ctx.fillText('TOP 5 SCORES', canvas.width / 2, canvas.height * 0.2);
  ctx.shadowBlur = 0;

  const scores = loadHighScores();
  const lineHeight = canvas.height * 0.08;
  const startY = canvas.height * 0.4;
  ctx.font = `${Math.round(canvas.width * 0.022)}px 'Orbitron', monospace`;
  for (let i = 0; i < HIGH_SCORE_COUNT; i++) {
    const entry = scores[i];
    ctx.fillStyle = entry !== undefined ? '#e6f1ff' : 'rgba(255, 255, 255, 0.3)';
    const label = entry !== undefined ? `${i + 1}.  ${entry.name}  ${entry.score}` : `${i + 1}.  ---  -----`;
    ctx.fillText(label, canvas.width / 2, startY + lineHeight * i);
  }

  ctx.restore();

  drawBackButton();
}

/**
 * Draws a small vector placeholder ship for a selection slot whose real
 * spaceships-for-player/ sprite hasn't loaded (or doesn't exist yet) - a
 * simple colored arrowhead so the slot is never blank.
 */
function drawShipSelectionPlaceholder(cx, cy, width, index) {
  const colors = ['#4fc3ff', '#4dff9e', '#ff9a3d'];
  const color = colors[index % colors.length];
  const height = width * 0.65;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(width / 2, 0);
  ctx.lineTo(-width / 2, -height / 2);
  ctx.lineTo(-width * 0.15, 0);
  ctx.lineTo(-width / 2, height / 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Renders the ship-selection screen: three ships spread horizontally over
 * the ambient starfield, each in its own highlighted slot with a label,
 * selectable via Arrow keys + Space/Enter or by clicking/tapping directly
 * on a ship. Rebuilds shipSelectionSlots every call so hit-testing always
 * matches the current layout (including after a resize).
 */
function drawShipSelection() {
  shipSelectionSlots = [];

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#ffd700';
  ctx.shadowColor = '#ffae00';
  ctx.shadowBlur = 20;
  ctx.font = `bold ${Math.round(canvas.width * 0.045)}px 'Orbitron', monospace`;
  ctx.fillText('SELECT YOUR SHIP', canvas.width / 2, canvas.height * 0.16);
  ctx.shadowBlur = 0;

  const slotSpacing = canvas.width / (PLAYER_SHIP_COUNT + 1);
  const centerY = canvas.height * 0.5;
  const shipDrawWidth = canvas.width * 0.13;
  const boxSize = shipDrawWidth * 1.5;

  for (let i = 0; i < PLAYER_SHIP_COUNT; i++) {
    const cx = slotSpacing * (i + 1);
    const isSelected = i === selectedShipIndex;

    shipSelectionSlots.push({
      x: cx - boxSize / 2,
      y: centerY - boxSize / 2,
      width: boxSize,
      height: boxSize,
      index: i,
    });

    ctx.save();
    ctx.strokeStyle = isSelected ? '#00e5ff' : 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = isSelected ? 4 : 2;
    ctx.shadowColor = isSelected ? '#00e5ff' : 'transparent';
    ctx.shadowBlur = isSelected ? 20 : 0;
    ctx.strokeRect(cx - boxSize / 2, centerY - boxSize / 2, boxSize, boxSize);
    ctx.restore();

    if (imagesLoaded.playerShips[i]) {
      // Same aspect-ratio-preserving draw path as in-game, so each option
      // looks identical here to how it'll actually appear during play.
      drawShipSprite(images.playerShips[i], cx, centerY, shipDrawWidth, 0, PLAYER_SHIP_FLIPS[i], 0);
    } else {
      drawShipSelectionPlaceholder(cx, centerY, shipDrawWidth, i);
    }

    ctx.fillStyle = isSelected ? '#00e5ff' : '#ffffff';
    ctx.shadowColor = isSelected ? '#00e5ff' : 'transparent';
    ctx.shadowBlur = isSelected ? 10 : 0;
    ctx.font = `bold ${Math.round(canvas.width * 0.02)}px 'Orbitron', monospace`;
    ctx.fillText(PLAYER_SHIP_LABELS[i], cx, centerY + boxSize / 2 + canvas.height * 0.05);
  }

  // Flashing confirm prompt.
  const flashAlpha = 0.5 + Math.sin(totalElapsedTime * 4) * 0.5;
  ctx.save();
  ctx.globalAlpha = flashAlpha;
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 12;
  ctx.font = `bold ${Math.round(canvas.width * 0.018)}px 'Orbitron', monospace`;
  ctx.fillText('ARROWS to Choose  -  SPACE or CLICK a Ship to Confirm', canvas.width / 2, canvas.height * 0.88);
  ctx.restore();

  ctx.restore();
}

/**
 * Breaks `text` into lines no wider than maxWidth (measured with the
 * context's current font), wrapping on word boundaries.
 */
function wrapText(text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Credit shown at the bottom of the ABOUT screen; clicking/tapping it opens
// the creator's website in a new tab.
const ABOUT_AUTHOR_LABEL = 'Created by Lone Coder';
const ABOUT_WEBSITE_URL = 'https://lonecoder.nsh.one';

// Which half of the ABOUT screen is showing - toggled by its own tab
// buttons, independent of BACK (which always returns to the start menu).
let aboutTab = 'STORY';

/**
 * Renders the STORY tab's content (the backstory paragraphs) within the
 * vertical band [topY, bottomY].
 */
function drawAboutStoryTab(topY, bottomY) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.font = `${Math.round(canvas.width * 0.016)}px 'Orbitron', monospace`;
  const storyParagraphs = [
    'At the far edge of the Sirius system, a tear in space called the '
      + 'Oblivion has been swallowing ships, stations, and starlight itself - '
      + 'and spitting out hostile war-machines in return.',
    'Scout raiders spill through first to probe for weakness, interceptors '
      + 'and destroyers follow to hold the breach open, and titanic command '
      + 'warships anchor its deepest incursions.',
    'Sirius Overdrive is the emergency program that pushed standard fighter '
      + 'engines past every safety limit - your engines - to give a pilot any '
      + 'chance of surviving at the edge of Oblivion.',
    'Punch through, hold the line, and drive it back to whatever waits on '
      + 'the other side.',
  ];
  const maxWidth = canvas.width * 0.7;
  const lineHeight = canvas.height * 0.035;
  let y = topY;
  for (const paragraph of storyParagraphs) {
    const lines = wrapText(paragraph, maxWidth);
    for (const line of lines) {
      if (y > bottomY) break;
      ctx.fillText(line, canvas.width / 2, y);
      y += lineHeight;
    }
    y += lineHeight * 0.4;
  }
  ctx.restore();
}

/**
 * Renders the SHIP LOG tab's content (one entry at a time, browsable) within
 * the vertical band [topY, bottomY].
 */
function drawAboutShipLogTab(topY, bottomY) {
  const entry = SHIP_LOG_ENTRIES[shipLogIndex];
  const bandHeight = bottomY - topY;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#8fe3f5';
  ctx.font = `bold ${Math.round(canvas.width * 0.018)}px 'Orbitron', monospace`;
  ctx.fillText(entry.category, canvas.width / 2, topY);
  ctx.restore();

  const spriteCenterX = canvas.width * 0.26;
  const spriteCenterY = topY + bandHeight * 0.45;
  const spriteWidth = canvas.width * 0.15;
  const boxSize = spriteWidth * 1.3;

  ctx.save();
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 3;
  ctx.shadowColor = '#00e5ff';
  ctx.shadowBlur = 16;
  ctx.strokeRect(spriteCenterX - boxSize / 2, spriteCenterY - boxSize / 2, boxSize, boxSize);
  ctx.restore();

  let sprite = null;
  let flip = false;
  if (entry.spriteType === 'player') {
    if (imagesLoaded.playerShips[entry.index]) {
      sprite = images.playerShips[entry.index];
      flip = PLAYER_SHIP_FLIPS[entry.index];
    }
  } else if (imagesLoaded[entry.key]) {
    sprite = images[entry.key];
    flip = entry.flip;
  }

  if (sprite) {
    // Fit the sprite fully inside the box on both axes - a tall/portrait
    // boss sprite drawn at the full spriteWidth would otherwise overflow
    // the box vertically, since drawShipSprite only scales to a target
    // width and preserves aspect.
    let drawWidth = spriteWidth;
    const aspect = getSpriteAspect(sprite);
    if (drawWidth / aspect > boxSize) {
      drawWidth = boxSize * aspect;
    }
    drawShipSprite(sprite, spriteCenterX, spriteCenterY, drawWidth, 0, flip, 0);
  } else {
    drawShipSelectionPlaceholder(spriteCenterX, spriteCenterY, spriteWidth, shipLogIndex);
  }

  // --- Name + bio panel ---------------------------------------------------
  const textX = canvas.width * 0.5;
  const textMaxWidth = canvas.width * 0.42;

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#00e5ff';
  ctx.shadowBlur = 10;
  ctx.font = `bold ${Math.round(canvas.width * 0.022)}px 'Orbitron', monospace`;
  ctx.fillText(entry.name, textX, topY + bandHeight * 0.14);
  ctx.shadowBlur = 0;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.font = `${Math.round(canvas.width * 0.016)}px 'Orbitron', monospace`;
  const lineHeight = canvas.height * 0.035;
  const lines = wrapText(entry.bio, textMaxWidth);
  lines.forEach((line, i) => {
    ctx.fillText(line, textX, topY + bandHeight * 0.26 + i * lineHeight);
  });
  ctx.restore();

  // --- PREV / NEXT browse buttons (below the ship square) ----------------
  const navWidth = canvas.width * 0.09;
  const navHeight = canvas.height * 0.045;
  const navY = spriteCenterY + boxSize / 2 + canvas.height * 0.025;

  const prevX = spriteCenterX - navWidth * 1.3;
  drawMenuButton(prevX, navY, navWidth, navHeight, '<', { font: `bold ${Math.round(canvas.width * 0.026)}px 'Orbitron', monospace` });
  activeMenuButtons.push({ x: prevX, y: navY, width: navWidth, height: navHeight, action: 'PREV' });

  const nextX = spriteCenterX + navWidth * 0.3;
  drawMenuButton(nextX, navY, navWidth, navHeight, '>', { font: `bold ${Math.round(canvas.width * 0.026)}px 'Orbitron', monospace` });
  activeMenuButtons.push({ x: nextX, y: navY, width: navWidth, height: navHeight, action: 'NEXT' });

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.font = `${Math.round(canvas.width * 0.012)}px 'Orbitron', monospace`;
  ctx.fillText(`${shipLogIndex + 1} / ${SHIP_LOG_ENTRIES.length}`, spriteCenterX, navY + navHeight + canvas.height * 0.018);
  ctx.restore();
}

/**
 * Renders the "ABOUT" screen: a STORY / SHIP LOG tab switcher (STORY
 * explains why the player's Overdrive ships and the forces of the Oblivion
 * are fighting; SHIP LOG is the browsable ship codex), a credits line
 * crediting the game's creator with a clickable website link, and a BACK
 * button to return to the start menu.
 */
function drawAboutScreen() {
  activeMenuButtons = [];

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffd700';
  ctx.shadowColor = '#ffae00';
  ctx.shadowBlur = 24;
  ctx.font = `bold ${Math.round(canvas.width * 0.05)}px 'Orbitron', monospace`;
  ctx.fillText('ABOUT', canvas.width / 2, canvas.height * 0.1);
  ctx.restore();

  // --- Tab buttons ---------------------------------------------------------
  const tabWidth = canvas.width * 0.2;
  const tabHeight = canvas.height * 0.055;
  const tabGap = canvas.width * 0.02;
  const tabY = canvas.height * 0.16;
  const storyTabX = canvas.width / 2 - tabWidth - tabGap / 2;
  const shipLogTabX = canvas.width / 2 + tabGap / 2;

  const isStoryTab = aboutTab === 'STORY';
  drawMenuButton(storyTabX, tabY, tabWidth, tabHeight, 'STORY', {
    fillStyle: isStoryTab ? 'rgba(0, 60, 75, 0.65)' : 'rgba(0, 20, 30, 0.55)',
    strokeStyle: isStoryTab ? '#00e5ff' : 'rgba(0, 229, 255, 0.5)',
    shadowBlur: isStoryTab ? 16 : 8,
    font: `bold ${Math.round(canvas.width * 0.018)}px 'Orbitron', monospace`,
  });
  activeMenuButtons.push({ x: storyTabX, y: tabY, width: tabWidth, height: tabHeight, action: 'ABOUT_TAB_STORY' });

  const isShipLogTab = aboutTab === 'SHIP_LOG';
  drawMenuButton(shipLogTabX, tabY, tabWidth, tabHeight, 'SHIP LOG', {
    fillStyle: isShipLogTab ? 'rgba(0, 60, 75, 0.65)' : 'rgba(0, 20, 30, 0.55)',
    strokeStyle: isShipLogTab ? '#00e5ff' : 'rgba(0, 229, 255, 0.5)',
    shadowBlur: isShipLogTab ? 16 : 8,
    font: `bold ${Math.round(canvas.width * 0.018)}px 'Orbitron', monospace`,
  });
  activeMenuButtons.push({ x: shipLogTabX, y: tabY, width: tabWidth, height: tabHeight, action: 'ABOUT_TAB_SHIPLOG' });

  // --- Tab content -----------------------------------------------------------
  const contentTop = canvas.height * 0.25;
  const contentBottom = canvas.height * 0.72;
  if (isStoryTab) {
    drawAboutStoryTab(contentTop, contentBottom);
  } else {
    drawAboutShipLogTab(contentTop, contentBottom);
  }

  // --- Credits footer --------------------------------------------------------
  // "Created by Lone Coder" itself is the clickable link to ABOUT_WEBSITE_URL
  // (via the shared 'WEBSITE' action) - no separate URL line shown.
  const creditY = canvas.height * 0.77;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#00e5ff';
  ctx.shadowColor = '#00e5ff';
  ctx.shadowBlur = 10;
  ctx.font = `bold ${Math.round(canvas.width * 0.015)}px 'Orbitron', monospace`;
  ctx.fillText(ABOUT_AUTHOR_LABEL, canvas.width / 2, creditY);
  const creditTextWidth = ctx.measureText(ABOUT_AUTHOR_LABEL).width;
  ctx.restore();

  const creditHitWidth = creditTextWidth + canvas.width * 0.04;
  const creditHitHeight = canvas.height * 0.045;
  activeMenuButtons.push({
    x: canvas.width / 2 - creditHitWidth / 2,
    y: creditY - creditHitHeight / 2,
    width: creditHitWidth,
    height: creditHitHeight,
    action: 'WEBSITE',
  });

  drawBackButton();
}

/**
 * Renders the classic-arcade "ENTER YOUR NAME" overlay shown right after
 * START, before ship selection: a single typed line (up to NAME_MAX_LENGTH
 * characters, real keystrokes via the focused #nameInput element - see
 * setupInput()) with a blinking cursor, and a CONFIRM button/Enter key that
 * saves it via confirmNameEntry() and proceeds to SHIP_SELECTION. This name
 * is then reused automatically for any top-5 leaderboard entry the run earns.
 */
function drawNameEntryScreen() {
  activeMenuButtons = [];

  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#ffd700';
  ctx.shadowColor = '#ffae00';
  ctx.shadowBlur = 24;
  ctx.font = `bold ${Math.round(canvas.width * 0.036)}px 'Orbitron', monospace`;
  ctx.fillText('ENTER YOUR NAME', canvas.width / 2, canvas.height * 0.36);
  ctx.shadowBlur = 0;

  // A classic blinking text cursor, ~2Hz.
  const cursorOn = Math.floor(totalElapsedTime * 2) % 2 === 0;
  const displayText = nameEntryText + (cursorOn ? '_' : ' ');

  ctx.fillStyle = '#00e5ff';
  ctx.shadowColor = '#00e5ff';
  ctx.shadowBlur = 12;
  ctx.font = `bold ${Math.round(canvas.width * 0.045)}px 'Orbitron', monospace`;
  ctx.fillText(displayText, canvas.width / 2, canvas.height * 0.48);
  ctx.shadowBlur = 0;

  const lineWidth = canvas.width * 0.4;
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.6)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2 - lineWidth / 2, canvas.height * 0.53);
  ctx.lineTo(canvas.width / 2 + lineWidth / 2, canvas.height * 0.53);
  ctx.stroke();

  const btnWidth = canvas.width * 0.22;
  const btnHeight = canvas.height * 0.08;
  const btnX = canvas.width / 2 - btnWidth / 2;
  const btnY = canvas.height * 0.65;
  drawMenuButton(btnX, btnY, btnWidth, btnHeight, 'CONFIRM', { fillStyle: 'rgba(0, 60, 20, 0.6)', strokeStyle: '#4dff9e', shadowColor: '#4dff9e' });
  activeMenuButtons.push({ x: btnX, y: btnY, width: btnWidth, height: btnHeight, action: 'CONFIRM' });

  ctx.font = `${Math.round(canvas.width * 0.012)}px 'Orbitron', monospace`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.fillText('Press ENTER to Confirm', canvas.width / 2, canvas.height * 0.78);

  ctx.restore();
}

/**
 * Draws a centered "GAME OVER" overlay with the final score and a
 * restart prompt, on top of the frozen gameplay frame.
 */
function drawGameOverScreen() {
  ctx.save();

  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#ff4d6d';
  ctx.font = `bold ${Math.round(canvas.width * 0.036)}px 'Orbitron', monospace`;
  ctx.fillText('GAME OVER', canvas.width / 2, canvas.height / 2 - 40);

  ctx.fillStyle = '#ffffff';
  ctx.font = `${Math.round(canvas.width * 0.021)}px 'Orbitron', monospace`;
  ctx.fillText(`Final Score: ${score}`, canvas.width / 2, canvas.height / 2 + 20);

  ctx.font = `${Math.round(canvas.width * 0.015)}px 'Orbitron', monospace`;
  ctx.fillText('Press Space or Tap for Main Menu', canvas.width / 2, canvas.height / 2 + 60);

  ctx.restore();
}

/**
 * Draws the victory overlay after the final boss is defeated: a
 * congratulations message, the final score, and a restart prompt, on top
 * of the frozen gameplay frame.
 */
function drawVictoryScreen() {
  ctx.save();

  ctx.fillStyle = 'rgba(0, 15, 10, 0.7)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#ffd700';
  ctx.shadowColor = '#ffae00';
  ctx.shadowBlur = 30;
  ctx.font = `bold ${Math.round(canvas.width * 0.045)}px 'Orbitron', monospace`;
  ctx.fillText('CONGRATULATIONS!', canvas.width / 2, canvas.height / 2 - 70);

  ctx.fillStyle = '#4dff9e';
  ctx.shadowColor = '#4dff9e';
  ctx.shadowBlur = 16;
  ctx.font = `bold ${Math.round(canvas.width * 0.024)}px 'Orbitron', monospace`;
  ctx.fillText('YOU SEALED THE EDGE OF OBLIVION!', canvas.width / 2, canvas.height / 2 - 20);
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#ffffff';
  ctx.font = `${Math.round(canvas.width * 0.021)}px 'Orbitron', monospace`;
  ctx.fillText(`Final Score: ${score}`, canvas.width / 2, canvas.height / 2 + 30);

  ctx.font = `${Math.round(canvas.width * 0.015)}px 'Orbitron', monospace`;
  ctx.fillText('Press Space or Tap for Main Menu', canvas.width / 2, canvas.height / 2 + 70);

  ctx.restore();
}

/**
 * Draws the player's ship exclusively as its real PNG/JPEG/WebP sprite via
 * ctx.drawImage() (see drawShipSprite) - there is no vector fallback shape
 * of any kind. Rendered at a fixed PLAYER_SHIP_DISPLAY_WIDTH with height
 * derived from the sprite's own native aspect ratio, so it's never
 * stretched or skewed regardless of each ship's actual proportions. If no
 * sprite has loaded yet, the ship is simply skipped for this one frame.
 */
function drawPlayer() {
  drawExhaustParticles();

  const usingSelectedShip = imagesLoaded.playerShips[player.shipIndex];
  const sprite = getEquippedPlayerSprite();

  if (sprite) {
    const centerX = player.x + player.width / 2;
    const centerY = player.y + player.height / 2;
    const flip = usingSelectedShip && PLAYER_SHIP_FLIPS[player.shipIndex];
    drawShipSprite(sprite, centerX, centerY, PLAYER_SHIP_DISPLAY_WIDTH, player.rotation, flip);
  }

  drawDamageParticles();
}

window.addEventListener('DOMContentLoaded', init);
