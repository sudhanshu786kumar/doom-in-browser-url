'use strict';

// Core grid and game constants
var GRID_WIDTH = 40;
var GRID_HEIGHT = 4;
var BRAILLE_SPACE = '\u2800';

// Entity markers (for internal logic; draw treats any truthy value as a dot)
var HERO_CELL = 1;
var ENEMY_CELL = 2;
var PROJECTILE_CELL = 3;
var EFFECT_CELL = 4;
// Add walls and item markers
var WALL_CELL = 5;
var ITEM_MEDKIT_CELL = 6;
var ITEM_ARMOR_CELL = 7;
var ITEM_SHELLS_CELL = 8;
var EXIT_CELL = 9;
var KEY_CELL = 10;

// Directions
var UP = {x: 0, y: -1};
var DOWN = {x: 0, y: 1};
var LEFT = {x: -1, y: 0};
var RIGHT = {x: 1, y: 0};

// Game state
var grid;
var hero;
var enemies;
var projectiles;
var effects;
var currentDirection;
var moveQueue;
var hasMoved;
var gamePaused = false;
var urlRevealed = false;
var whitespaceReplacementChar;
var kills;
var renderMode = 'topdown';
var levelIndex;
var walls; // boolean array GRID_WIDTH * GRID_HEIGHT
var items; // array of {x,y,type}
var hasKey;
var ammoBullets;
var ammoShells;

// Timers / cooldowns
var attackQueued = false;
var abilityQQueued = false;

// Utilities
var $ = document.querySelector.bind(document);

// Define simple levels (4 rows of width 40)
var LEVELS = [
  [
    '........................................',
    '...WWWWWWWW....S.....E....WWWWWWWWW....',
    '...W.....W...........W..........W..XK..',
    '...W.H...W....M..A....W....E.....W.....'
  ],
  [
    '....WWWWWWWWWW.........................',
    '....W.....E....WWWWWWW....S.........KX.',
    '....W.M.......W.....W........A.........',
    'H...W.......E.W.....W..................'
  ]
];

function main() {
  detectBrowserUrlWhitespaceEscaping();
  cleanUrl();
  setupEventHandlers();
  drawMaxScore();
  initUrlRevealed();
  startGame();

  var lastFrameTime = Date.now();
  window.requestAnimationFrame(function frameHandler() {
    var now = Date.now();
    if (!gamePaused && now - lastFrameTime >= tickTime()) {
      updateWorld();
      drawWorld();
      lastFrameTime = now;
    }
    window.requestAnimationFrame(frameHandler);
  });
}

function detectBrowserUrlWhitespaceEscaping() {
  history.replaceState(null, null, '#' + BRAILLE_SPACE + BRAILLE_SPACE);
  if (location.hash.indexOf(BRAILLE_SPACE) == -1) {
    console.warn('Browser is escaping whitespace characters on URL');
    var replacementData = pickWhitespaceReplacementChar();
    whitespaceReplacementChar = replacementData[0];
    var note = document.querySelector('#url-escaping-note');
    var rep = document.querySelector('#replacement-char-description');
    if (note) note.classList.remove('invisible');
    if (rep) rep.textContent = replacementData[1];
    setUrlRevealed(true);
  }
}

function cleanUrl() {
  history.replaceState(null, null, location.pathname.replace(/\b\/$/, ''));
}

function initUrlRevealed() {
  setUrlRevealed(Boolean(localStorage.urlRevealed));
}

function setUrlRevealed(value) {
  urlRevealed = value;
  var urlEl = document.querySelector('#url');
  if (urlEl) {
    // keep a mirror of the URL in-page; visibility managed by presence
  }
  if (urlRevealed) {
    localStorage.urlRevealed = 'y';
  } else {
    delete localStorage.urlRevealed;
  }
}

