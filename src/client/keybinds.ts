import { PerspectiveCamera, Vector3 } from 'three';
import { PLAYER_HEIGHT } from '../shared/constants';
import { HOTBAR_SIZE } from '../shared/inventory';
import type { PlayerSim } from '../shared/sim';
import { TEAMS } from '../shared/teams';
import type { BlockController } from './blockController';
import type { createDebugGui, DebugToggles } from './debugGui';
import type { Hands } from './hands';
import type { Hud } from './hud';
import type { Input } from './input';
import type { LocalPlayer } from './localPlayer';
import type { MatchUi } from './matchUi';
import type { PlayerCombat } from './playerCombat';
import type { Pockets } from './pockets';

export interface KeyContext {
  input: Input;
  sim: PlayerSim;
  local: LocalPlayer;
  build: BlockController;
  player: PlayerCombat;
  ui: MatchUi;
  hands: Hands;
  pockets: Pockets;
  /** Is the player standing at their shop? */
  nearShop: () => boolean;
  camera: PerspectiveCamera;
  hud: Hud;
  toggles: DebugToggles;
  applyToggles: () => void;
  gui: ReturnType<typeof createDebugGui>;
}

/** Edge-triggered keyboard shortcuts (hotbar, items, shop, inventory, debug). Call once per frame. */
export function createKeyHandler(ctx: KeyContext): () => void {
  const { input, sim, local, build, player, ui, hud, toggles, gui, hands, pockets } = ctx;
  let guiVisible = false;
  // debug panel on ` — a plain listener, so that it also closes once the panel has taken the mouse (no pointer lock)
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Backquote') return;
    guiVisible = !guiVisible;
    document.body.classList.toggle('debug', guiVisible);
    if (guiVisible) {
      gui.show();
      document.exitPointerLock();
    } else gui.hide();
  });

  return () => {
    if (!input.locked) return;
    const shift = input.down('ShiftLeft') || input.down('ShiftRight');
    // debug: Shift+1–4 = that team's gravity (Shift is also the sprint, so only while standing still)
    if (shift && local.input.forward === 0 && local.input.right === 0) {
      TEAMS.forEach((t, i) => { if (input.take(`Digit${i + 1}`)) sim.setGravity(new Vector3(...t.down)); });
    }
    // E: shop when standing at it, otherwise pick up the item in reach (holding E at an enemy crystal: per frame)
    if (input.take('KeyE')) {
      if (hands.invOpen) hands.toggleInventory();
      else if (ui.shopOpen || ctx.nearShop()) ui.toggleShop();
      else pockets.interact();
    }
    if (input.take('KeyI') && !ui.shopOpen) hands.toggleInventory();
    if (ui.shopOpen) {
      if (input.take('KeyQ') || input.take('Tab')) ui.switchTab();
    } else if (hands.invOpen) {
      // over a cell: the number puts it into that hotbar slot
      for (let i = 1; i <= HOTBAR_SIZE; i++) if (input.take(`Digit${i}`)) hands.assign(i - 1);
    } else {
      for (let i = 1; i <= HOTBAR_SIZE; i++) if (input.take(`Digit${i}`)) hands.select(i - 1);
      if (input.take('KeyQ')) {
        if (build.active) build.cycleMaterial(1);
        else hands.cycle(1);
      }
      if (input.take('KeyG')) hands.throwHeld(ctx.camera);
    }
    if (input.take('KeyF')) pockets.eat();
    if (input.take('KeyZ') && build.active) build.cycleMaterial(-1);
    if (input.take('KeyR')) player.pendingReload = true;
    // eliminated players stay out: K is a debug respawn for the living only
    if (input.take('KeyK') && player.me.alive) sim.respawn('manual');
    if (input.take('KeyN')) {
      sim.state.noclip = !sim.state.noclip;
      hud.toast(sim.state.noclip ? 'Noclip: вкл' : 'Noclip: выкл', '#8af5ff', 1);
    }
    if (input.take('KeyT')) {
      // debug: onto the central square
      sim.setGravity(new Vector3(0, 0, -1));
      sim.state.pos.set(0, 0, PLAYER_HEIGHT / 2 + 0.3);
      sim.state.vel.set(0, 0, 0);
      sim.mover.place(sim.state);
      local.snap();
    }
    local.drainEvents();
  };
}
