import { Vector3 } from 'three';
import { PLAYER_HEIGHT, WORLD } from '../shared/constants';
import type { Economy } from '../shared/economy';
import type { WeaponId } from '../shared/weapons';
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
import type { Pockets } from './pockets';

export interface KeyContext {
  input: Input;
  sim: PlayerSim;
  local: LocalPlayer;
  build: BlockController;
  player: PlayerCombat;
  ui: MatchUi;
  eco: Economy;
  pockets: Pockets;
  /** Is the player standing at their shop? */
  nearShop: () => boolean;
  hud: Hud;
  toggles: DebugToggles;
  applyToggles: () => void;
  gui: ReturnType<typeof createDebugGui>;
}

/** Edge-triggered keyboard shortcuts (weapons, blocks, shop, debug). Call once per frame. */
export function createKeyHandler(ctx: KeyContext): () => void {
  const { input, sim, local, build, player, ui, hud, toggles, gui, eco, pockets } = ctx;
  /** Hold one thing at a time: a weapon, the build tool or the rod. */
  const hold = (what: WeaponId | 'build' | 'rod') => {
    if (what === 'build' && !eco.has('builder')) return;
    if (what === 'rod' && !eco.has('rod')) return;
    if (what !== 'build' && what !== 'rod' && !player.weapons.owned[what]) return;
    build.active = what === 'build';
    pockets.setRod(what === 'rod');
    if (what !== 'build' && what !== 'rod') player.pendingSelect = what;
  };
  const slots: (WeaponId | 'build' | 'rod')[] = ['fists', 'pistol', 'rifle', 'grenade', 'build', 'rod'];
  let guiVisible = false;

  return () => {
    if (!input.locked) return;
    const shift = input.down('ShiftLeft') || input.down('ShiftRight');
    TEAMS.forEach((t, i) => {
      if (shift && input.take(`Digit${i + 1}`)) sim.setGravity(new Vector3(...t.down));
    });
    // E: shop when standing at it, otherwise pick up the item in reach (holding E at an enemy crystal: per frame)
    if (input.take('KeyE')) {
      if (ui.shopOpen || ctx.nearShop()) ui.toggleShop();
      else pockets.interact();
    }
    if (ui.shopOpen) {
      for (let i = 1; i <= 9; i++) if (input.take(`Digit${i}`)) ui.choose(i);
      if (input.take('KeyQ') || input.take('Tab')) ui.switchTab();
    } else {
      slots.forEach((w, i) => { if (input.take(`Digit${i + 1}`)) hold(w); });
      if (input.take('KeyQ')) {
        if (build.active) build.cycleMaterial(1);
        else { hold('fists'); player.toggleWeapon(); }
      }
    }
    if (input.take('KeyB')) hold(build.active ? player.weapons.current : 'build');
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
