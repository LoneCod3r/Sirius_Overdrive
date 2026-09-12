// Headless-browser smoke test for CI: loads the real game in a real
// Chromium instance and drives it through the core state machine and
// mechanics, the same way a human QA pass would - catching regressions
// that a plain `node --check` syntax check can't (broken state
// transitions, thrown runtime errors, a mechanic silently no-op'ing).
//
// Exits non-zero (failing the CI job) if any assertion fails or if the
// page throws/logs an error other than the one pre-existing, harmless
// 404 (starships/player.png - an intentional missing-file fallback, see
// loadAllSprites() in game.js).

const { chromium } = require('playwright');

const BASE_URL = process.env.SMOKE_TEST_URL || 'http://localhost:8080';
const KNOWN_BENIGN_ERROR_SUBSTRING = 'starships/player.png';

const failures = [];

function check(label, condition) {
  if (!condition) failures.push(label);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const unexpectedErrors = [];
  page.on('pageerror', (e) => unexpectedErrors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // The browser's own "Failed to load resource" network-failure log never
    // includes the URL in msg.text() - only page.on('response') below does -
    // so a real script-level console.error() is what's actually meaningful
    // to catch here; skip the generic network-failure mirror entirely.
    if (msg.text().includes('Failed to load resource')) return;
    unexpectedErrors.push(`console: ${msg.text()}`);
  });
  // Every failed HTTP response, checked by URL (unlike the console message
  // above) so the one known-benign 404 (starships/player.png - an
  // intentional missing-file fallback, see loadAllSprites() in game.js) can
  // be told apart from any other, unexpected one.
  page.on('response', (response) => {
    if (response.status() < 400) return;
    if (response.url().includes(KNOWN_BENIGN_ERROR_SUBSTRING)) return;
    unexpectedErrors.push(`HTTP ${response.status()}: ${response.url()}`);
  });

  await page.goto(`${BASE_URL}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof gameState !== 'undefined', { timeout: 15000 });

  // --- Loading screen: the 10s retro duration must stay intact ---------
  const loadingMinDuration = await page.evaluate(() => LOADING_MIN_DURATION);
  check('LOADING_MIN_DURATION is 10 seconds', loadingMinDuration === 10);
  check('Initial state is LOADING', (await page.evaluate(() => gameState)) === 'LOADING');

  // --- Menu screens render and expose their buttons ---------------------
  await page.evaluate(() => { gameState = 'START_MENU'; draw(); });
  const startMenuActions = await page.evaluate(() => activeMenuButtons.map((b) => b.action));
  check(
    'Start menu has START/HOW_TO_PLAY/SCORE/ABOUT buttons',
    ['START', 'HOW_TO_PLAY', 'SCORE', 'ABOUT'].every((a) => startMenuActions.includes(a)),
  );

  await page.evaluate(() => { gameState = 'ABOUT'; aboutTab = 'STORY'; draw(); });
  check('About screen STORY tab renders', (await page.evaluate(() => gameState === 'ABOUT' && aboutTab === 'STORY')));
  await page.evaluate(() => { aboutTab = 'SHIP_LOG'; draw(); });
  check(
    'About screen SHIP_LOG tab has entries',
    await page.evaluate(() => typeof SHIP_LOG_ENTRIES !== 'undefined' && SHIP_LOG_ENTRIES.length > 0),
  );

  await page.evaluate(() => { gameState = 'HOW_TO_PLAY'; draw(); });
  check('HOW_TO_PLAY state reachable', (await page.evaluate(() => gameState)) === 'HOW_TO_PLAY');

  await page.evaluate(() => { gameState = 'SCORE_BOARD'; draw(); });
  check('SCORE_BOARD state reachable', (await page.evaluate(() => gameState)) === 'SCORE_BOARD');

  // --- Full flow: name entry -> ship selection -> playing ---------------
  await page.evaluate(() => { gameState = 'START_MENU'; draw(); });
  const startBtn = await page.evaluate(() => activeMenuButtons.find((b) => b.action === 'START'));
  await page.mouse.click(startBtn.x + startBtn.width / 2, startBtn.y + startBtn.height / 2);
  check('Clicking START enters ENTER_NAME', (await page.evaluate(() => gameState)) === 'ENTER_NAME');

  await page.keyboard.type('QaBot', { delay: 10 });
  check('Typed name keeps mixed case (no forced uppercase)', (await page.evaluate(() => nameEntryText)) === 'QaBot');

  await page.keyboard.press('Enter');
  check('Confirming name enters SHIP_SELECTION', (await page.evaluate(() => gameState)) === 'SHIP_SELECTION');
  check('playerName saved with typed casing', (await page.evaluate(() => playerName)) === 'QaBot');

  await page.evaluate(() => { confirmShipSelection(0); });
  check('Confirming a ship enters PLAYING', (await page.evaluate(() => gameState)) === 'PLAYING');

  // --- Pause toggles state and the music track together -----------------
  await page.evaluate(() => { audioManager.musicStarted = true; togglePause(); });
  check('P toggles to PAUSED', (await page.evaluate(() => gameState)) === 'PAUSED');
  const musicPausedWhilePaused = await page.evaluate(() => (audioManager.music ? audioManager.music.paused : true));
  check('Music pauses alongside PAUSED', musicPausedWhilePaused === true);
  await page.evaluate(() => { togglePause(); });
  check('P toggles back to PLAYING', (await page.evaluate(() => gameState)) === 'PLAYING');

  // --- Mute silences sound effects, not just music -----------------------
  const muteResult = await page.evaluate(() => {
    let plays = 0;
    const fakeSound = { cloneNode: () => ({ volume: 0, play: () => { plays++; return Promise.resolve(); } }) };
    audioManager.laserSound = fakeSound;
    audioManager.muted = false;
    audioManager.playLaserSound();
    const beforeMute = plays;
    audioManager.toggleMute();
    audioManager.playLaserSound();
    const afterMute = plays;
    audioManager.toggleMute();
    return { beforeMute, afterMute };
  });
  check('Laser sound plays when unmuted', muteResult.beforeMute === 1);
  check('M mutes sound effects, not just music', muteResult.afterMute === 1);

  // --- Weapon pickups switch activeWeapon -------------------------------
  await page.evaluate(() => { activatePowerUp('M'); });
  check('M pickup grants MACHINE_GUN', (await page.evaluate(() => activeWeapon)) === 'MACHINE_GUN');
  await page.evaluate(() => { activatePowerUp('S'); });
  check('S pickup grants SPREAD_SHOT', (await page.evaluate(() => activeWeapon)) === 'SPREAD_SHOT');
  await page.evaluate(() => { activatePowerUp('P'); });
  check('P pickup grants LASER_BEAM', (await page.evaluate(() => activeWeapon)) === 'LASER_BEAM');

  const spreadShot = await page.evaluate(() => {
    activeWeapon = 'SPREAD_SHOT';
    lasers.length = 0;
    laserCooldownRemaining = 0;
    fireLaser();
    return lasers.map((l) => ({ vx: Math.round(l.vx), vy: Math.round(l.vy) }));
  });
  check('Spread Shot fires exactly 3 lasers', spreadShot.length === 3);
  check('Spread Shot lasers have distinct vertical velocities (a real fan)', new Set(spreadShot.map((l) => l.vy)).size === 3);

  // --- Boss 3 stays flipped to face the player ---------------------------
  const bossFlips = await page.evaluate(() => [BOSS_CONFIGS[1].flip, BOSS_CONFIGS[2].flip, BOSS_CONFIGS[3].flip]);
  check('Boss 1 is not flipped', bossFlips[0] === false);
  check('Boss 2 is not flipped', bossFlips[1] === false);
  check('Boss 3 is flipped (faces left, toward the player)', bossFlips[2] === true);

  // --- No asteroids anywhere in global scope ------------------------------
  const hasAsteroids = await page.evaluate(() => typeof asteroids !== 'undefined' || typeof Asteroid !== 'undefined');
  check('No asteroid entities exist (starship-only combat)', hasAsteroids === false);

  // --- Life cap: high enough that a boss kill can still grant a life -----
  const lifeCapResult = await page.evaluate(() => {
    startGame();
    score = 999;
    checkLifeAward();
    const livesBeforeBossKill = player.lives;
    score += 500; // BOSS_DEFEAT_SCORE
    checkLifeAward();
    return { max: MAX_PLAYER_LIVES, livesBeforeBossKill, livesAfterBossKill: player.lives };
  });
  check('MAX_PLAYER_LIVES is generously high (>= 20)', lifeCapResult.max >= 20);
  check(
    'A Boss 1-sized kill bonus can still grant a life pre-cap',
    lifeCapResult.livesAfterBossKill > lifeCapResult.livesBeforeBossKill,
  );
  const lifeCapHolds = await page.evaluate(() => {
    score = 1000000;
    checkLifeAward();
    return player.lives;
  });
  check('Life cap still holds at an extreme score', lifeCapHolds === (await page.evaluate(() => MAX_PLAYER_LIVES)));

  // --- Game over: qualifying score auto-saves to the leaderboard ---------
  const gameOverResult = await page.evaluate(() => {
    localStorage.removeItem(HIGH_SCORE_STORAGE_KEY);
    startGame();
    score = 321;
    player.lives = 1;
    handlePlayerHit();
    return { state: gameState, board: JSON.parse(localStorage.getItem(HIGH_SCORE_STORAGE_KEY) || '[]') };
  });
  check('Fatal hit with no lives left enters GAME_OVER', gameOverResult.state === 'GAME_OVER');
  check(
    'Qualifying score auto-saves to the leaderboard with the current name',
    gameOverResult.board.some((e) => e.name === 'QaBot' && e.score === 321),
  );

  check('No unexpected console/page errors', unexpectedErrors.length === 0);

  const hasFailures = failures.length > 0 || unexpectedErrors.length > 0;
  if (hasFailures) {
    // Captured for the "Upload failure screenshot" CI step - whatever's on
    // screen at the point of failure is the best clue for debugging it.
    await page.screenshot({ path: `${__dirname}/failure.png` }).catch(() => {});
  }

  await browser.close();

  if (hasFailures) {
    console.error('SMOKE TEST FAILED\n');
    for (const f of failures) console.error(`  ✗ ${f}`);
    for (const e of unexpectedErrors) console.error(`  ✗ unexpected error: ${e}`);
    process.exit(1);
  }

  console.log('Smoke test passed - all checks green.');
})().catch((err) => {
  console.error('SMOKE TEST CRASHED:', err);
  process.exit(1);
});
