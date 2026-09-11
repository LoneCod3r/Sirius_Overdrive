# Sirius Overdrive: Edge of Oblivion

A retro-style arcade space shooter built with vanilla JavaScript and the HTML5 Canvas API — no engine, no build step, no dependencies. Open `index.html` in a browser and play.

## Story

At the far edge of the Sirius system, a tear in space called the Oblivion has been swallowing ships, stations, and starlight itself — and spitting out hostile war-machines in return.

Scout raiders spill through first to probe for weakness, interceptors and destroyers follow to hold the breach open, and titanic command warships anchor its deepest incursions.

Sirius Overdrive is the emergency program that pushed standard fighter engines past every safety limit — your engines — to give a pilot any chance of surviving at the edge of Oblivion. Punch through, hold the line, and drive it back to whatever waits on the other side.

## How to play

| Control | Action |
| --- | --- |
| `W` `A` `S` `D` or Arrow Keys | Move |
| `Space` | Fire weapon |
| `P` | Pause / resume |
| `M` | Mute / unmute music |
| Mouse / touch | Menu navigation, ship selection |

The game is also playable on mobile via on-screen drag and tap controls (landscape orientation only — portrait shows a rotate prompt).

### Power-ups

Destroyed enemies have a chance to drop a weapon capsule. Picking one up swaps your weapon for a limited time before it reverts to the standard laser:

| Capsule | Weapon |
| --- | --- |
| **M** | Machine Gun — rapid fire |
| **S** | Spread Shot — a fan of shots |
| **P** | Plasma Beam |

You don't need to hunt for extra lives — one is granted automatically every 100 points, up to a cap of 5.

## Enemies & bosses

Three regular enemy types spawn in an even mix each level:

- **Scout Raider** — fast, fragile, one hit kills it
- **Interceptor** — nimble, weaves in sine-wave patterns
- **Destroyer** — slow but tanky, wide profile

Every 1000 points, one of three bosses appears (guaranteed at least 10 seconds of normal combat after the previous one falls):

1. **Crimson Warden** — bobs at range (1000 pts)
2. **Void Corsair** — dashes to close the distance (2000 pts)
3. **Omega Reaper** — the Oblivion's final answer (3000 pts) — defeating it seals the breach and wins the game

## Project structure

```
index.html                 Entry point — loads player-ship-assets.js then game.js
game.js                    Entire game: rendering, input, state machine, all screens
player-ship-assets.js      Base64 data URIs for the 3 selectable player ships
style.css                  Canvas layout + mobile rotate-orientation overlay

audio/                     Sound effects (laser, power-up, explosion, UI) + music
spaceships-for-player/     Source art for the 3 selectable player ships
starships/                 Enemy and boss sprites actually used in-game
spaceships/                Legacy/unused enemy & boss sprite set (kept for reference)

Digital_SFX_Set.zip        Source SFX pack the audio/ folder was extracted from
Plan.docx                  Design notes
```

### Why player ship art is embedded as data URIs

`player-ship-assets.js` embeds the 3 player ship sprites as base64 data URIs rather than loading them as plain image files. Loading them from `spaceships-for-player/*.png` over a `file://` URL taints the canvas and silently breaks the `getImageData()`-based background stripping/cropping the game does on each sprite (see `preparePlayerShipSprite()` in `game.js`). Embedding sidesteps that entirely, since a `data:` URI is never treated as cross-origin.

## Technical notes

- **No build step.** Everything runs directly in the browser from static files.
- **Single canvas, single file.** All rendering, physics, collision, and UI happens in `game.js` against one `<canvas>` element — no DOM UI elements beyond the canvas itself and the mobile rotate overlay.
- **Sprite processing at load time.** Ship art is chroma/white-background-stripped and tightly cropped to its visible pixels on load, so hitboxes and exhaust/effect origins line up with the actual art regardless of how much padding the source image file has.
- **Responsive canvas.** The canvas is locked to a 16:9 aspect ratio and letterboxes to fit any window size; a portrait phone gets a "rotate your device" prompt instead of an unplayably thin strip.

## Running locally

Just open `index.html` in a browser. If your browser blocks local sprite loading over `file://`, serve the folder instead:

```bash
npx http-server .
```

Then visit the printed local URL.