function setupEventHandlers() {
  var directionsByKey = {
    37: LEFT, 38: UP, 39: RIGHT, 40: DOWN,
    87: UP, 65: LEFT, 83: DOWN, 68: RIGHT,
    75: UP, 72: LEFT, 74: DOWN, 76: RIGHT
  };

  document.onkeydown = function (event) {
    var key = event.keyCode;
    if (key in directionsByKey) {
      changeDirection(directionsByKey[key]);
    }
    if (key === 32) { attackQueued = true; hasMoved = true; }
    if (key === 81) { abilityQQueued = true; hasMoved = true; }
    if (key === 49) hero.weapon = 'pistol';
    if (key === 50 && ammoShells > 0) hero.weapon = 'shotgun';
    // R: toggle renderer
    if (key === 82) { renderMode = renderMode === 'topdown' ? 'raycast' : 'topdown'; hasMoved = true; }
  };

  var upBtn = document.querySelector('#up'); if (upBtn) upBtn.ontouchstart = function () { changeDirection(UP) };
  var downBtn = document.querySelector('#down'); if (downBtn) downBtn.ontouchstart = function () { changeDirection(DOWN) };
  var leftBtn = document.querySelector('#left'); if (leftBtn) leftBtn.ontouchstart = function () { changeDirection(LEFT) };
  var rightBtn = document.querySelector('#right'); if (rightBtn) rightBtn.ontouchstart = function () { changeDirection(RIGHT) };

  window.onblur = function pauseGame() {
    gamePaused = true;
    window.history.replaceState(null, null, location.hash + '[paused]');
  };
  window.onfocus = function unpauseGame() { gamePaused = false; drawWorld(); };

  var reveal = document.querySelector('#reveal-url');
  if (reveal) {
    reveal.onclick = function (e) { e.preventDefault(); setUrlRevealed(!urlRevealed); };
  }

  var expandables = document.querySelectorAll('.expandable');
  if (expandables && expandables.length) {
    expandables.forEach(function (expandable) {
      var expand = expandable.querySelector('.expand-btn');
      var collapse = expandable.querySelector('.collapse-btn');
      var content = expandable.querySelector('.expandable-content');
      expand.onclick = collapse.onclick = function () {
        expand.classList.remove('hidden');
        content.classList.remove('hidden');
        expandable.classList.toggle('expanded');
      };
      expandable.ontransitionend = function () {
        var expanded = expandable.classList.contains('expanded');
        expand.classList.toggle('hidden', expanded);
        content.classList.toggle('hidden', !expanded);
      };
    });
  }
}

function startGame() {
  grid = new Array(GRID_WIDTH * GRID_HEIGHT);
  clearGrid();
  levelIndex = 0;
  kills = 0;
  loadLevel(levelIndex);
  currentDirection = RIGHT;
  moveQueue = [];
  hasMoved = false;
}

function loadLevel(idx) {
  clearGrid();
  enemies = [];
  projectiles = [];
  effects = [];
  items = [];
  walls = new Array(GRID_WIDTH * GRID_HEIGHT);
  hasKey = false;
  ammoBullets = 60;
  ammoShells = 8;
  var rows = LEVELS[idx % LEVELS.length];
  for (var y = 0; y < GRID_HEIGHT; y++) {
    var row = rows[y];
    for (var x = 0; x < GRID_WIDTH; x++) {
      var ch = row[x] || '.';
      var i = x + y * GRID_WIDTH;
      walls[i] = false;
      if (ch === 'W') {
        walls[i] = true;
      } else if (ch === 'H') {
        hero = { x: x, y: y, hp: 12, maxHp: 12, armor: 0, dir: RIGHT, attackCooldown: 0, abilityQCooldown: 0, weapon: 'pistol' };
      } else if (ch === 'E') {
        var type = Math.random() < 0.5 ? 'zombie' : 'imp';
        enemies.push({ x: x, y: y, hp: 3, attackCooldown: 0, type: type });
      } else if (ch === 'M') {
        items.push({ x: x, y: y, type: 'medkit' });
      } else if (ch === 'A') {
        items.push({ x: x, y: y, type: 'armor' });
      } else if (ch === 'S') {
        items.push({ x: x, y: y, type: 'shells' });
      } else if (ch === 'K') {
        items.push({ x: x, y: y, type: 'key' });
      } else if (ch === 'X') {
        items.push({ x: x, y: y, type: 'exit' });
      }
    }
  }
}

