import { Combat, MAX_HP, Target } from '../combat';
import type { Economy } from '../economy';
import { JETPACK, PlayerSim } from '../sim';
import type { TeamId } from '../teams';
import { consumeJetpackFuel, totalFuelAmmo, type WeaponState } from '../weapons';

export interface RemoteClientGearState {
  sim: PlayerSim;
  eco: Economy;
  target: Target;
  weapons: WeaponState;
  team: TeamId;
  dirtySync: boolean;
  pendingNotice?: { text: string; color: string };
}

/** Wire armor vest purchase & lethal-save breakage onto a remote client's authoritative target. */
export function wireRemoteClientArmor(rc: Pick<RemoteClientGearState, 'eco' | 'target' | 'dirtySync' | 'pendingNotice'>) {
  rc.target.armor = rc.eco.has('armor');
  rc.eco.onArmorChange = (has) => {
    rc.target.armor = has;
    rc.dirtySync = true;
  };
  rc.target.onArmorBreak = () => {
    rc.eco.breakArmor();
    rc.pendingNotice = { text: 'Бронежилет спас от смерти!', color: '#7cf5ff' };
    rc.dirtySync = true;
  };
}

/** Sync jetpack ownership/fuel flags before stepping a remote client's authoritative `PlayerSim`. */
export function syncRemoteClientJetpack(rc: Pick<RemoteClientGearState, 'sim' | 'eco' | 'weapons'>) {
  rc.sim.hasJetpack = rc.eco.has('jetpack');
  rc.sim.hasJetpackFuel = totalFuelAmmo(rc.weapons) > 0;
}

/** Handle authoritative jetpack fuel consumption and overheat explosion events for a remote client. */
export function applyRemoteClientJetpackEvents(
  rc: Pick<RemoteClientGearState, 'target' | 'weapons' | 'team' | 'dirtySync' | 'pendingNotice'>,
  ev: PlayerSim['events'][number],
  combat: Combat,
): boolean {
  if (ev.type === 'jetpackFuel') {
    consumeJetpackFuel(rc.weapons, 1);
    rc.dirtySync = true;
    return true;
  }
  if (ev.type === 'jetpackExplode') {
    const selfDmg = (rc.target.maxHp ?? MAX_HP) * JETPACK.explodeSelfFrac;
    combat.damage(rc.target, selfDmg, rc.target.id, false, ev.pos, {
      raw: true, noPush: true, cause: 'jetpack', weapon: 'jetpack',
    });
    combat.triggerExplosion(
      ev.pos, rc.target.id, rc.team, JETPACK.explodeRadius, JETPACK.explodeDamageOther,
      12, 60, 0, true, 'jetpack', ev.pos,
    );
    rc.pendingNotice = { text: 'Перегрев ранца! Взрыв!', color: '#ff7050' };
    rc.dirtySync = true;
    return true;
  }
  return false;
}
