import { Vector3 } from 'three';
import { PLAYER_HEIGHT, WORLD } from '../shared/constants';
import { SHOP } from '../shared/match';
import { upOf } from '../shared/math';
import type { PlayerSim } from '../shared/sim';
import { TEAMS } from '../shared/teams';
import type { BlockController } from './blockController';
import type { createDebugGui, DebugToggles } from './debugGui';
import type { Hud } from './hud';
import type { Input } from './input';
import type { LocalPlayer } from './localPlayer';
import type { MatchUi } from './matchUi';
import type { PlayerCombat } from './playerCombat';

export interface KeyContext {
  input: Input;
  sim: PlayerSim;
  local: LocalPlayer;
  build: BlockController;
  player: PlayerCombat;
  ui: MatchUi;
  /** Is the player standing at their shop? */
  nearShop: () => boolean;
  hud: Hud;
  toggles: DebugToggles;
  applyToggles: () => void;
  gui: ReturnType<typeof createDebugGui>;
}

/** Edge-triggered keyboard shortcuts (weapons, blocks, shop, debug). Call once per frame. */
export function createKeyHandler(ctx: KeyContext): () => void {
  const { input, sim, local, build, player, ui, hud, toggles, gui } = ctx;
  let guiVisible = false;

  return () => {
    if (!input.locked) return;
    const shift = input.down('ShiftLeft') || input.down('ShiftRight');
    TEAMS.forEach((t, i) => {
      if (shift && input.take(`Digit${i + 1}`)) sim.setGravity(new Vector3(...t.down));
    });
    // E: shop when standing at it (holding E at an enemy crystal is handled every frame by the caller)
    if (input.take('KeyE') && (ui.shopOpen || ctx.nearShop())) ui.toggleShop();
    if (ui.shopOpen) {
      SHOP.forEach((_, i) => { if (input.take(`Digit${i + 1}`)) ui.buy(i); });
    } else {
      if (input.take('Digit1')) { build.active = false; player.pendingSelect = 'rifle'; }
      if (input.take('Digit2')) { build.active = false; player.pendingSelect = 'grenade'; }
      if (input.take('Digit3')) build.active = true;
    }
    if (input.take('KeyB')) build.active = !build.active;
    if (input.take('KeyQ')) { if (build.active) build.cycleMaterial(1); else player.toggleWeapon(); }
    if (input.take('KeyZ') && build.active) build.cycleMaterial(-1);
    if (input.take('KeyR')) player.pendingReload = true;
    if (input.take('KeyK')) sim.respawn('manual');
    if (input.take('KeyN')) {
      sim.state.noclip = !sim.state.noclip;
      hud.toast(sim.state.noclip ? 'Noclip: вкл' : 'Noclip: выкл', '#8af5ff', 1);
    }
    if (input.take('KeyT')) {
      const up = upOf(sim.state.frame);
      sim.state.pos.copy(up).multiplyScalar(WORLD.coreHalf + PLAYER_HEIGHT / 2 + 0.1);
      sim.state.vel.set(0, 0, 0);
      sim.mover.place(sim.state);
      local.snap();
    }
    if (input.take('KeyP')) {
      toggles.portals = !toggles.portals;
      ctx.applyToggles();
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
    }
    if (input.take('KeyG')) {
      guiVisible = !guiVisible;
      document.body.classList.toggle('debug', guiVisible);
      if (guiVisible) {
        gui.show();
        document.exitPointerLock();
      } else gui.hide();
    }
    local.drainEvents();
  };
}
