import { PerspectiveCamera, Vector3 } from 'three';
import { PLAYER_HEIGHT } from '../shared/constants';
import { HOTBAR_SIZE } from '../shared/inventory';
import type { PlayerSim } from '../shared/sim';
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

  let tCount = 0;
  return () => {
    if (!input.locked) return;
    const shift = input.down('ShiftLeft') || input.down('ShiftRight');
    // debug: Shift+1–6 = the gravity of that cube face (Shift is also the sprint, so only while standing still)
    if (shift && local.input.forward === 0 && local.input.right === 0) {
      sim.map.faces.forEach((f, i) => { if (input.take(`Digit${i + 1}`)) sim.setGravity(new Vector3(...f.up).negate()); });
    }
    // E: shop when standing at it, otherwise pick up the item in reach (holding E at an enemy crystal: per frame)
    if (input.take('KeyE')) {
      if (ui.shopOpen || ctx.nearShop()) ui.toggleShop();
      else pockets.interact();
    }
    if (ui.shopOpen) {
      if (input.take('KeyQ') || input.take('Tab')) ui.switchTab();
    } else {
      for (let i = 1; i <= HOTBAR_SIZE; i++) if (input.take(`Digit${i}`)) hands.select(i - 1);
      // B: toggle building mode directly
      if (input.take('KeyB')) hands.toggleBuild();
      // Q: next hotbar slot; in build mode Q is held for the radial menu (a tap still switches the slot)
      if (input.take('KeyQ') && !build.active) hands.cycle(1);
      if (build.tapped) { build.tapped = false; hands.cycle(1); }
      if (input.take('KeyG')) hands.throwHeld(ctx.camera);
    }
    if (input.take('KeyF')) hands.equipApple();
    if (input.take('KeyZ') && build.active) build.cycleMaterial(-1);
    if (input.take('KeyR')) player.pendingReload = true;
    if (input.take('KeyV')) player.kick();
    // eliminated players stay out: K is a debug respawn for the living only
    if (input.take('KeyK') && player.me.alive) sim.respawn('manual');
    if (input.take('KeyN')) {
      sim.state.noclip = !sim.state.noclip;
      hud.toast(sim.state.noclip ? 'Noclip: вкл' : 'Noclip: выкл', '#8af5ff', 1);
    }
    if (input.take('KeyT')) {
      // debug: onto the square of a neutral face (the next one each press)
      const faces = sim.map.faces.filter((f) => !f.team);
      const f = faces[(tCount++) % Math.max(1, faces.length)] ?? sim.map.faces[0];
      const up = new Vector3(...f.up);
      sim.setGravity(up.clone().negate());
      sim.state.pos.set(...f.origin).addScaledVector(up, PLAYER_HEIGHT / 2 + 0.5);
      sim.state.vel.set(0, 0, 0);
      sim.mover.place(sim.state);
      local.snap();
    }
    local.drainEvents();
  };
}