function isWall(x, y) {
  if (x < 0 || x >= GRID_WIDTH || y < 0 || y >= GRID_HEIGHT) return true;
  return !!walls[x + y * GRID_WIDTH];
}

function hasLineOfSightRow(y, x1, x2) {
  var a = Math.min(x1, x2), b = Math.max(x1, x2);
  for (var x = a + 1; x < b; x++) {
    if (isWall(x, y)) return false;
  }
  return true;
}

function changeDirection(newDir) {
  var lastDir = moveQueue[0] || currentDirection;
  var opposite = newDir.x + lastDir.x === 0 && newDir.y + lastDir.y === 0;
  if (!opposite) {
    moveQueue.unshift(newDir);
  }
  hasMoved = true;
}

function updateWorld() {
  // Apply input
  if (moveQueue.length) currentDirection = moveQueue.pop();

  // Move hero (blocked by walls)
  var newX = hero.x + currentDirection.x;
  var newY = hero.y + currentDirection.y;
  if (newX < 0) newX = 0; if (newX >= GRID_WIDTH) newX = GRID_WIDTH - 1;
  if (newY < 0) newY = 0; if (newY >= GRID_HEIGHT) newY = GRID_HEIGHT - 1;
  if (!isWall(newX, newY)) {
    hero.x = newX; hero.y = newY; hero.dir = currentDirection;
  }

  // Pick up items
  for (var it = items.length - 1; it >= 0; it--) {
    var item = items[it];
    if (item.x === hero.x && item.y === hero.y) {
      if (item.type === 'medkit') { hero.hp = Math.min(hero.maxHp, hero.hp + 10); }
      else if (item.type === 'armor') { hero.armor = Math.min(50, hero.armor + 25); }
      else if (item.type === 'shells') { ammoShells += 4; }
      else if (item.type === 'key') { hasKey = true; }
      else if (item.type === 'exit') { if (hasKey) { levelIndex++; loadLevel(levelIndex); } }
      items.splice(it, 1);
    }
  }

  // Handle attack input
  if (attackQueued && hero.attackCooldown <= 0) {
    if (hero.weapon === 'pistol') {
      // Pistol: low damage, bullets (we keep bullets implicit for simplicity)
      spawnProjectile(hero.x + hero.dir.x, hero.y + hero.dir.y, hero.dir.x, hero.dir.y, 10, 2, 'hero');
      hero.attackCooldown = 5;
    } else if (hero.weapon === 'shotgun' && ammoShells > 0) {
      // Shotgun: 3-pellet spread horizontally/vertically depending on dir
      ammoShells -= 1;
      var dir = hero.dir;
      var pellets = [ {dx: dir.x, dy: dir.y}, {dx: dir.x, dy: dir.y}, {dx: dir.x, dy: dir.y} ];
      for (var s = 0; s < pellets.length; s++) {
        spawnProjectile(hero.x + dir.x, hero.y + dir.y, dir.x, dir.y, 8, 3, 'hero');
      }
      hero.attackCooldown = 10;
    }
  }
  attackQueued = false;

  // Ability Q: AOE around hero (small damage)
  if (abilityQQueued && hero.abilityQCooldown <= 0) {
    abilityQQueued = false;
    hero.abilityQCooldown = 24; // ticks
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        var ax = hero.x + dx;
        var ay = hero.y + dy;
        if (ax < 0 || ay < 0 || ax >= GRID_WIDTH || ay >= GRID_HEIGHT) continue;
        addEffect(ax, ay, 2);
        // Damage enemies in area
        for (var i = 0; i < enemies.length; i++) {
          if (enemies[i].x === ax && enemies[i].y === ay) {
            enemies[i].hp -= 2;
          }
        }
      }
    }
  } else {
    abilityQQueued = false;
  }

  // Enemy spawn pacing (keep existing dynamic spawner)
  maybeSpawnEnemy();

  // Update enemies (block by walls, simple types)
  for (var e = enemies.length - 1; e >= 0; e--) {
    var enemy = enemies[e];
    // Move one step toward hero if not blocked
    var stepX = enemy.x + (enemy.x > hero.x ? -1 : (enemy.x < hero.x ? 1 : 0));
    var stepY = enemy.y + (enemy.y > hero.y ? -1 : (enemy.y < hero.y ? 1 : 0));
    if (!isWall(stepX, enemy.y)) enemy.x = stepX;
    if (!isWall(enemy.x, stepY)) enemy.y = stepY;

    var dist = Math.abs(enemy.x - hero.x) + Math.abs(enemy.y - hero.y);

    // Behavior
    if (enemy.type === 'zombie') {
      // Hitscan if same row and clear LOS
      if (enemy.attackCooldown <= 0 && enemy.y === hero.y && hasLineOfSightRow(enemy.y, enemy.x, hero.x)) {
        var dmg = 1;
        if (hero.armor > 0) { hero.armor = Math.max(0, hero.armor - 1); } else { hero.hp -= dmg; }
        enemy.attackCooldown = 14;
        addEffect(hero.x, hero.y, 1);
      }
    } else {
      // Imp: fire projectile if same row and LOS
      if (enemy.attackCooldown <= 0 && enemy.y === hero.y && hasLineOfSightRow(enemy.y, enemy.x, hero.x)) {
        var dx = hero.x > enemy.x ? 1 : -1;
        spawnProjectile(enemy.x + dx, enemy.y, dx, 0, 12, 2, 'imp');
        enemy.attackCooldown = 18;
      }
    }

    // Melee if adjacent
    if (dist <= 1 && enemy.attackCooldown <= 0) {
      var mdmg = 1;
      if (hero.armor > 0) { hero.armor = Math.max(0, hero.armor - 1); } else { hero.hp -= mdmg; }
      enemy.attackCooldown = 12;
      addEffect(hero.x, hero.y, 1);
      if (hero.hp <= 0) { endGame(); startGame(); return; }
    } else {
      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - 1);
    }
  }

  // Update projectiles, block by walls
  for (var p = projectiles.length - 1; p >= 0; p--) {
    var proj = projectiles[p];
    proj.x += proj.dx; proj.y += proj.dy; proj.life--;
    if (proj.x < 0 || proj.x >= GRID_WIDTH || proj.y < 0 || proj.y >= GRID_HEIGHT || proj.life <= 0 || isWall(proj.x, proj.y)) {
      projectiles.splice(p, 1);
      continue;
    }
    addEffect(proj.x, proj.y, 1);
    // Hit enemies
    for (var j = enemies.length - 1; j >= 0; j--) {
      var en = enemies[j];
      if (en.x === proj.x && en.y === proj.y) {
        en.hp -= proj.damage;
        projectiles.splice(p, 1);
        break;
      }
    }
  }

  // Remove dead enemies and count kills
  for (var k = enemies.length - 1; k >= 0; k--) {
    if (enemies[k].hp <= 0) { kills++; enemies.splice(k, 1); }
  }

  // Tick cooldowns
  if (hero.attackCooldown > 0) hero.attackCooldown--;
  if (hero.abilityQCooldown > 0) hero.abilityQCooldown--;

  // Effects decay
  for (var ef = effects.length - 1; ef >= 0; ef--) {
    effects[ef].ttl--;
    if (effects[ef].ttl <= 0) effects.splice(ef, 1);
  }
}

