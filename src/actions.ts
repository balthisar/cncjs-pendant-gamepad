#!/usr/bin/env node

// actions
// A module that creates actions based on input from the game controller and
// sends them to a socket server (typically CNCjs) to execute them.
//
// Copyright (c) 2017-2022 various contributors. See LICENSE for copyright
// and MIT license information.

import { Options }                         from './console';
import { GcodeSender }                     from './gcode-sender.js';
import { GcodeGrbl }                       from './gcode-grbl.js';
import { GcodeMarlin }                     from './gcode-marlin.js';
import { Connector }                       from './connector';
import { GamepadController, GamepadState } from './gamepad_controller';

import log from 'npmlog';
import fs from 'fs';
import path from 'path';
import os from 'os';

//------------------------------------------------------------------------------
// Constant and interface definitions.
//------------------------------------------------------------------------------
const LOGPREFIX = 'ACTIONS  '; // keep at 9 digits for consistency

// Analogue sticks range from {-1..1}, and may not always return to exactly
// {0,0} when released, thus positions within this magnitude will be ignored.
const DEADRANGE = 0.10;

// We don't have true continuous motor control, so we will simulate it with
// a timer and sending motion comments at specific intervals. Long intervals
// can be dangerous at high speeds as well as have an unresponsive feel, and
// intervals that are too short might result in unsmooth motion.
const JOG_INTERVAL = 100;                    // ms/interval; there are 60,000 ms/min.
const VXY_LOW = 300 * JOG_INTERVAL / 60000;  // mm/minute in terms of mm/interval, slow velocity.
const VXY_MED = 3000 * JOG_INTERVAL / 60000; // mm/minute in terms of mm/interval, medium velocity.
const CXY_LOW = 0.5;                         // single impulse distance, slow.
const CXY_MED = 1.0;                         // single impluse distance, medium.
const VZ_LOW = 250 * JOG_INTERVAL / 60000;   // mm/minute in terms of mm/interval, z-axis,
const VZ_MED = 500 * JOG_INTERVAL / 60000;   // mm/minute in terms of mm/interval, z-axis,
const CZ_LOW = 0.1;                          // single impulse distance, z-axis.
const CZ_MED = 1.0;                          // single impulse distance, z-axis.

const CREEP_INTERVAL = 250;                  // delay before continuous movement.

//----------------------------------------------------------------------------
// Interface definitions.
//----------------------------------------------------------------------------
// A simple record that indicates the next jogging motion destination.
export class XYZCoords {
  move_x_axis: number = 0.0;
  move_y_axis: number = 0.0;
  move_z_axis: number = 0.0;
};

// An interface for holding actions mappings. Perhaps a bit overly broad.
export interface ActionsMappings {
  [key: string]: any;
}

//------------------------------------------------------------------------------
// Main module - provided access to command line options.
//------------------------------------------------------------------------------
export class Actions {
  connector: Connector;                       // connection to CNCjs
  gamepadController: GamepadController;       // connection to gamepad
  options: Options;                           // program-wide options
  gcodeSender: GcodeSender;                   // abstraction interface
  jogTimer: NodeJS.Timer;                     // jog timer reference

  gamepadState = {} as GamepadState;          // state of current controller
  axisInstructions = new XYZCoords();         // next jog movement instructions
  
  thumbRightActive = false;
  thumbLeftActive = false;

  //----------------------------------------------------------------------------
  // constructor()
  //----------------------------------------------------------------------------
  constructor(connector: Connector, options: Options) {
    this.connector = connector;
    this.gamepadController = connector.gamepadController;
    this.options = options;
    this.gcodeSender = this.newGcodeSender();

    this.gamepadController.on('use', this.onUse.bind(this));
    this.jogTimer = setTimeout( this.jogFunction.bind(this), JOG_INTERVAL );
  }


