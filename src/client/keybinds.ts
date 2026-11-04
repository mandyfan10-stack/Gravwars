import { Vector3 } from 'three';
import { PLAYER_HEIGHT, WORLD } from '../shared/constants';
import { upOf } from '../shared/math';
import type { PlayerSim } from '../shared/sim';
import { TEAMS } from '../shared/teams';
import type { BuildController } from './buildController';
import type { createDebugGui, DebugToggles } from './debugGui';
import type { Hud } from './hud';
import type { Input } from './input';
import type { LocalPlayer } from './localPlayer';
import type { PlayerCombat } from './playerCombat';

export interface KeyContext {
  input: Input;
  sim: PlayerSim;
  local: LocalPlayer;
  build: BuildController;
  player: PlayerCombat;
  hud: Hud;
  toggles: DebugToggles;
  applyToggles: () => void;
  gui: ReturnType<typeof createDebugGui>;
}

/** Edge-triggered keyboard shortcuts (weapons, build mode, debug). Call once per frame. */
export function createKeyHandler(ctx: KeyContext): () => void {
  const { input, sim, local, build, player, hud, toggles, gui } = ctx;
  let guiVisible = false;

  return () => {
    if (!input.locked) return;
    const shift = input.down('ShiftLeft') || input.down('ShiftRight');
    TEAMS.forEach((t, i) => {
      if (shift && input.take(`Digit${i + 1}`)) sim.setGravity(new Vector3(...t.down));
    });
    if (input.take('KeyB')) build.active = !build.active;
    if (input.take('Digit1')) { build.active = false; player.pendingSelect = 'rifle'; }
    if (input.take('Digit2')) { build.active = false; player.pendingSelect = 'grenade'; }
    if (input.take('Digit3')) build.select('wall');
    if (input.take('Digit4')) build.select('floor');
    if (input.take('Digit5')) build.select('ramp');
    if (!build.active && input.take('KeyQ')) player.toggleWeapon();
    if (input.take('KeyR')) { if (build.active) build.rotate(); else player.pendingReload = true; }
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
      if (guiVisible) {
        gui.show();
        document.exitPointerLock();
      } else gui.hide();
    }
    local.drainEvents();
  };
}