function drawWorld() {
  clearGrid();
  // Draw walls
  for (var y = 0; y < GRID_HEIGHT; y++) {
    for (var x = 0; x < GRID_WIDTH; x++) {
      if (isWall(x, y)) setCellAt(x, y, WALL_CELL);
    }
  }
  // Place items
  for (var ii = 0; ii < items.length; ii++) {
    var it = items[ii];
    var t = it.type;
    var marker = t === 'medkit' ? ITEM_MEDKIT_CELL : t === 'armor' ? ITEM_ARMOR_CELL : t === 'shells' ? ITEM_SHELLS_CELL : t === 'key' ? KEY_CELL : EXIT_CELL;
    setCellAt(it.x, it.y, marker);
  }
  // Place entities
  setCellAt(hero.x, hero.y, HERO_CELL);
  for (var i = 0; i < enemies.length; i++) setCellAt(enemies[i].x, enemies[i].y, ENEMY_CELL);
  for (var j = 0; j < projectiles.length; j++) setCellAt(projectiles[j].x, projectiles[j].y, PROJECTILE_CELL);
  for (var e = 0; e < effects.length; e++) setCellAt(effects[e].x, effects[e].y, EFFECT_CELL);

  var status = '[hp:' + hero.hp + '/' + hero.maxHp + ']' +
               '[ar:' + hero.armor + ']' +
               '[wp:' + hero.weapon + ']' +
               '[sh:' + ammoShells + ']' +
               '[ky:' + (hasKey ? 1 : 0) + ']' +
               '[lvl:' + levelIndex + ']' +
               '[kills:' + kills + ']';
  var gridStr = renderMode === 'raycast' ? raycastString() : gridString();
  var hash = '#|' + gridStr + '|' + status;

  var urlEl = document.querySelector('#url');
  if (urlRevealed && urlEl) {
    urlEl.textContent = location.href.replace(/#.*$/, '') + hash;
  }

  if (whitespaceReplacementChar) {
    hash = hash.replace(/\u2800/g, whitespaceReplacementChar);
  }

  history.replaceState(null, null, hash);

  if (decodeURIComponent(location.hash) !== hash) {
    console.warn('history.replaceState() throttling detected. Using location.hash fallback');
    location.hash = hash;
  }
}

function spawnProjectile(x, y, dx, dy, life, damage, owner) {
  if (x < 0 || x >= GRID_WIDTH || y < 0 || y >= GRID_HEIGHT) return;
  projectiles.push({x: x, y: y, dx: dx, dy: dy, life: life, damage: damage, owner: owner});
}

function addEffect(x, y, ttl) {
  effects.push({x: x, y: y, ttl: ttl});
}

function maybeSpawnEnemy() {
  // Spawn rate increases slightly with kills, capped
  var base = 28; // ticks
  var min = 14;
  var interval = Math.max(min, base - Math.floor(kills / 3));
  if (!maybeSpawnEnemy._ticks) maybeSpawnEnemy._ticks = 0;
  maybeSpawnEnemy._ticks++;
  if (maybeSpawnEnemy._ticks >= interval) {
    maybeSpawnEnemy._ticks = 0;
    var y = Math.floor(Math.random() * GRID_HEIGHT);
    enemies.push({x: GRID_WIDTH - 1, y: y, hp: 2, attackCooldown: 0});
  }
}

function endGame() {
  var maxKills = parseInt(localStorage.maxKills || 0);
  if (kills > 0 && kills > maxKills && hasMoved) {
    localStorage.maxKills = kills;
    localStorage.maxKillsGrid = gridString();
    drawMaxScore();
    showMaxScore();
  }
}

function drawMaxScore() {
  var container = document.querySelector('#max-score-container');
  if (!container) return;
  var maxKills = localStorage.maxKills;
  if (maxKills == null) return;
  var points = maxKills == 1 ? '1 kill' : maxKills + ' kills';
  var maxGrid = localStorage.maxKillsGrid;
  var pointsEl = document.querySelector('#max-score-points');
  var gridEl = document.querySelector('#max-score-grid');
  var shareEl = document.querySelector('#share');
  if (pointsEl) pointsEl.textContent = points;
  if (gridEl) gridEl.textContent = maxGrid;
  container.classList.remove('hidden');
  if (shareEl) {
    shareEl.onclick = function (e) { e.preventDefault(); shareScore(points, maxGrid); };
  }
}

function showShareNote(message) {
  var note = document.querySelector('#share-note');
  if (!note) return;
  note.textContent = message;
  note.classList.remove('invisible');
  setTimeout(function () { note.classList.add('invisible'); }, 1000);
}

function shareScore(scorePoints, grid) {
  var message = '|' + grid + '| Got ' + scorePoints + ' in this URL MOBA game!';
  var linkEl = document.querySelector('link[rel=canonical]');
  var url = linkEl ? linkEl.href : location.href;
  if (navigator.share) {
    navigator.share({text: message, url: url});
  } else {
    navigator.clipboard.writeText(message + '\n' + url)
      .then(function () { showShareNote('copied to clipboard'); })
      .catch(function () { showShareNote('clipboard write failed'); });
  }
}

function showMaxScore() { /* no-op for minimal UI */ }

function pickWhitespaceReplacementChar() {
  // Use a single safe, subtle character to avoid confusing slashes
  return ['░', 'light shade'];
}

main();

// Helpers restored: grid, timing, and raycast renderer
function clearGrid() {
  for (var i = 0; i < grid.length; i++) grid[i] = null;
}

function cellAt(x, y) {
  return grid[(x % GRID_WIDTH) + y * GRID_WIDTH];
}

function setCellAt(x, y, cellType) {
  grid[(x % GRID_WIDTH) + y * GRID_WIDTH] = cellType;
}

function bitAt(x, y) {
  return cellAt(x, y) ? 1 : 0;
}

function gridString() {
  var str = '';
  for (var x = 0; x < GRID_WIDTH; x += 2) {
    var n = 0
      | (bitAt(x, 0) << 0)
      | (bitAt(x, 1) << 1)
      | (bitAt(x, 2) << 2)
      | (bitAt(x + 1, 0) << 3)
      | (bitAt(x + 1, 1) << 4)
      | (bitAt(x + 1, 2) << 5)
      | (bitAt(x, 3) << 6)
      | (bitAt(x + 1, 3) << 7);
    str += String.fromCharCode(0x2800 + n);
  }
  return str;
}

function tickTime() {
  var start = 125;
  var end = 85;
  var factor = Math.min(1, kills / 60);
  return start + factor * (end - start);
}

// Simple raycast based on discrete facing (UP/DOWN/LEFT/RIGHT)
function raycastString() {
  var str = '';
  for (var col = 0; col < GRID_WIDTH; col += 2) {
    var d = distanceToWallAhead(hero.x, hero.y, hero.dir);
    var leftH = heightForDistance(d);
    var rightH = heightForDistance(d + 0.5);
    var n = brailleFromHeights(leftH, rightH);
    str += String.fromCharCode(0x2800 + n);
  }
  return str;
}

function distanceToWallAhead(x, y, dir) {
  var dist = 0;
  if (dir === RIGHT) {
    for (var cx = x + 1; cx < GRID_WIDTH; cx++) { dist++; if (isWall(cx, y)) break; }
  } else if (dir === LEFT) {
    for (var cx2 = x - 1; cx2 >= 0; cx2--) { dist++; if (isWall(cx2, y)) break; }
  } else if (dir === DOWN) {
    for (var cy = y + 1; cy < GRID_HEIGHT; cy++) { dist++; if (isWall(x, cy)) break; }
  } else if (dir === UP) {
    for (var cy2 = y - 1; cy2 >= 0; cy2--) { dist++; if (isWall(x, cy2)) break; }
  }
  return dist || GRID_WIDTH; // if no wall, return large distance
}

function heightForDistance(d) {
  if (d <= 1) return 4;
  if (d <= 2) return 3;
  if (d <= 3) return 2;
  if (d <= 4) return 1;
  return 0;
}

function brailleFromHeights(lh, rh) {
  var n = 0;
  // left column bits: bottom(6), row3(2), row2(1), top(0)
  if (lh >= 1) n |= (1 << 6);
  if (lh >= 2) n |= (1 << 2);
  if (lh >= 3) n |= (1 << 1);
  if (lh >= 4) n |= (1 << 0);
  // right column bits: bottom(7), row3(5), row2(4), top(3)
  if (rh >= 1) n |= (1 << 7);
  if (rh >= 2) n |= (1 << 5);
  if (rh >= 3) n |= (1 << 4);
  if (rh >= 4) n |= (1 << 3);
  return n;
}