  //----------------------------------------------------------------------------
  // createGcodeSender()
  // Create an instance of the appropriate Gcode sender.
  //----------------------------------------------------------------------------
  newGcodeSender(): GcodeSender {
    let gcode: typeof GcodeSender;
    switch (this.options.controllerType.toLowerCase()) {
      case 'grbl':
        gcode = GcodeGrbl;
        break;
      case 'marlin':
        gcode = GcodeMarlin;
        break;
      default:
        log.error(LOGPREFIX, `Controller type ${this.options.controllerType} unknown; unable to continue`);
        process.exit(1);
    }
      return new gcode(this);
  }


  //--------------------------------------------------------------------------
  // Our heavy lifter. Every time a new event occurs, look at the totality of
  // the buttons in order to determine what to do. It's not a good idea to
  // respond to individual events that might get out of sync, especially
  // when button combinations are needed. 
  //--------------------------------------------------------------------------
  onUse(id: string, state: GamepadState) {
    const a = state.axisStates || {};  // Use empty object as fallback if undefined
    const b = state.buttonStates || {}; // Use empty object as fallback if undefined
    let ai = new XYZCoords;            // mm to move each axis.

    //------------------------------------------------------------
    // Collect all of the modifier key states. 
    //------------------------------------------------------------

    const deadmanSlow = b.KEYCODE_BUTTON_L1 || b.KEYCODE_BUTTON_R1;
    const deadmanFast = b.KEYCODE_BUTTON_LTRIGGER || b.KEYCODE_BUTTON_RTRIGGER || a.AXIS_LTRIGGER == 1 || a.AXIS_RTRIGGER == 1
    const deadmanZ = deadmanSlow && deadmanFast;
    const deadmanXY = (deadmanSlow || deadmanFast) && !deadmanZ;
    const shiftKey = b.KEYCODE_HOME;
    const shiftKeyOnly = shiftKey && !deadmanSlow && !deadmanFast;
    const deadmanXYOnly = deadmanXY && !shiftKey;
    const deadmanZOnly = deadmanZ && !shiftKey;
    const unmodified = !deadmanSlow && !deadmanFast && !shiftKey;

    //------------------------------------------------------------
    // Determine appropriate jog and creep values for the axes
    // X and Y, determined by the deadman key that's being used.
    // This isn't enabling motion yet, just selecting a speed in
    // case we select motion later.
    //------------------------------------------------------------

    const jogVelocity = deadmanSlow ? VXY_LOW : VXY_MED;
    const creepDist = deadmanSlow ? CXY_LOW : CXY_MED;

    //------------------------------------------------------------
    // Determine appropriate jog and creep values for the Z axis.
    // This is determined by which hat button is used. This isn't
    // enabling motion yet, just selecting a speed in case we 
    // select motion later, so it doesn't matter if the key we're
    // testing is doing something else this round.
    //------------------------------------------------------------

    const jogVelocityZ = a.AXIS_HAT_X ? VZ_LOW : VZ_MED;
    const creepDistZ = a.AXIS_HAT_X ? CZ_LOW : CZ_MED;

    //------------------------------------------------------------
    // Enable/Disable axis movement via the thumb buttons. The 
    // redundant check ensures that we only detect this button 
    // press when the event actually occurs (not when wiggling
    // the stick), and only on down and not up.
    //------------------------------------------------------------

    if (id === 'KEYCODE_BUTTON_THUMBR' && b.KEYCODE_BUTTON_THUMBR) {
      this.thumbRightActive = !this.thumbRightActive;
      this.thumbLeftActive = false;
      log.debug(LOGPREFIX, `Left Thumb Enabled:${this.thumbLeftActive}, Right Thumb Enabled:${this.thumbRightActive}`);
    }
    if (id === 'KEYCODE_BUTTON_THUMBL' && b.KEYCODE_BUTTON_THUMBL) {
      this.thumbLeftActive = !this.thumbLeftActive;
      this.thumbRightActive = false;
      log.debug(LOGPREFIX, `Left Thumb Enabled:${this.thumbLeftActive}, Right Thumb Enabled:${this.thumbRightActive}`);
    }
    // For safety, if the dpad is going to cause movement, disable the sticks.
    if ((deadmanXY || deadmanZ) && (id === 'AXIS_HAT_X' || id === 'AXIS_HAT_Y')) {
      this.thumbLeftActive = false;
      this.thumbRightActive = false;
      log.debug(LOGPREFIX, `Left Thumb Enabled:${this.thumbLeftActive}, Right Thumb Enabled:${this.thumbRightActive}`);
    }

    //--------------------------------------------------
    // Handle X axis movement.
    // Axis values range from -1 to 0 to 1, and so they
    // provide their own vector.
    //--------------------------------------------------

    if (deadmanXYOnly) {
      if (a.AXIS_HAT_X) {
        ai.move_x_axis = a.AXIS_HAT_X * jogVelocity;
      }
      // If the axis was /just/ clicked, instead perform an initial creeper
      // movement, and restart the interval in order to provide a delay.
      if (a.AXIS_HAT_X && id === 'AXIS_HAT_X') {
        clearTimeout(this.jogTimer);
        const d = creepDist * a.AXIS_HAT_X;
        this.jogGantry(d, 0, 0);
        this.jogTimer = setTimeout( this.jogFunction.bind(this), CREEP_INTERVAL );
      }
      if (this.thumbLeftActive && Math.abs(a.AXIS_X) > DEADRANGE) {
        ai.move_x_axis = a.AXIS_X * jogVelocity;
      }
      if (this.thumbRightActive && Math.abs(a.AXIS_RZ) > DEADRANGE) {
        ai.move_x_axis = a.AXIS_RZ * jogVelocity;
      }
    }

    //--------------------------------------------------
    // Handle Y axis movement.
    // Axis values range from -1 to 0 to 1, and so they
    // provide their own vector.
    //--------------------------------------------------

    if (deadmanXYOnly) {
      if (a.AXIS_HAT_Y) {
        ai.move_y_axis = -(a.AXIS_HAT_Y * jogVelocity);
      }
      // If the axis was /just/ clicked, instead perform an initial creeper
      // movement, and restart the interval in order to provide a delay.
      if (a.AXIS_HAT_Y && id === 'AXIS_HAT_Y') {
        clearTimeout(this.jogTimer);
        const d = creepDist * -a.AXIS_HAT_Y;
        this.jogGantry(0, d, 0);
        this.jogTimer = setTimeout( this.jogFunction.bind(this), CREEP_INTERVAL );
      }
      if (this.thumbLeftActive && Math.abs(a.AXIS_Y) > DEADRANGE) {
        ai.move_y_axis = -(a.AXIS_Y * jogVelocity);
      }
      if (this.thumbRightActive && Math.abs(a.AXIS_Z) > DEADRANGE) {
        ai.move_y_axis = -(a.AXIS_Z * jogVelocity);
      }
    }

    //--------------------------------------------------
    // Handle Z axis movement.
    // Axis values range from -1 to 0 to 1, and so they
    // provide their own vector. Because we're using
    // two possibly opposing gamepad axes to control a
    // physical axis, ensure that conflicts are resolved
    // in favor of AXIS_HAT_X.
    //--------------------------------------------------

    if (deadmanZOnly) {
      if (a.AXIS_HAT_X) {
        ai.move_z_axis = (a.AXIS_HAT_X * jogVelocityZ);
      }
      // If the axis was /just/ clicked, instead perform an initial creeper
      // movement, and restart the interval in order to provide a delay.
      if (a.AXIS_HAT_X && id === 'AXIS_HAT_X') {
        clearTimeout(this.jogTimer);
        const d = creepDistZ * a.AXIS_HAT_X;
        this.jogGantry(0, 0, d);
        this.jogTimer = setTimeout( this.jogFunction.bind(this), CREEP_INTERVAL );
      }

      if (a.AXIS_HAT_Y && !a.AXIS_HAT_X) {
        ai.move_z_axis = -(a.AXIS_HAT_Y * jogVelocityZ);
      }
      // If the axis was /just/ clicked, instead perform an initial creeper
      // movement, and restart the interval in order to provide a delay.
      if (a.AXIS_HAT_Y && !a.AXIS_HAT_X && id === 'AXIS_HAT_Y') {
        clearTimeout(this.jogTimer);
        const d = creepDistZ * -a.AXIS_HAT_Y;
        this.jogGantry(0, 0, d);
        this.jogTimer = setTimeout( this.jogFunction.bind(this), CREEP_INTERVAL );
      }
    }

    //==================================================
    // The timer function will pick these up and act 
    // accordingly.
    //==================================================

    this.gamepadState = state;
    this.axisInstructions = ai;

    //==================================================
    // All of the movement is hard-coded; everything
    // else is configured in a settings file. We ship
    // with a built in settings file, but the users can
    // create his or her own.
    //==================================================

    //--------------------------------------------------
    // Turn the modifier condition into a lookup key.
    //--------------------------------------------------
    let condition;

    if (unmodified) condition = "unmodified"
    if (shiftKeyOnly) condition = "shiftKeyOnly"
    if (deadmanXYOnly) condition = "deadmanXYOnly"
    if (deadmanZOnly) condition = "deadmanZOnly"

    //--------------------------------------------------
    // The direction arrows are treated as axes instead
    // of buttons, so let's convert them to button-like
    // values so we can react to them. For other
    // buttons, make sure that we are reacting to
    // button presses rather than modifier presses.
    //--------------------------------------------------
    let trigger;

    if (id === 'AXIS_HAT_X') {
      if (a.AXIS_HAT_X === -1) trigger = 'AXIS_HAT_X_MINUS';
      if (a.AXIS_HAT_X === 1)  trigger = 'AXIS_HAT_X_PLUS';
      if (condition === 'deadmanXYOnly' || condition === 'deadmanZOnly') trigger = null;
    } else if (id === 'AXIS_HAT_Y') {
        if (a.AXIS_HAT_Y === -1) trigger = 'AXIS_HAT_Y_MINUS';
        if (a.AXIS_HAT_Y === 1)  trigger = 'AXIS_HAT_Y_PLUS';
        if (condition === 'deadmanXYOnly' || condition === 'deadmanZOnly') trigger = null;
      } else if (b[id]) {
      trigger = id;
    }

    //--------------------------------------------------
    // Do the work.
    //--------------------------------------------------
    this.performTask(trigger, condition);

  } // onUse()

  
  //--------------------------------------------------------------------------
  // Perform tasks. We were going to do this via introspection, but it's
  // probably dangerous to let a user run abritrary methods. Besides, who
  // doesn't love big giant switch statements?
  //--------------------------------------------------------------------------
  performTask(trigger : string, condition : string) {

    const taskArray = this.options.actionsMap?.[trigger]?.[condition]

    if (taskArray) {

      const task = Array.isArray(taskArray) ? taskArray[0] : taskArray;
      const params = Array.isArray(taskArray) ? taskArray.slice(1) : null;
 

      log.debug(LOGPREFIX, `trigger:${trigger} condition:${condition} task: ${task} params: ${params}`);

      switch(task.toUpperCase()) {
        
        case 'CONTROLLERCYCLESTART': {
          this.gcodeSender.controllerCyclestart();
          break;
        }
        case 'CONTROLLERFEEDHOLD': {
          this.gcodeSender.controllerFeedhold();
          break;
        }
        case 'CONTROLLERPAUSE': {
          this.gcodeSender.controllerPause();
          break;
        }
        case 'CONTROLLERRESET': {
          this.gcodeSender.controllerReset();
          break;
        }
        case 'CONTROLLERRESUME': {
          this.gcodeSender.controllerResume();
          break;
        }
        case 'CONTROLLERSTART': {
          this.gcodeSender.controllerStart();
          break;
        }
        case 'CONTROLLERSTOP': {
          this.gcodeSender.controllerStop();
          break;
        }
        case 'CONTROLLERUNLOCK': {
          this.gcodeSender.controllerUnlock();
          break;
        }
        case 'COOLANTFLOODON': {
          this.gcodeSender.coolantFloodOn();
          break;
        }
        case 'COOLANTMISTON': {
          this.gcodeSender.coolantMistOn();
          break;
        }
        case 'COOLANTOFF': {
          this.gcodeSender.coolantOff();
          break;
        }
        case 'MOVEGANTRYHOME': {
          this.gcodeSender.moveGantryHome();
          break;
        }
        case 'MOVEGANTRYRETURN': {
          this.gcodeSender.moveGantryReturn();
          break;
        }
        case 'MOVEGANTRYWCSHOME': {
          this.gcodeSender.moveGantryWCSHome();
          break;
        }
        case 'MOVEGANTRYZPROBEPOS': {
          this.gcodeSender.moveGantryZProbePos();
          break;
        }
        case 'PERFORMHOMING': {
          this.gcodeSender.performHoming();
          break;
        }
        case 'PERFORMZPROBING': {
          this.gcodeSender.performZProbing();
          break;
        }
        case 'RECORDGANTRYZEROWCSX': {
          this.gcodeSender.recordGantryZeroWCSX();
          break;
        }
        case 'RECORDGANTRYZEROWCSY': {
          this.gcodeSender.recordGantryZeroWCSY();
          break;
        }
        case 'RECORDGANTRYZEROWCSZ': {
          this.gcodeSender.recordGantryZeroWCSZ();
          break;
        }
        case 'RECORDGANTRYHOME': {
          this.gcodeSender.recordGantryHome();
          break;
        }
        case 'RECORDGANTRYRETURN': {
          this.gcodeSender.recordGantryReturn();
          break;
        }
        case 'SPINDLEOFF': {
          this.gcodeSender.spindleOff();
          break;
        }
        case 'SPINDLEON': {
          this.gcodeSender.spindleOn(params[0]);
          break;
        }
        
        default:
          break;
        
      }

      }
  }

