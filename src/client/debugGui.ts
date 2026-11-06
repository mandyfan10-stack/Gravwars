import GUI from 'lil-gui';
import { DEFAULT_MOVEMENT, HU, MovementConfig } from '../shared/constants';
import type { Mover } from '../shared/movement';

export interface DebugToggles {
  bloom: boolean;
  sensitivity: number;
  fov: number;
  /** Nearest texture filtering (crisp texels). */
  pixel: boolean;
}

/** Live tuning of movement in Source units (u/s), like cvars. */
export function createDebugGui(cfg: MovementConfig, mover: Mover, toggles: DebugToggles, onChange: () => void) {
  const gui = new GUI({ title: 'Настройки (G)' });
  const hu = {
    sv_gravity: cfg.gravity / HU,
    sv_maxspeed: cfg.maxSpeed / HU,
    sv_accelerate: cfg.accelerate,
    sv_airaccelerate: cfg.airAccelerate,
    air_speed_cap: cfg.airSpeedCap / HU,
    sv_friction: cfg.friction,
    sv_stopspeed: cfg.stopSpeed / HU,
    jump_speed: cfg.jumpSpeed / HU,
    sv_stepsize: cfg.stepHeight / HU,
    autobhop: cfg.autoBhop,
  };
  const apply = () => {
    cfg.gravity = hu.sv_gravity * HU;
    cfg.maxSpeed = hu.sv_maxspeed * HU;
    cfg.accelerate = hu.sv_accelerate;
    cfg.airAccelerate = hu.sv_airaccelerate;
    cfg.airSpeedCap = hu.air_speed_cap * HU;
    cfg.friction = hu.sv_friction;
    cfg.stopSpeed = hu.sv_stopspeed * HU;
    cfg.jumpSpeed = hu.jump_speed * HU;
    cfg.stepHeight = hu.sv_stepsize * HU;
    cfg.autoBhop = hu.autobhop;
    mover.applyConfig();
  };
  const mv = gui.addFolder('Движение (Source units)');
  mv.add(hu, 'sv_gravity', 100, 2000, 10).onChange(apply);
  mv.add(hu, 'sv_maxspeed', 100, 600, 5).onChange(apply);
  mv.add(hu, 'sv_accelerate', 1, 20, 0.5).onChange(apply);
  mv.add(hu, 'sv_airaccelerate', 1, 150, 1).onChange(apply);
  mv.add(hu, 'air_speed_cap', 10, 100, 1).onChange(apply);
  mv.add(hu, 'sv_friction', 0, 10, 0.1).onChange(apply);
  mv.add(hu, 'sv_stopspeed', 0, 200, 5).onChange(apply);
  mv.add(hu, 'jump_speed', 100, 600, 1).onChange(apply);
  mv.add(hu, 'sv_stepsize', 0, 40, 1).onChange(apply);
  mv.add(hu, 'autobhop').onChange(apply);
  mv.add({ reset: () => {
    Object.assign(cfg, DEFAULT_MOVEMENT);
    hu.sv_gravity = cfg.gravity / HU; hu.sv_maxspeed = cfg.maxSpeed / HU; hu.sv_accelerate = cfg.accelerate;
    hu.sv_airaccelerate = cfg.airAccelerate; hu.air_speed_cap = cfg.airSpeedCap / HU; hu.sv_friction = cfg.friction;
    hu.sv_stopspeed = cfg.stopSpeed / HU; hu.jump_speed = cfg.jumpSpeed / HU; hu.sv_stepsize = cfg.stepHeight / HU;
    hu.autobhop = cfg.autoBhop;
    mv.controllers.forEach((c) => c.updateDisplay());
    mover.applyConfig();
  } }, 'reset').name('Сбросить к Source');
  const view = gui.addFolder('Графика');
  view.add(toggles, 'bloom').name('Свечение (bloom)').onChange(onChange);
  view.add(toggles, 'fov', 60, 120, 1).name('FOV').onChange(onChange);
  view.add(toggles, 'sensitivity', 0.0005, 0.006, 0.0001).name('Чувствительность').onChange(onChange);
  gui.hide();
  return gui;
}