  //--------------------------------------------------------------------------
  // We don't have continuous control over motors, so the best that we can
  // do is move them a certain distance for fixed periods of time. We will
  // simulate constant movement by sending new move commands at a fixed
  // frequency, when enabled.
  //--------------------------------------------------------------------------
  jogFunction() {
    const state = this.gamepadState;
    const ai = this.axisInstructions as XYZCoords;

    log.trace(LOGPREFIX, 'jogFunction', `Heartbeat, serialConnected: ${this.connector.serialConnected}`);
    this.jogTimer = setTimeout( this.jogFunction.bind(this), JOG_INTERVAL );

    if ((Object.keys(state).length === 0) || (Object.keys(ai).length === 0))
      return;
    if (ai.move_x_axis === 0 && ai.move_y_axis === 0 && ai.move_z_axis === 0)
      return;

    this.jogGantry(ai.move_x_axis, ai.move_y_axis, ai.move_z_axis);
  }


  //--------------------------------------------------------------------------
  // Move the gantry based on a distance and a computed feedrate that matches
  // a specific amount of time. This is used so that we can keep the movement
  // queue in sync with the joystick update intervals.
  //--------------------------------------------------------------------------
  jogGantry(x: number, y: number, z: number) {
    const dist = Math.sqrt(x * x + y * y + z * z);  // travel distance
    const speed = dist * 60000 / JOG_INTERVAL;      // convert to mm/min
    this.gcodeSender.moveGantryJogToXYZ(x, y, z, speed);
    log.debug(LOGPREFIX, `jogGantry: x=${x}, y=${y}, z=${z}; distance=${dist} at ${speed} mm/min`);
  };

} // class Actions
